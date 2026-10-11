"""Disposable GTK 4 app of complex widgets for tests/e2e/cases/widgets.mjs: a
virtualized 300-item list view (only rows near the viewport exist, as in
real GTK 4 apps) above a "Trap" button, a drop-down, a switch, a check button,
numeric controls, disabled and hidden buttons, and a notebook. Its state is
written to a JSON file so tests check the app itself.
Usage: widgets_gtk4.py STATE_JSON APP_ID TITLE"""
import json
import sys
from pathlib import Path
import gi
from gi.repository import GLib

out, app_id, title = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
GLib.set_prgname(app_id)  # the Wayland app_id of a GTK 4 window without GApplication
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk  # noqa: E402

state = {'selected': None, 'activated': None, 'trap': 0, 'disabledClicks': 0, 'hiddenClicks': 0,
         'generalClicks': 0, 'advancedClicks': 0}
loop = GLib.MainLoop()
window = Gtk.Window(title=title)
window.set_default_size(560, 900)
window.connect('close-request', lambda *_: loop.quit() or False)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
window.set_child(box)


def named(widget, name):
    widget.update_property([Gtk.AccessibleProperty.LABEL], [name])
    return widget


items = Gtk.StringList.new([f'Item {i:03d}' for i in range(300)])
selection = Gtk.SingleSelection.new(items)
selection.set_autoselect(False)
selection.set_can_unselect(True)
selection.set_selected(Gtk.INVALID_LIST_POSITION)
factory = Gtk.SignalListItemFactory()


def setup(_factory, item):
    label = Gtk.Label(xalign=0)
    label.set_size_request(-1, 30)
    item.set_child(label)


factory.connect('setup', setup)
factory.connect('bind', lambda _f, item: item.get_child().set_label(item.get_item().get_string()))
stock = named(Gtk.ListView.new(selection, factory), 'Stock')
scroller = Gtk.ScrolledWindow()
scroller.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
scroller.set_child(stock)
scroller.set_size_request(-1, 240)
box.append(scroller)
trap = Gtk.Button(label='Trap')
trap.set_size_request(-1, 150)
box.append(trap)

controls = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
controls.set_margin_start(12)
controls.set_margin_end(12)
controls.set_margin_top(8)
box.append(controls)
flavor = named(Gtk.DropDown.new_from_strings(['Vanilla', 'Chocolate', 'Strawberry', 'Mint']), 'Flavor')
wifi = named(Gtk.Switch(), 'Wi-Fi')
wifi.set_halign(Gtk.Align.START)
notify = Gtk.CheckButton(label='Notify')
copies = named(Gtk.SpinButton.new_with_range(1, 20, 1), 'Copies')
copies.set_value(2)
brightness = named(Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 100, 1), 'Brightness')
brightness.set_value(50)
sync = named(Gtk.ProgressBar(), 'Sync')
sync.set_fraction(.25)
disabled = Gtk.Button(label='Disabled action')
disabled.set_sensitive(False)
hidden = Gtk.Button(label='Hidden action')
hidden.set_visible(False)
for widget in (flavor, wifi, notify, copies, brightness, sync, disabled, hidden):
    controls.append(widget)
notebook = Gtk.Notebook()
general = Gtk.Button(label='General action')
advanced = Gtk.Button(label='Advanced action')
notebook.append_page(general, Gtk.Label(label='General'))
notebook.append_page(advanced, Gtk.Label(label='Advanced'))
controls.append(notebook)


def rows():
    """Realized list rows: (label, window-relative bounds)."""
    child = stock.get_first_child()
    while child is not None:
        label = child.get_first_child()
        ok, rect = child.compute_bounds(window)
        if ok and isinstance(label, Gtk.Label) and child.get_mapped():
            yield label.get_label(), rect
        child = child.get_next_sibling()


def geometry():
    adjustment = scroller.get_vadjustment()
    ok, view = scroller.compute_bounds(window)
    ok2, span = trap.compute_bounds(window)
    if not (ok and ok2):
        return {}
    realized = list(rows())
    over = [name for name, rect in realized
            if span.get_y() < rect.get_y() + rect.get_height() / 2 < span.get_y() + span.get_height()]
    # Rows with any part in the viewport, in list order.
    shown = sorted(name for name, rect in realized
                   if view.get_y() < rect.get_y() + rect.get_height() and rect.get_y() < view.get_y() + view.get_height())
    return {'scroll': adjustment.get_value(), 'pageSize': adjustment.get_page_size(), 'upper': adjustment.get_upper(),
            'overTrap': over, 'visibleRows': shown, 'realizedRows': [name for name, _ in realized]}


def save(*_):
    position = selection.get_selected()
    item = flavor.get_selected_item()
    state.update(selected=items.get_string(position) if position != Gtk.INVALID_LIST_POSITION else None,
                 flavor=item.get_string() if item else None, wifi=wifi.get_active(), notify=notify.get_active(),
                 copies=copies.get_value(), brightness=brightness.get_value(), tab=notebook.get_current_page(),
                 **geometry())
    out.write_text(json.dumps(state))


def count(key):
    def handler(*_):
        state[key] += 1
        save()
    return handler


def activated(_view, position):
    state['activated'] = items.get_string(position)
    save()


stock.connect('activate', activated)
trap.connect('clicked', count('trap'))
disabled.connect('clicked', count('disabledClicks'))
hidden.connect('clicked', count('hiddenClicks'))
general.connect('clicked', count('generalClicks'))
advanced.connect('clicked', count('advancedClicks'))
selection.connect('notify::selected', save)
flavor.connect('notify::selected', save)
wifi.connect('notify::active', save)
notify.connect('toggled', save)
copies.connect('value-changed', save)
brightness.connect('value-changed', save)
notebook.connect_after('switch-page', lambda *_: GLib.idle_add(save))
# Rows are realized and laid out after scrolling; report them once settled.
scroller.get_vadjustment().connect('value-changed', lambda *_: GLib.timeout_add(50, save))
scroller.get_vadjustment().connect('changed', lambda *_: GLib.timeout_add(50, save))
window.present()
GLib.timeout_add(300, save)
GLib.timeout_add(1000, lambda: save() or True)  # keep geometry current
loop.run()
