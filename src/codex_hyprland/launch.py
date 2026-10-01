"""Desktop-entry launch within Hyprland's no-initial-focus exec rule."""
import sys
import json
from pathlib import Path
import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio

if __name__ == '__main__':
    try:
        app = Gio.DesktopAppInfo.new(sys.argv[1])
        if app is None or not app.launch([], None):
            raise RuntimeError('Desktop application launch failed')
        result = {'ok': True}
    except Exception as error:
        result = {'ok': False, 'error': str(error)}
    if len(sys.argv) > 2:
        status = Path(sys.argv[2])
        temporary = status.with_suffix('.tmp')
        temporary.write_text(json.dumps(result))
        temporary.replace(status)
    if not result['ok']:
        raise SystemExit(result['error'])
