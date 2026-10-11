"""Disposable GTK 3 app for input-fidelity tests. Every toplevel has an entry,
a drag-and-drop source and target, a slider, a multi-selection list, an event
pad that records raw pointer events, and a long document. Toplevels are
undecorated, so their widget coordinates are window coordinates; each window's
state, with the geometry of its widgets, is written to STATE_JSON (atomically,
coalesced) under its title, so tests check the app itself.
Usage: input.py STATE_JSON APP_ID TITLE [TITLE...]   (one process, one toplevel
per title; run with GDK_BACKEND=x11 for XWayland)."""
import json
import os
import sys
from pathlib import Path
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk, GLib

out = Path(sys.argv[1])
app_id = sys.argv[2]
titles = sys.argv[3:] or ['Codex E2E Input']
GLib.set_prgname(app_id)
state = {'pid': os.getpid(), 'windows': {}}
views = []
pending = False
MODS = [(Gdk.ModifierType.SHIFT_MASK, 'shift'), (Gdk.ModifierType.CONTROL_MASK, 'ctrl'),
        (Gdk.ModifierType.MOD1_MASK, 'alt'), (Gdk.ModifierType.SUPER_MASK, 'super')]


def mods(mask):
    return [name for bit, name in MODS if mask & bit]


def flush():
    global pending
    pending = False
    for view in views:
        view.collect()
    temporary = out.with_name(out.name + '.tmp')
    temporary.write_text(json.dumps(state))
    temporary.replace(out)  # readers never see half a file
    return False


def dirty(*_):
    global pending
    if not pending:
        pending = True
        GLib.timeout_add(20, flush)
    return False


def named(widget, name):
    widget.get_accessible().set_name(name)
    return widget


