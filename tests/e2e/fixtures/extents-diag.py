"""Temporary diagnostic: AT-SPI extents of named elements of a process.
Usage: extents-diag.py PID NAME..."""
import sys
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi

pid, names = int(sys.argv[1]), set(sys.argv[2:])
desktop = Atspi.get_desktop(0)


def walk(obj, depth=0):
    if depth > 40:
        return
    try:
        name, role = obj.get_name(), obj.get_role_name()
    except Exception:
        return
    if name in names:
        out = [role, repr(name)]
        for kind in ('WINDOW', 'SCREEN', 'PARENT'):
            try:
                r = obj.get_extents(getattr(Atspi.CoordType, kind))
                out.append(f'{kind}=({r.x},{r.y},{r.width},{r.height})')
            except Exception as error:
                out.append(f'{kind}=error {error}')
        states = obj.get_state_set()
        out.append(' '.join(s for s in ('showing', 'visible', 'focused') if states.contains(getattr(Atspi.StateType, s.upper()))))
        print(' '.join(out), flush=True)
    for i in range(min(obj.get_child_count(), 300)):
        child = obj.get_child_at_index(i)
        if child is not None:
            walk(child, depth + 1)


for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    if app is not None and app.get_process_id() == pid:
        walk(app)
