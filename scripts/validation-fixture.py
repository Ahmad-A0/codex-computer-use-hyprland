"""Disposable native GTK app for end-to-end API conformance tests."""
import json
from pathlib import Path
import sys

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib

GLib.set_prgname("codex-hyprland-fixture")

output = Path(sys.argv[1])
state = {"clicks": 0, "text": "", "scroll": 0, "drag": 0, "right": 0, "activations": 0, "keys": []}

def save():
    output.write_text(json.dumps(state))

window = Gtk.Window(title="Codex Hyprland Test Fixture")
window.set_wmclass("codex-hyprland-fixture", "codex-hyprland-fixture")
window.set_default_size(620, 560)
window.connect("destroy", Gtk.main_quit)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
box.set_border_width(16)
window.add(box)
entry = Gtk.Entry()
entry.get_accessible().set_name("Test entry")
entry.connect("changed", lambda widget: (state.update(text=widget.get_text()), save()))
entry.connect("activate", lambda *_: (state.update(activations=state['activations'] + 1), save()))
entry.connect("key-press-event", lambda widget, event: (state["keys"].append([Gdk.keyval_name(event.keyval), int(event.state)]), save(), False)[-1])
box.pack_start(entry, False, False, 0)
button = Gtk.Button(label="Test button")
button.connect("clicked", lambda *_: (state.update(clicks=state["clicks"] + 1), save()))
box.pack_start(button, False, False, 0)
area = Gtk.DrawingArea()
area.set_size_request(500, 350)
area.get_accessible().set_name("Gesture surface")
area.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK | Gdk.EventMask.POINTER_MOTION_MASK | Gdk.EventMask.SCROLL_MASK | Gdk.EventMask.SMOOTH_SCROLL_MASK)
held = False

def press(widget, event):
    global held
    if event.button == 1:
        held = True
    if event.button == 3:
        state['right'] += 1
        save()
    return True

def release(widget, event):
    global held
    held = False
    return True

def move(widget, event):
    if held:
        state['drag'] += 1
        save()
    return True

def scroll(widget, event):
    state['scroll'] += 1
    save()
    return True

area.connect('button-press-event', press)
area.connect('button-release-event', release)
area.connect('motion-notify-event', move)
area.connect('scroll-event', scroll)
box.pack_start(area, True, True, 0)
window.show_all()
save()
Gtk.main()
