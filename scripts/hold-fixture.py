"""Disposable GTK app recording keys, modifiers and button timing for held-input tests."""
import json
from pathlib import Path
import sys
import time

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib

GLib.set_prgname("codex-hold-fixture")
output = Path(sys.argv[1])
state = {"keys": [], "buttons": [], "scrolls": [], "motions": [], "first": "", "second": ""}
MODS = {"shift": Gdk.ModifierType.SHIFT_MASK, "ctrl": Gdk.ModifierType.CONTROL_MASK, "alt": Gdk.ModifierType.MOD1_MASK}


def mods(event):
    return [name for name, mask in MODS.items() if event.state & mask]


def save():
    output.write_text(json.dumps(state))


def key(widget, event, kind):
    state["keys"].append([kind, Gdk.keyval_name(event.keyval), mods(event), time.monotonic()])
    save()
    return False


def button(widget, event, kind):
    state["buttons"].append([kind, event.button, mods(event), time.monotonic(), event.x, event.y])
    save()
    return True


window = Gtk.Window(title="Codex Hold Fixture")
window.set_default_size(560, 520)
window.connect("destroy", Gtk.main_quit)
window.connect("key-press-event", key, "press")
window.connect("key-release-event", key, "release")
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
box.set_border_width(16)
window.add(box)
for name in ("first", "second"):
    entry = Gtk.Entry()
    entry.get_accessible().set_name(name.title() + " entry")
    entry.connect("changed", lambda widget, name=name: (state.update({name: widget.get_text()}), save()))
    box.pack_start(entry, False, False, 0)
area = Gtk.DrawingArea()
area.set_size_request(500, 360)
area.get_accessible().set_name("Gesture surface")
area.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK | Gdk.EventMask.POINTER_MOTION_MASK
                | Gdk.EventMask.SCROLL_MASK | Gdk.EventMask.SMOOTH_SCROLL_MASK)
area.connect("button-press-event", button, "press")
area.connect("button-release-event", button, "release")
area.connect("scroll-event", lambda w, e: (state["scrolls"].append(mods(e)), save(), True)[-1])
area.connect("motion-notify-event", lambda w, e: (state["motions"].append([mods(e), bool(e.state & Gdk.ModifierType.BUTTON1_MASK), e.x, e.y]), save(), True)[-1])
box.pack_start(area, True, True, 0)
window.show_all()
save()
Gtk.main()
