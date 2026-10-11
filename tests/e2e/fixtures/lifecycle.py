"""Disposable GTK 3 app for window, dialog and app lifecycle tests.
Its state is written (atomically) to a JSON file so tests check the app itself.
Usage: lifecycle.py STATE_JSON APP_ID TITLE MODE   ("{pid}" in STATE_JSON is
replaced; run with GDK_BACKEND=x11 for XWayland). Modes:
  dialogs  nested modal dialogs, file choosers, extra identical toplevels, a
           window that closes when it loses focus; typing "crash now" kills it
  layout   corner buttons for resizing, and layout changes the app makes on its
           own (SIGUSR1 inserts a banner, SIGUSR2 replaces a button)
  targets  solid-colour click targets that record where they were pressed, a
           custom tooltip and two popovers (in-window and separate surface)
"""
import json
import os
import signal
import sys
from pathlib import Path
import gi
gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
from gi.repository import Gtk, Gdk, GLib

out = Path(sys.argv[1].replace('{pid}', str(os.getpid())))
app_id, title, mode = sys.argv[2], sys.argv[3], sys.argv[4]
GLib.set_prgname(app_id)
state = {'pid': os.getpid(), 'mode': mode, 'events': []}

css = Gtk.CssProvider()
css.load_from_data(b'''
.solid { background-image: none; border: none; box-shadow: none; border-radius: 0; text-shadow: none; }
.magenta { background-color: #ff00ff; }
.cyan { background-color: #00ffff; }
.tip { background-color: #ffff00; padding: 0; min-width: 0; min-height: 0; }
.orange { background-color: #ff8000; }
.banner { background-color: #2040a0; }
''')
Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)


def save():
    temporary = out.with_name(out.name + '.tmp')
    temporary.write_text(json.dumps(state))
    temporary.replace(out)


def event(*items):
    state['events'].append(list(items))
    save()


def named(widget, name):
    widget.get_accessible().set_name(name)
    return widget


def entry(name, key=None):
    field = named(Gtk.Entry(), name)
    if key:
        field.connect('changed', lambda f: (state.__setitem__(key, f.get_text()), save()))
    return field


def button(label, handler, *classes):
    widget = Gtk.Button(label=label)
    for name in classes:
        widget.get_style_context().add_class(name)
    widget.connect('clicked', lambda *_: handler())
    return widget


def column(*children, border=16):
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
    box.set_border_width(border)
    for child in children:
        box.pack_start(child, False, False, 0)
    return box


window = Gtk.Window(title=title)
window.set_wmclass(app_id, app_id)
window.connect('destroy', Gtk.main_quit)


# --- dialogs ---------------------------------------------------------------

def open_outer():
    """A modal dialog whose own button opens a second modal dialog."""
    outer = Gtk.Dialog(title='Codex E2E Life Outer', transient_for=window, modal=True)
    outer.set_default_size(420, 260)
    status = named(Gtk.Label(label='Outer status: none'), 'Outer status')
    field = entry('Outer entry')
    box = outer.get_content_area()
    for child in (field, status, button('Open nested', lambda: open_inner(outer, status))):
        box.pack_start(child, False, False, 6)
    outer.add_button('Outer OK', Gtk.ResponseType.OK)

    def respond(_, response):
        if response == Gtk.ResponseType.OK:
            state['outer'] = f"{field.get_text()}|{state.get('inner')}"
        outer.destroy()
        event('outer-closed', response == Gtk.ResponseType.OK)

    outer.connect('response', respond)
    outer.show_all()
    event('outer-opened')


def open_inner(outer, status):
    inner = Gtk.Dialog(title='Codex E2E Life Inner', transient_for=outer, modal=True)
    inner.set_default_size(360, 200)
    field = entry('Inner entry')
    inner.get_content_area().pack_start(field, False, False, 6)
    inner.add_button('Inner OK', Gtk.ResponseType.OK)

    def respond(_, response):
        if response == Gtk.ResponseType.OK:
            state['inner'] = field.get_text()
            status.set_text(f'Outer status: {field.get_text()}')
        inner.destroy()
        event('inner-closed', response == Gtk.ResponseType.OK)

    inner.connect('response', respond)
    inner.show_all()
    event('inner-opened')


