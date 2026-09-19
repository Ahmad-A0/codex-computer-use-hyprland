"""Disposable live application for exercising accessibility and clipboard operations."""
import json,sys
from pathlib import Path
import gi
gi.require_version('Gtk','3.0')
from gi.repository import Gtk,GLib
GLib.set_prgname('codex-parity-fixture')
out=Path(sys.argv[1]);state={}
w=Gtk.Window(title='Codex Parity Fixture');w.set_default_size(640,700)
w.connect('destroy',Gtk.main_quit)
box=Gtk.Box(orientation=Gtk.Orientation.VERTICAL,spacing=12);box.set_border_width(20);w.add(box)
entry=Gtk.Entry();entry.get_accessible().set_name('Parity entry');box.pack_start(entry,False,False,0)
scale=Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL,0,100,1);scale.get_accessible().set_name('Parity slider');box.pack_start(scale,False,False,0)
scroll=Gtk.ScrolledWindow();scroll.get_accessible().set_name('Parity viewport');box.pack_start(scroll,True,True,0)
view=Gtk.TextView();view.get_accessible().set_name('Parity document');scroll.add(view)
view.get_buffer().set_text('\n'.join(f'Line {i}: editable document' for i in range(150)))
def save(*_):
 b=view.get_buffer();sel=entry.get_selection_bounds()
 state.update(text=entry.get_text(),selection=list(sel),caret=entry.get_position(),value=scale.get_value(),document=b.get_text(b.get_start_iter(),b.get_end_iter(),True),scroll=scroll.get_vadjustment().get_value())
 out.write_text(json.dumps(state))
entry.connect('changed',save);entry.connect('notify::cursor-position',save);entry.connect('notify::selection-bound',save)
scale.connect('value-changed',save);view.get_buffer().connect('changed',save);scroll.get_vadjustment().connect('value-changed',save)
w.show_all();save();Gtk.main()
