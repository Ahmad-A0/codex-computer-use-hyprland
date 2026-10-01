"""Provider-owned input guards, retaining legacy environment settings on upgrade."""
import os
from pathlib import Path
from . import desktop


def setting(name, default=''):
    return os.environ.get('CODEX_HYPRLAND_' + name, os.environ.get('HYPRUSE_' + name, default))


def enabled(name, default=''):
    return setting(name, default).lower() not in ('', '0', 'false', 'no', 'off')


def lock_path():
    directory = Path(os.environ['XDG_RUNTIME_DIR']) / 'codex-hyprland'
    directory.mkdir(mode=0o700, exist_ok=True)
    return directory / 'seat.lock'


# System authentication dialogs: never driven, like macOS's forbidden apps.
AUTH_CLASSES = {'hyprpolkitagent', 'polkit-gnome-authentication-agent-1',
                'org.kde.polkit-kde-authentication-agent-1', 'polkit-mate-authentication-agent-1',
                'lxpolkit', 'lxqt-policykit-agent', 'xfce-polkit', 'gcr-prompter', 'org.gnome.keyring.prompt'}


def protected(names):
    return enabled('AUTH_GUARD', '1') and any(n.lower() in AUTH_CLASSES for n in names if n)


class Guards:
    def __init__(self, accessibility):
        self.ax = accessibility
        self.previous = None
        self.launched = set()

    def guard_client(self, client):
        scope = setting('CONFINE').strip()
        if not scope:
            return
        kind, separator, rest = scope.partition(':')
        values = {v.strip() for v in rest.split(',') if v.strip()}
        if scope == 'launched':
            allowed = client['address'] in self.launched
        elif separator and values and kind == 'class':
            allowed = client.get('class') in values
        elif separator and values and kind == 'workspace':
            workspace = client.get('workspace') or {}
            allowed = str(workspace.get('id')) in values or workspace.get('name') in values
        else:
            raise RuntimeError('Invalid confinement setting')
        if not allowed:
            raise RuntimeError('Target is outside the configured confinement scope')

    def guard_auth_client(self, client, allow_auth=False):
        if not allow_auth and protected({client.get('class', '')}):
            raise RuntimeError('Input to a system authentication dialog is refused')

    def guard_password_field(self, client, allow_auth=False):
        if allow_auth or setting('AUTH_GUARD', '1').lower() not in ('strict', '2', 'field', 'fields'):
            return
        self.ax.snapshot(client)
        for obj, role, _ in self.ax.elements.get(client['address'], {}).values():
            if role == 'password text' and obj.get_state_set().contains(self.ax.api.StateType.FOCUSED):
                raise RuntimeError('Typing into a password field is refused in strict authentication mode')

    def guard_session_lock(self, window_given=True, allow_auth=False):
        for path in Path('/proc').glob('[0-9]*/comm'):
            try:
                name = path.read_text().strip()
            except OSError:
                continue
            if name in ('hyprlock', 'swaylock', 'gtklock', 'waylock'):
                raise RuntimeError('Session is locked; unlock it before computer use')

    def guard_keyboard_layer(self, window_given=True, allow_auth=False):
        # Window-bound input reaches its app directly, as on macOS, whatever
        # layer holds keyboard focus. Only desktop input would land in a launcher.
        if window_given:
            return
        def visit(value):
            if isinstance(value, dict):
                namespace = str(value.get('namespace', '')).lower()
                if namespace.startswith(('wofi', 'rofi', 'fuzzel', 'tofi', 'anyrun', 'walker', 'launcher', 'hyprlock', 'swaylock', 'lockscreen')):
                    raise RuntimeError('A launcher or lock layer is present; dismiss it before computer use')
                for child in value.values():
                    visit(child)
            elif isinstance(value, list):
                for child in value:
                    visit(child)
        visit(desktop.query('layers'))

    def seat_state(self):
        return desktop.cursor_pos(), (desktop.query('activewindow') or {}).get('address')

    def guard_seat(self):
        if enabled('STRICT') and self.previous is not None and self.seat_state() != self.previous:
            raise RuntimeError('The physical seat changed since the previous action')

    def remember_seat(self):
        if enabled('STRICT'):
            self.previous = self.seat_state()
