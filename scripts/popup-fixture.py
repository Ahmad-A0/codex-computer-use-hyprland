"""Disposable popup menu for live keyboard, pointer, and capture validation."""
import json,sys
from pathlib import Path
import gi
gi.require_version('Gtk','3.0')
from gi.repository import Gtk,GLib
GLib.set_prgname('codex-popup-fixture')
w=Gtk.Window(title='Codex popup fixture');w.set_default_size(300,200)
box=Gtk.Box(orientation=Gtk.Orientation.VERTICAL);w.add(box)
entry=Gtk.Entry();entry.get_accessible().set_name('Popup text');box.pack_start(entry,False,False,0)
button=Gtk.MenuButton(label='Open fixture menu');box.pack_end(button,False,False,0)
menu=Gtk.Menu()
for i in range(5):
    item=Gtk.MenuItem(label=f'Popup item {i}: a wide menu extending outside its parent')
    item.connect('activate',lambda widget,n=i:Path(sys.argv[1]).write_text(json.dumps({'selected':n})))
    menu.append(item)
menu.show_all();button.set_popup(menu)
w.show_all();Gtk.main()
