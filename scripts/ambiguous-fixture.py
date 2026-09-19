"""Disposable same-process windows with intentionally identical metadata."""
import gi
gi.require_version('Gtk','3.0')
from gi.repository import Gtk,GLib
GLib.set_prgname('codex-ambiguous-fixture')
windows=[]
for n in range(3):
    window=Gtk.Window(title='Identical fixture');window.set_default_size(300,200)
    entry=Gtk.Entry();entry.set_text('Window '+str(n));entry.get_accessible().set_name('Identity entry')
    window.add(entry);window.show_all();windows.append(window)
Gtk.main()
