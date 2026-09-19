"""Desktop-entry launch within Hyprland's no-initial-focus exec rule."""
import sys
import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio

if __name__ == '__main__':
    app = Gio.DesktopAppInfo.new(sys.argv[1])
    if app is None or not app.launch([], None):
        raise SystemExit('Desktop application launch failed')