def chooser(action, title, folder):
    dialog = Gtk.FileChooserDialog(title=title, transient_for=window, modal=True, action=action)
    dialog.add_button('_Cancel', Gtk.ResponseType.CANCEL)
    dialog.add_button('_Open' if action == Gtk.FileChooserAction.OPEN else '_Save', Gtk.ResponseType.ACCEPT)
    dialog.set_default_response(Gtk.ResponseType.ACCEPT)  # as apps do: Enter in the location bar
    dialog.set_default_size(800, 600)
    dialog.set_local_only(True)
    if action == Gtk.FileChooserAction.SAVE:
        dialog.set_create_folders(True)
    dialog.set_current_folder(folder)
    key = 'opened' if action == Gtk.FileChooserAction.OPEN else 'saved'
    state[key + '_selected'] = []

    def selected(*_):
        name = dialog.get_filename()
        if name and (not state[key + '_selected'] or state[key + '_selected'][-1] != name):
            state[key + '_selected'].append(name)
            save()

    def respond(_, response):
        if response == Gtk.ResponseType.ACCEPT:
            name = dialog.get_filename()
            state[key] = name
            if key == 'saved':
                Path(name).write_text('saved by the lifecycle fixture\n')
        dialog.destroy()
        event(key + '-closed', response == Gtk.ResponseType.ACCEPT)

    # Where keyboard focus moves inside the dialog (a popover closes when it leaves it).
    dialog.connect('set-focus', lambda _, widget: event('set-focus', title, type(widget).__name__ if widget else None))
    dialog.connect('focus-in-event', lambda *_: (event('focus-in', title), False)[-1])
    dialog.connect('focus-out-event', lambda *_: (event('focus-out', title), False)[-1])
    dialog.connect('selection-changed', selected)
    dialog.connect('response', respond)
    dialog.show_all()
    event(key + '-opened')


extras = []


def open_extra():
    """Another toplevel, identical to the earlier ones (same title and size)."""
    serial = len(extras)
    extra = Gtk.Window(title='Codex E2E Life Extra')
    extra.set_wmclass(app_id, app_id)
    extra.set_default_size(360, 220)
    state.setdefault('extras', {})[str(serial)] = {'text': '', 'open': True}
    field = named(Gtk.Entry(), 'Extra entry')

    def changed(*_):
        state['extras'][str(serial)]['text'] = field.get_text()
        save()

    def closed(*_):
        state['extras'][str(serial)]['open'] = False
        save()

    field.connect('changed', changed)
    extra.connect('destroy', closed)
    extra.add(column(field, button('Close extra', extra.destroy)))
    extras.append(extra)
    extra.show_all()
    save()


def open_quick():
    """A small window that closes as soon as it loses keyboard focus (like a
    quick switcher or a search popup); Enter in its entry submits."""
    quick = Gtk.Window(title='Codex E2E Life Quick')
    quick.set_transient_for(window)
    quick.set_default_size(320, 120)
    field = named(Gtk.Entry(), 'Quick entry')
    state['quick'] = {'open': True, 'focused': False, 'closed_by': None, 'value': None}

    def focus_in(*_):
        state['quick']['focused'] = True
        save()
        return False

    def focus_out(*_):
        if state['quick']['open']:
            state['quick'].update(open=False, closed_by='focus-out')
            save()
            GLib.idle_add(quick.destroy)
        return False

    def submit(*_):
        state['quick'].update(open=False, closed_by='enter', value=field.get_text())
        save()
        quick.destroy()

    quick.connect('focus-in-event', focus_in)
    quick.connect('focus-out-event', focus_out)
    field.connect('activate', submit)
    quick.add(column(named(Gtk.Label(label='Quick search'), 'Quick label'), field))
    quick.show_all()
    save()


def crash(field):
    # An abrupt crash: no cleanup, no unmapping by the app itself.
    if field.get_text() == 'crash now':
        os.kill(os.getpid(), signal.SIGKILL)


# --- layout ----------------------------------------------------------------

clicks = {}


def counted(label, *classes, key=None, presses=False):
    """A button counting its clicks; with presses, it also records where each
    press landed inside it (widget coordinates) and its size."""
    key = key or label
    clicks[key] = 0

    def clicked():
        clicks[key] += 1
        state['clicks'] = clicks
        save()
    widget = button(label, clicked, *classes)
    if presses:
        def pressed(w, ev):
            allocation = w.get_allocation()
            state.setdefault('presses', []).append({'target': label, 'x': ev.x, 'y': ev.y,
                                                    'width': allocation.width, 'height': allocation.height})
            save()
            return False
        widget.connect('button-press-event', pressed)
    return widget