class View:
    def __init__(self, title):
        self.title = title
        self.s = state['windows'].setdefault(title, {'keys': [], 'pad': [], 'padCount': 0, 'dropped': [], 'active': False})
        window = self.window = Gtk.Window(title=title)
        window.set_wmclass(app_id, app_id)
        window.set_decorated(False)  # no client-side frame: widget = window coordinates
        window.set_default_size(880, 1000)
        window.connect('destroy', Gtk.main_quit)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        box.set_border_width(10)
        window.add(box)
        self.entry = named(Gtk.Entry(), 'Input entry')
        box.pack_start(self.entry, False, False, 0)
        row = Gtk.Box(spacing=12)
        self.source = Gtk.EventBox()
        self.source.add(Gtk.Label(label='Drag source'))
        self.source.set_size_request(240, 44)
        named(self.source, 'Drag source')
        self.source.drag_source_set(Gdk.ModifierType.BUTTON1_MASK, [], Gdk.DragAction.COPY)
        self.source.drag_source_add_text_targets()
        self.source.connect('drag-data-get', lambda _w, _c, data, _i, _t: data.set_text(f'payload from {title} ✓', -1))
        self.target = Gtk.EventBox()
        self.target.add(Gtk.Label(label='Drop target'))
        self.target.set_size_request(240, 44)
        named(self.target, 'Drop target')
        self.target.drag_dest_set(Gtk.DestDefaults.ALL, [], Gdk.DragAction.COPY)
        self.target.drag_dest_add_text_targets()
        self.target.connect('drag-data-received', self.dropped)
        row.pack_start(self.source, False, False, 0)
        row.pack_start(self.target, False, False, 0)
        box.pack_start(row, False, False, 0)
        self.scale = named(Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 1000, 1), 'Input slider')
        self.scale.set_draw_value(False)
        box.pack_start(self.scale, False, False, 0)
        self.list = named(Gtk.ListBox(), 'Input list')
        self.list.set_selection_mode(Gtk.SelectionMode.MULTIPLE)
        self.list.set_activate_on_single_click(False)
        for i in range(8):
            label = Gtk.Label(label=f'Row {i}', xalign=0)
            label.set_size_request(-1, 26)
            self.list.add(label)
        box.pack_start(self.list, False, False, 0)
        self.pad = named(Gtk.DrawingArea(), 'Input pad')
        self.pad.set_size_request(-1, 110)
        self.pad.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK
                            | Gdk.EventMask.SCROLL_MASK | Gdk.EventMask.SMOOTH_SCROLL_MASK | Gdk.EventMask.POINTER_MOTION_MASK)
        self.pad.connect('draw', lambda _w, cr: (cr.set_source_rgb(.85, .9, 1), cr.paint()))
        self.pad.connect('button-press-event', self.pressed)
        self.pad.connect('scroll-event', self.scrolled)
        self.pad.connect('button-release-event', self.released)
        self.pad.connect('motion-notify-event', self.moved)
        box.pack_start(self.pad, False, False, 0)
        self.scroll = named(Gtk.ScrolledWindow(), 'Input viewport')
        self.view = named(Gtk.TextView(), 'Input document')
        self.view.set_wrap_mode(Gtk.WrapMode.NONE)
        self.scroll.add(self.view)
        box.pack_start(self.scroll, True, True, 0)
        self.buffer = self.view.get_buffer()
        self.buffer.set_text('\n'.join(f'Line {i:03d}: scrolling document text' for i in range(400)))
        for signal in ('changed', 'notify::cursor-position', 'notify::selection-bound'):
            self.entry.connect(signal, dirty)
        self.buffer.connect('changed', dirty)
        self.buffer.connect('mark-set', dirty)
        self.scale.connect('value-changed', dirty)
        self.list.connect('selected-rows-changed', dirty)
        for adjustment in (self.scroll.get_vadjustment(), self.scroll.get_hadjustment()):
            adjustment.connect('value-changed', dirty)
            adjustment.connect('changed', dirty)
        window.connect('key-press-event', self.key)
        window.connect('notify::is-active', dirty)
        window.connect('size-allocate', dirty)
        window.show_all()
        self.entry.grab_focus()

    def at(self, widget, x=0, y=0):
        """Widget coordinates to window coordinates."""
        wx, wy = widget.translate_coordinates(self.window, 0, 0)
        return [wx + x, wy + y]

    def rect(self, widget):
        a = widget.get_allocation()
        return [*self.at(widget), a.width, a.height]

    def key(self, _, event):
        self.s['keys'] = (self.s['keys'] + [[Gdk.keyval_name(event.keyval), mods(event.state)]])[-400:]
        dirty()
        return False

    def pressed(self, _, event):
        kind = {Gdk.EventType.BUTTON_PRESS: 1, Gdk.EventType._2BUTTON_PRESS: 2,
                Gdk.EventType._3BUTTON_PRESS: 3}.get(event.type, 0)
        return self.log({'kind': 'press', 'n': kind, 'button': event.button,
                         'at': self.at(self.pad, event.x, event.y), 'mods': mods(event.state)})

    def log(self, entry):
        """The pad's last 300 events; seq counts them all."""
        entry['seq'] = self.s['padCount'] = self.s.get('padCount', 0) + 1
        self.s['pad'] = (self.s['pad'] + [entry])[-300:]
        dirty()
        return True

    def released(self, _, event):
        return self.log({'kind': 'release', 'button': event.button, 'at': self.at(self.pad, event.x, event.y)})

    def moved(self, _, event):
        return self.log({'kind': 'motion', 'at': self.at(self.pad, event.x, event.y),
                         'held': bool(event.state & Gdk.ModifierType.BUTTON1_MASK)})

    def scrolled(self, _, event):
        ok, dx, dy = event.get_scroll_deltas()
        if not ok:
            dx, dy = {Gdk.ScrollDirection.UP: (0, -1), Gdk.ScrollDirection.DOWN: (0, 1),
                      Gdk.ScrollDirection.LEFT: (-1, 0), Gdk.ScrollDirection.RIGHT: (1, 0)}.get(event.direction, (0, 0))
        return self.log({'kind': 'scroll', 'dx': dx, 'dy': dy, 'smooth': ok,
                         'at': self.at(self.pad, event.x, event.y), 'mods': mods(event.state)})

    def dropped(self, _widget, _context, _x, _y, data, _info, _time):
        self.s['dropped'].append(data.get_text())
        dirty()

    def collect(self):
        s, b = self.s, self.buffer
        document = b.get_text(b.get_start_iter(), b.get_end_iter(), True)
        bounds = b.get_selection_bounds()
        v, h = self.scroll.get_vadjustment(), self.scroll.get_hadjustment()
        start, end = self.scale.get_slider_range()
        line, height = self.view.get_line_yrange(b.get_start_iter())
        s.update(
            active=self.window.is_active(), text=self.entry.get_text(),
            selection=list(self.entry.get_selection_bounds()),
            document=document, docSelection=[bounds[0].get_offset(), bounds[1].get_offset()] if bounds else [],
            caret=b.get_iter_at_mark(b.get_insert()).get_offset(),
            v={'value': v.get_value(), 'upper': v.get_upper(), 'page': v.get_page_size()},
            h={'value': h.get_value(), 'upper': h.get_upper(), 'page': h.get_page_size()},
            lineHeight=height, value=self.scale.get_value(),
            listSelection=sorted(r.get_index() for r in self.list.get_selected_rows()),
            geometry={'entry': self.rect(self.entry), 'source': self.rect(self.source), 'target': self.rect(self.target),
                      'slider': self.rect(self.scale), 'knob': [self.at(self.scale, start)[0], self.at(self.scale, end)[0]],
                      'pad': self.rect(self.pad), 'viewport': self.rect(self.scroll), 'document': self.rect(self.view),
                      'rows': [self.rect(r) for r in self.list.get_children()]})
        # Character positions of a short document (window coordinates of each
        # character's box), for drags and clicks on exact characters.
        # One more than the characters: the end of the text.
        glyphs = []
        if len(document) <= 400:
            for offset in range(b.get_char_count() + 1):
                r = self.view.get_iter_location(b.get_iter_at_offset(offset))
                x, y = self.view.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, r.x, r.y)
                glyphs.append([*self.at(self.view, x, y), r.width, r.height])
        s['glyphs'] = glyphs


for t in titles:
    views.append(View(t))
dirty()
Gtk.main()
