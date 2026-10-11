"""Disposable GTK 3 app of complex widgets for tests/e2e/cases/widgets.mjs.
A notebook holds: a long list with an editable column directly above a tall
"Trap" button (rows scrolled out of the list lie over it); an expandable tree;
and toggles, a radio group, a switch, a combo box, numeric controls and
disabled and hidden buttons. Its state, including the list's scroll geometry,
is written to a JSON file so tests check the app itself.
Usage: widgets_gtk3.py STATE_JSON APP_ID TITLE   (GDK_BACKEND=x11 for XWayland)"""
import json
import sys
from pathlib import Path
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, GLib

out, app_id, title = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
GLib.set_prgname(app_id)
state = {'page': 0, 'selected': None, 'activated': None, 'trap': 0, 'qty': {}, 'listAction': 0,
         'treeSelected': None, 'treeActivated': None, 'expanded': [],
         'disabledClicks': 0, 'hiddenClicks': 0, 'revealed': False}
window = Gtk.Window(title=title)
window.set_wmclass(app_id, app_id)
window.set_default_size(560, 760)
window.connect('destroy', Gtk.main_quit)
notebook = Gtk.Notebook()
window.add(notebook)


def named(widget, name):
    widget.get_accessible().set_name(name)
    return widget


def page(label):
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
    notebook.append_page(box, Gtk.Label(label=label))
    return box


# List: 200 rows of fixed height in a 240 px viewport, and a Trap button
# directly below it, so a row scrolled out of the bottom lies over the Trap.
listing = page('List')
store = Gtk.ListStore(str, int)
for i in range(200):
    store.append([f'Row {i:03d}', (i * 7) % 50])
inventory = named(Gtk.TreeView(model=store), 'Inventory')
inventory.set_headers_visible(False)
name_cell = Gtk.CellRendererText()
name_cell.set_fixed_size(-1, 30)
name_column = Gtk.TreeViewColumn('Name', name_cell, text=0)
name_column.set_expand(True)
qty_cell = Gtk.CellRendererText(editable=True)
qty_cell.set_fixed_size(-1, 30)
inventory.append_column(name_column)
inventory.append_column(Gtk.TreeViewColumn('Qty', qty_cell, text=1))
scroller = Gtk.ScrolledWindow()
scroller.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
scroller.set_size_request(-1, 240)
scroller.add(inventory)
listing.pack_start(scroller, False, False, 0)
trap = Gtk.Button(label='Trap')
trap.set_size_request(-1, 200)
listing.pack_start(trap, False, False, 0)
list_action = Gtk.Button(label='List page action')
listing.pack_start(list_action, False, False, 8)

# Tree: nested, collapsed nodes.
catalog_store = Gtk.TreeStore(str)


def add(parent, name, children=()):
    node = catalog_store.append(parent, [name])
    for child in children:
        add(node, *child)


for item in (('Fruits', (('Citrus', (('Lemon',), ('Lime',), ('Orange',))), ('Apple',))),
             ('Vegetables', (('Carrot',), ('Leek',))), ('Grains',)):
    add(None, *item)
catalog = named(Gtk.TreeView(model=catalog_store), 'Catalog')
catalog.append_column(Gtk.TreeViewColumn('Item', Gtk.CellRendererText(), text=0))
tree_page = page('Tree')
tree_page.pack_start(catalog, True, True, 0)

# Controls.
controls = page('Controls')
controls.set_spacing(6)
controls.set_border_width(12)
subscribe = Gtk.CheckButton(label='Subscribe')
small = Gtk.RadioButton.new_with_label(None, 'Small')
medium = Gtk.RadioButton.new_with_label_from_widget(small, 'Medium')
large = Gtk.RadioButton.new_with_label_from_widget(small, 'Large')
bold = Gtk.ToggleButton(label='Bold')
airplane = named(Gtk.Switch(), 'Airplane mode')
airplane.set_halign(Gtk.Align.START)
disabled = Gtk.Button(label='Disabled action')
disabled.set_sensitive(False)
hidden = Gtk.Button(label='Hidden action')
hidden.set_no_show_all(True)
reveal = Gtk.Button(label='Reveal')
combo = named(Gtk.ComboBoxText(), 'Size preset')
for name in ('Alpha', 'Beta', 'Gamma', 'Delta'):
    combo.append_text(name)
