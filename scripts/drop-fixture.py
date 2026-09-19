"""Disposable native drop target for live cross-application validation."""
import json
import sys
from pathlib import Path
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk, GLib
GLib.set_prgname('codex-drop-fixture')
output = Path(sys.argv[1])
window = Gtk.Window(title='Codex native drop target')
window.set_default_size(400, 300)
window.connect('destroy', Gtk.main_quit)
label = Gtk.Label(label='Native drop destination')
label.drag_dest_set(Gtk.DestDefaults.ALL, [Gtk.TargetEntry.new('text/plain', 0, 0)], Gdk.DragAction.COPY)
def receive(widget, context, x, y, selection, info, timestamp):
    value = bytes(selection.get_data()).decode('utf-8')
    label.set_text(value)
    output.write_text(json.dumps({'text': value}))
    Gtk.drag_finish(context, True, False, timestamp)
label.connect('drag-data-received', receive)
window.add(label)
window.show_all()
Gtk.main()