def layout():
    window.set_default_size(560, 520)
    banner = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
    banner.get_style_context().add_class('banner')
    banner.set_size_request(-1, 220)
    # After the shift, the Danger button sits where the target field was.
    banner.pack_start(counted('Danger'), False, False, 0)
    banner.set_no_show_all(True)
    target = entry('Target field', 'target')
    holder = Gtk.Box()
    replaceable = [counted('Replace me')]
    holder.pack_start(replaceable[0], True, True, 0)
    content = column(banner, target, holder, *(named(Gtk.Label(label=f'Filler line {i}'), f'Filler {i}') for i in range(12)), border=48)
    scroll = Gtk.ScrolledWindow()
    scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
    scroll.set_min_content_width(0)
    scroll.set_min_content_height(0)
    scroll.add(content)
    overlay = Gtk.Overlay()
    overlay.add(scroll)
    for label, halign, valign in (('Corner TL', Gtk.Align.START, Gtk.Align.START), ('Corner BR', Gtk.Align.END, Gtk.Align.END)):
        corner = counted(label, presses=True)
        corner.set_halign(halign)
        corner.set_valign(valign)
        overlay.add_overlay(corner)
    window.add(overlay)

    def shift():
        banner.set_no_show_all(False)
        banner.show_all()
        GLib.idle_add(lambda: (state.__setitem__('shifted', True), save(), False)[-1])
        return True

    def replace():
        old = replaceable.pop()
        holder.remove(old)
        new = counted('Replace me', key='Replace me (new)')  # same label, a new widget
        replaceable.append(new)
        holder.pack_start(new, True, True, 0)
        new.show()
        state['replaced'] = True
        state['clicks'] = clicks
        save()
        return True

    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGUSR1, shift)
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGUSR2, replace)
    target.connect('focus-in-event', lambda *_: (event('focus', 'Target field'), False)[-1])
    state['clicks'] = clicks


# --- targets ---------------------------------------------------------------

def target_button(label, colour):
    widget = counted(label, 'solid', colour, presses=True)
    widget.set_size_request(180, 70)
    return widget


def targets():
    window.set_default_size(520, 600)
    grid = Gtk.Grid(row_spacing=40, column_spacing=60)
    grid.set_border_width(30)
    grid.attach(target_button('Magenta target', 'magenta'), 0, 0, 1, 1)
    grid.attach(target_button('Cyan target', 'cyan'), 1, 2, 1, 1)
    hover = named(Gtk.Button(label='Hover me'), 'Hover me')
    for name in ('solid', 'orange'):
        hover.get_style_context().add_class(name)
    hover.set_has_tooltip(True)
    # A solid 150x50 block, so screenshots show exactly where the tooltip is.
    tip = Gtk.Button(label='Tip')
    for name in ('solid', 'tip'):
        tip.get_style_context().add_class(name)
    tip.set_size_request(150, 50)
    tip.show()

    def query(widget, x, y, keyboard, tooltip):
        tooltip.set_custom(tip)
        if not state.get('tooltip'):
            state['tooltip'] = True
            save()
        return True
    hover.connect('query-tooltip', query)
    grid.attach(hover, 0, 3, 1, 1)
    for row, (label, constrain) in enumerate((('Inline popover', Gtk.PopoverConstraint.WINDOW),
                                              ('Detached popover', Gtk.PopoverConstraint.NONE))):
        opener = Gtk.MenuButton(label=label)
        named(opener, label)
        popover = Gtk.Popover()
        popover.set_constrain_to(constrain)
        word = label.split()[0]
        field = entry(f'{word} popover entry', f'{word.lower()}_popover_text')
        popover.add(column(field, counted(f'{word} popover action')))
        popover.get_child().show_all()
        opener.set_popover(popover)
        popover.connect('closed', lambda *_, w=word: event('popover-closed', w))
        grid.attach(opener, 0, 4 + row, 2, 1)
    window.add(grid)


if mode == 'dialogs':
    window.set_default_size(520, 520)
    main_entry = entry('Main entry', 'main')
    main_entry.connect('changed', crash)
    window.add(column(main_entry,
                      button('Open modal', open_outer),
                      button('Open file', lambda: chooser(Gtk.FileChooserAction.OPEN, 'Codex E2E Life Open File',
                                                          os.environ.get('LIFECYCLE_OPEN_FROM', GLib.get_home_dir()))),
                      button('Save file', lambda: chooser(Gtk.FileChooserAction.SAVE, 'Codex E2E Life Save File',
                                                          os.environ.get('LIFECYCLE_SAVE_IN', GLib.get_home_dir()))),
                      button('New window', open_extra),
                      button('Quick search', open_quick)))
elif mode == 'layout':
    layout()
elif mode == 'targets':
    targets()
else:
    raise SystemExit(f'unknown mode {mode}')
window.show_all()
save()
Gtk.main()
