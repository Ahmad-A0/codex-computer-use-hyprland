"""Dump a process's raw AT-SPI trees (every state, action, interface, value and
window extent) for widget-test diagnostics; the agent's view hides most of it.
Usage: axdump.py PID OUT_JSON"""
import json
import sys
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi

pid, path = int(sys.argv[1]), sys.argv[2]
Atspi.set_timeout(800, 3000)
budget = [6000]


def walk(obj, depth=0):
    budget[0] -= 1
    if budget[0] < 0 or depth > 40 or obj is None:
        return None
    node = {}
    try:
        node['role'] = obj.get_role_name()
        node['name'] = obj.get_name()
        node['states'] = sorted(s.value_nick for s in obj.get_state_set().get_states())
        node['interfaces'] = obj.get_interfaces()
        if obj.is_action():
            node['actions'] = [obj.get_action_name(i) for i in range(obj.get_n_actions())]
        if obj.is_value():
            node['value'] = [obj.get_minimum_value(), obj.get_current_value(), obj.get_maximum_value()]
        if obj.is_text():
            node['text'] = Atspi.Text.get_text(obj, 0, min(obj.get_character_count(), 200))
        if obj.is_component():
            r = obj.get_extents(Atspi.CoordType.WINDOW)
            node['extents'] = [r.x, r.y, r.width, r.height]
        node['index'] = obj.get_index_in_parent()
        count = obj.get_child_count()
        node['children'] = [c for c in (walk(obj.get_child_at_index(i), depth + 1) for i in range(min(count, 600))) if c]
        if count > 600:
            node['more'] = count - 600
    except Exception as error:  # Diagnostics must never fail the run.
        node['error'] = str(error)
    return node


desktop = Atspi.get_desktop(0)
found = []
for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    if app is not None and app.get_process_id() == pid:
        found.append(walk(app))
with open(path, 'w') as file:
    json.dump(found, file, indent=1)
