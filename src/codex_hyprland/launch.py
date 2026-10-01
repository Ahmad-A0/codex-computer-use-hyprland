"""Desktop-entry launch within Hyprland's exec rule (workspace, no initial focus).

Hyprland applies an exec rule to a window whose process environment carries its
token, or whose PID is the process it spawned. Chromium-based apps overwrite
their environment, so this process replaces itself with the app to keep the PID.
Entries needing GLib's launcher (terminal, D-Bus activation) still use it.

The exec rule only places the app's first window. The launched process is also
registered with the compositor module, and marked in its environment, so that
the windows it opens later follow it to its workspace without focus.
"""
import os
import re
import shlex
import shutil
import subprocess
import sys
import json
from pathlib import Path
import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib


def report(result):
    if len(sys.argv) > 2:
        status = Path(sys.argv[2])
        temporary = status.with_suffix('.tmp')
        temporary.write_text(json.dumps(result))
        temporary.replace(status)


def register(pid):
    """Tell the compositor module where this launch belongs (best effort: without
    the module the exec rule still places the first window)."""
    workspace = os.environ.get('CODEX_HYPRLAND_PLACEMENT', '')
    request = json.dumps({'op': 'launched', 'pid': pid, 'workspace': '' if workspace == 'current' else workspace})
    try:
        subprocess.run(['hyprctl', 'codex-background', request], capture_output=True, timeout=3)
    except (OSError, subprocess.SubprocessError):
        pass


def chromium_based(program, depth=0):
    """Whether a program is Chromium or Electron, following wrapper scripts and launchers.
    Their bundles always ship icudtl.dat next to the real binary."""
    found = shutil.which(program)
    if not found or depth > 3:
        return False
    path = Path(found).resolve()
    # The binary's directory, or a bundle that keeps its launcher in bin/.
    if any((d / 'icudtl.dat').is_file() for d in (path.parent, path.parent.parent)):
        return True
    try:
        with path.open('rb') as file:
            head = file.read(262144)
    except OSError:
        return False
    # Wrapper scripts, or small compiled launchers such as Arch's chromium-launcher.
    if not head.startswith(b'#!') and path.stat().st_size > len(head):
        return False
    targets = re.findall(rb'(/[\w.+@-]+(?:/[\w.+@-]+)+)', head)
    return any(chromium_based(target.decode(), depth + 1) for target in dict.fromkeys(targets)
               if Path(target.decode()).is_file())


def command(app):
    """The entry's Exec line without file arguments, per the desktop-entry spec."""
    expanded = []
    for word in shlex.split(app.get_commandline() or ''):
        if word in ('%f', '%F', '%u', '%U'):
            continue
        if word == '%i':
            icon = app.get_string('Icon')
            expanded += ['--icon', icon] if icon else []
            continue
        word = (word.replace('%c', app.get_name()).replace('%k', app.get_filename() or '')
                .replace('%%', '\0').replace('%d', '').replace('%D', '').replace('%n', '')
                .replace('%N', '').replace('%v', '').replace('%m', '').replace('\0', '%'))
        expanded.append(word)
    return expanded


if __name__ == '__main__':
    try:
        app = Gio.DesktopAppInfo.new(sys.argv[1])
        if app is None:
            raise RuntimeError('Desktop application not found')
        argv = command(app)
        if app.get_boolean('DBusActivatable') or not argv:
            if not app.launch([], None):
                raise RuntimeError('Desktop application launch failed')
            report({'ok': True})
        elif app.get_boolean('Terminal'):
            launched = []
            if not app.launch_uris_as_manager([], None, GLib.SpawnFlags.SEARCH_PATH, None, None,
                                              lambda _app, pid, *_: launched.append(pid), None):
                raise RuntimeError('Desktop application launch failed')
            for pid in launched:
                register(pid)
            report({'ok': True})
        else:
            if not shutil.which(argv[0]):
                raise RuntimeError(f'Program not found: {argv[0]}')
            # Chromium and Electron expose their UI over AT-SPI only with this
            # switch; macOS apps answer accessibility clients without one.
            if chromium_based(argv[0]) and '--force-renderer-accessibility' not in argv:
                argv.insert(1, '--force-renderer-accessibility')
            directory = app.get_string('Path')
            if directory:
                os.chdir(directory)
            register(os.getpid())
            report({'ok': True})
            os.execvp(argv[0], argv)
    except Exception as error:
        report({'ok': False, 'error': str(error)})
        raise SystemExit(str(error))