combo.set_active(0)
spin = named(Gtk.SpinButton.new_with_range(0, 100, 1), 'Quantity')
spin.set_value(5)
volume = named(Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 100, 1), 'Volume')
volume.set_value(20)
progress = named(Gtk.ProgressBar(), 'Upload')
progress.set_fraction(0.6)
for widget in (subscribe, small, medium, large, bold, airplane, disabled, hidden, reveal, combo, spin, volume, progress):
    controls.pack_start(widget, False, False, 0)


def path_names(model, path):
    names = []
    for depth in range(1, path.get_depth() + 1):
        names.append(model[Gtk.TreePath.new_from_indices(path.get_indices()[:depth])][0])
    return '/'.join(names)


def expanded_rows():
    rows = []
    catalog_store.foreach(lambda model, path, _: rows.append(model[path][0]) if catalog.row_expanded(path) else None)
    return rows


def geometry():
    """The list viewport, the Trap, and which rows' centres lie over the Trap."""
    top = scroller.translate_coordinates(window, 0, 0)
    trap_top = trap.translate_coordinates(window, 0, 0)
    adjustment = scroller.get_vadjustment()
    area = inventory.get_background_area(Gtk.TreePath.new_first(), name_column)
    if top is None or trap_top is None or area.height <= 0:
        return {}
    height = area.height
    span = [trap_top[1], trap_top[1] + trap.get_allocated_height()]
    over = [store[i][0] for i in range(len(store))
            if span[0] < top[1] + (i + .5) * height - adjustment.get_value() < span[1]]
    return {'listTop': top[1], 'listHeight': scroller.get_allocated_height(), 'rowHeight': height,
            'scroll': adjustment.get_value(), 'pageSize': adjustment.get_page_size(),
            'upper': adjustment.get_upper(), 'trapSpan': span, 'overTrap': over}


def save(*_):
    model, it = inventory.get_selection().get_selected()
    tree_model, tree_it = catalog.get_selection().get_selected()
    size = next((b.get_label() for b in (small, medium, large) if b.get_active()), None)
    state.update(page=notebook.get_current_page(), selected=model[it][0] if it else None,
                 treeSelected=path_names(tree_model, tree_model.get_path(tree_it)) if tree_it else None,
                 expanded=expanded_rows(), subscribe=subscribe.get_active(), subscribeEnabled=subscribe.get_sensitive(),
                 size=size, bold=bold.get_active(), airplane=airplane.get_active(), combo=combo.get_active_text(),
                 spin=spin.get_value(), spinText=spin.get_text(), volume=volume.get_value(),
                 **geometry())
    out.write_text(json.dumps(state))


def count(key):
    def handler(*_):
        state[key] += 1
        save()
    return handler


def activated(view, path, _column):
    if view is inventory:
        state['activated'] = store[path][0]
    else:
        state['treeActivated'] = path_names(catalog_store, path)
    save()


def edited(_cell, path, text):
    try:
        store[path][1] = int(text)
    except ValueError:
        return
    state['qty'][store[path][0]] = int(text)
    save()


def revealed(*_):
    hidden.show()
    subscribe.set_sensitive(False)
    state['revealed'] = True
    save()


trap.connect('clicked', count('trap'))
list_action.connect('clicked', count('listAction'))
disabled.connect('clicked', count('disabledClicks'))
hidden.connect('clicked', count('hiddenClicks'))
reveal.connect('clicked', revealed)
inventory.connect('row-activated', activated)
catalog.connect('row-activated', activated)
qty_cell.connect('edited', edited)
for selection in (inventory.get_selection(), catalog.get_selection()):
    selection.connect('changed', save)
catalog.connect('row-expanded', save)
catalog.connect('row-collapsed', save)
notebook.connect_after('switch-page', lambda *_: GLib.idle_add(save))
scroller.get_vadjustment().connect('value-changed', save)
scroller.get_vadjustment().connect('changed', save)
for widget, signal in ((subscribe, 'toggled'), (small, 'toggled'), (medium, 'toggled'), (large, 'toggled'), (bold, 'toggled'), (airplane, 'notify::active'),
                       (combo, 'changed'), (spin, 'value-changed'), (spin, 'changed'), (volume, 'value-changed')):
    widget.connect(signal, save)
window.connect('size-allocate', lambda *_: GLib.idle_add(save))
window.show_all()
save()
Gtk.main()
