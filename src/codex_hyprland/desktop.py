"""Small local Hyprland transport and key parser; no desktop automation package."""
import json
import subprocess

LUA = 'lua'


def _run(*args):
    result = subprocess.run(['hyprctl', *args], capture_output=True, text=True, timeout=5)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return result.stdout.strip()


def query(command):
    return json.loads(_run('-j', command))


def cursor_pos():
    value = query('cursorpos')
    return value['x'], value['y']


def provider():
    return query('status').get('configProvider', 'hyprlang')


def lua_str(value):
    return '"' + ''.join(chr(b) if 32 <= b < 127 and b not in (34, 92)
                         else f'\\{b:03d}' for b in value.encode('utf-8')) + '"'


def dispatch(command, *args):
    result = _run('dispatch', command, *args)
    if result != 'ok':
        raise RuntimeError(result)


def focus_window(address):
    if provider() == LUA:
        dispatch('hl.dsp.focus({window=' + lua_str('address:' + address) + '})')
    else:
        dispatch('focuswindow', 'address:' + address)


def parse_combo(value):
    # macOS habits: Command shortcuts (cmd+c, cmd+v) mean Ctrl here, and Option is Alt.
    aliases = {'control': 'ctrl', 'super': 'logo', 'meta': 'logo', 'win': 'logo',
               'cmd': 'ctrl', 'command': 'ctrl', 'option': 'alt', 'opt': 'alt'}
    keys = {'enter': 'Return', 'return': 'Return', 'esc': 'Escape', 'escape': 'Escape',
            'tab': 'Tab', 'space': 'space', 'backspace': 'BackSpace', 'delete': 'Delete',
            'del': 'Delete', 'insert': 'Insert', 'home': 'Home', 'end': 'End',
            'pgup': 'Page_Up', 'pageup': 'Page_Up', 'pgdn': 'Page_Down',
            'pagedown': 'Page_Down', 'up': 'Up', 'down': 'Down', 'left': 'Left', 'right': 'Right'}
    parts = [part.strip() for part in value.split('+') if part.strip()]
    if not parts:
        raise ValueError('Empty key combination')
    modifiers = []
    for index, part in enumerate(parts):
        key = aliases.get(part.lower(), part.lower())
        if key in ('ctrl', 'shift', 'alt', 'logo', 'altgr'):
            modifiers.append(key)
        elif index != len(parts) - 1:
            raise ValueError('Unknown modifier: ' + part)
        else:
            symbol = keys.get(key, part.upper() if key.startswith('f') and key[1:].isdigit() else part)
            return modifiers, symbol
    return modifiers, None


def capture():
    monitors = query('monitors')
    if not monitors:
        raise RuntimeError('No output is available')
    monitor = next((m for m in monitors if m.get('focused')), monitors[0])
    width, height = monitor['width'], monitor['height']
    if int(monitor.get('transform', 0)) % 2:
        width, height = height, width
    scale = monitor.get('scale', 1)
    geometry = [monitor['x'], monitor['y'], round(width / scale), round(height / scale)]
    data = subprocess.run(['grim', '-o', monitor['name'], '-s', '1', '-t', 'png', '-'],
                          check=True, capture_output=True, timeout=15).stdout
    return data, {'geometry': geometry}
