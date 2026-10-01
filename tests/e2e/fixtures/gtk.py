"""Disposable GTK 3 app: entry, buttons, slider, a long document and a dialog.
Its state (including every key it received) is written to a JSON file so tests
check the app itself, not just observations.
Usage: gtk.py STATE_JSON APP_ID [TITLE]   ("{pid}" in STATE_JSON is replaced;
run with GDK_BACKEND=x11 for XWayland)."""
import json
import os
import sys
from pathlib import Path
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk, GLib

out = Path(sys.argv[1].replace('{pid}', str(os.getpid())))
app_id = sys.argv[2]
title = sys.argv[3] if len(sys.argv) > 3 else 'Codex E2E GTK'
GLib.set_prgname(app_id)
state = {'clicks': 0, 'keys': [], 'dialog': None, 'dialogs': 0}
window = Gtk.Window(title=title)
window.set_wmclass(app_id, app_id)
window.set_default_size(640, 720)
window.connect('destroy', Gtk.main_quit)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
box.set_border_width(20)
window.add(box)
entry = Gtk.Entry()
entry.get_accessible().set_name('E2E entry')
box.pack_start(entry, False, False, 0)
button = Gtk.Button(label='E2E button')
box.pack_start(button, False, False, 0)
opener = Gtk.Button(label='Open dialog')
box.pack_start(opener, False, False, 0)
scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 100, 1)
scale.get_accessible().set_name('E2E slider')
box.pack_start(scale, False, False, 0)
scroll = Gtk.ScrolledWindow()
scroll.get_accessible().set_name('E2E viewport')
box.pack_start(scroll, True, True, 0)
view = Gtk.TextView()
view.get_accessible().set_name('E2E document')
scroll.add(view)
view.get_buffer().set_text('\n'.join(f'Line {i}: editable document' for i in range(150)))


def save(*_):
    document = view.get_buffer()
    state.update(text=entry.get_text(), selection=list(entry.get_selection_bounds()),
                 value=scale.get_value(), scroll=scroll.get_vadjustment().get_value(),
                 document=document.get_text(document.get_start_iter(), document.get_end_iter(), True))
    out.write_text(json.dumps(state))


def clicked(*_):
    state['clicks'] += 1
    save()


def key(_, event):
    state['keys'].append(Gdk.keyval_name(event.keyval))
    save()
    return False


def open_dialog(*_):
    # A separate toplevel owned by this app, as a Save or Preferences dialog is.
    dialog = Gtk.Dialog(title='Codex E2E Dialog', transient_for=window)
    field = Gtk.Entry()
    field.get_accessible().set_name('Dialog entry')
    dialog.get_content_area().pack_start(field, False, False, 12)
    dialog.add_button('Dialog OK', Gtk.ResponseType.OK)

    def respond(_, response):
        if response == Gtk.ResponseType.OK:
            state['dialog'] = field.get_text()
        dialog.destroy()
        save()

    dialog.connect('response', respond)
    dialog.show_all()
    state['dialogs'] += 1
    save()


entry.connect('changed', save)
entry.connect('notify::cursor-position', save)
entry.connect('notify::selection-bound', save)
window.connect('key-press-event', key)
button.connect('clicked', clicked)
opener.connect('clicked', open_dialog)
scale.connect('value-changed', save)
view.get_buffer().connect('changed', save)
scroll.get_vadjustment().connect('value-changed', save)
window.show_all()
save()
Gtk.main()
