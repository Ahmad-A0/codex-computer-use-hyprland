"""Window-scoped AT-SPI snapshots with native object identities.

Use WINDOW extents on Wayland: SCREEN extents commonly have a false zero
origin. Never guess between several windows belonging to the same process.
"""
from __future__ import annotations

import collections
import threading
import time


# Toolkit switches for apps we launch: Chromium/Electron, Qt, and GTK/Firefox.
LAUNCH_ENVIRONMENT = {"ACCESSIBILITY_ENABLED": "1", "QT_LINUX_ACCESSIBILITY_ALWAYS_ON": "1",
                      "GNOME_ACCESSIBILITY": "1"}


# Roles whose unnamed instances take their name from a labelled-by target, as
# GTK 4 menu items do (their label is a separate, otherwise hidden object).
# Unnamed controls take their name from the label they are "labelled by", as
# screen readers do and as a macOS text field takes its title from its label
# (GTK 3's file chooser name field is unnamed beside a "Name" label).
LABELLED_ROLES = ("menu item", "check menu item", "radio menu item", "text", "entry", "password text",
                  "combo box", "spin button", "slider", "check box", "radio button", "push button",
                  "toggle button", "list", "list box", "table", "tree table", "scroll pane")
# Popup roots that some toolkits announce only through events: Qt lists no
# Qt::Popup window among the application's children, and a GTK 4 entry's
# context menu hangs below an object its entry does not list as a child.
POPUP_EVENT_ROLES = ("popup menu", "menu", "window")
MENU_ROLES = ("popup menu", "menu")
# Containers whose children belong to the tree only while shown. As on macOS,
# a closed menu's items appear when it opens; GTK 3 lists every item of a
# closed menu bar, which in LibreOffice (about 1,300) exhausts the node budget
# before the document is reached. Containers that manage their descendants
# (a spreadsheet's millions of cells) likewise contribute only visible ones.
SHOWN_CHILDREN_ROLES = ("popup menu", "menu", "combo box")


class NoBounds(ValueError):
    """An element without usable extents (yet: Firefox reports none until it repaints)."""


class TextNotRetained(RuntimeError):
    """A text replacement the application ignored; obj is the field, focused if it took focus."""

    def __init__(self, obj, focused):
        super().__init__('Application did not retain the replacement value')
        self.obj, self.focused = obj, focused


def enable_session_accessibility():
    """Set the session-wide AT-SPI flag that Chromium, Electron and Firefox read
    before exposing a tree. macOS apps answer AX clients without this step.
    Apps started while it was off may need a restart."""
    from gi.repository import Gio, GLib
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION)
        bus.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.freedesktop.DBus.Properties", "Set",
                      GLib.Variant("(ssv)", ("org.a11y.Status", "IsEnabled", GLib.Variant("b", True))),
                      None, Gio.DBusCallFlags.NONE, 2000, None)
    except GLib.Error:
        pass  # No accessibility bus: observations fall back to compositor metadata.


class Accessibility:
    def __init__(self, probe_context=None):
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
        self.api = Atspi
        Atspi.set_timeout(500, 1000)
        self.elements = {}
        self.roots = {}
        self.probe_context = probe_context
        # Per window: identities of attached popup roots and, per element in
        # them, the popup's window-relative origin and scale (None if unknown).
        self.popup_roots = {}
        self.offsets = {}
        # Popup roots announced by showing events, by process. Toolkits emit
        # these only while some client listens, so listen from the start.
        self.announced = {}
        self.watched = set()
        self.pending = collections.deque(maxlen=2048)
        # Requests hold this lock; between them a thread keeps draining events
        # so an idle provider does not accumulate the desktop's event stream.
        self.lock = threading.RLock()
        self.draining = None
        self.listed = (None, None)
        try:
            self.listener = Atspi.EventListener.new(self.on_event)
            self.listener.register("object:state-changed:showing")
            self.listener.register("object:state-changed:focused")
        except Exception:
            self.listener = None

    @staticmethod
    def identity(obj):
        return f"atspi:{obj.get_process_id()}:{obj.path}"

    def name(self, obj, role):
        name = obj.get_name() or ""
        if name or role not in LABELLED_ROLES:
            return name
        labels = []
        try:
            for relation in obj.get_relation_set():
                if relation.get_relation_type() != self.api.RelationType.LABELLED_BY:
                    continue
                for i in range(relation.get_n_targets()):
                    target = relation.get_target(i)
                    if target is None:
                        continue
                    label = target.get_name() or ""
                    if not label and target.is_text():
                        label = self.api.Text.get_text(target, 0, min(target.get_character_count(), 400))
                    if label:
                        labels.append(label)
        except Exception:
            return name
        return " ".join(labels)

    def on_event(self, event):
        # Runs while the main context is iterated; snapshot() does the work.
        self.pending.append((event.type.endswith("focused"), event.detail1, event.source))

    def dispatch_events(self):
        from gi.repository import GLib
        context = GLib.MainContext.default()
        for _ in range(4096):
            if not context.iteration(False):
                break

    def drain_in_background(self):
        """Dispatch AT-SPI events between requests (callers hold self.lock during requests)."""
        if self.listener is None or self.draining is not None:
            return

        def drain():
            while True:
                time.sleep(.5)
                with self.lock:
                    self.dispatch_events()
        self.draining = threading.Thread(target=drain, name="atspi-events", daemon=True)
        self.draining.start()

    def menu_root(self, obj):
        """The outermost menu containing a focused menu item."""
        found = None
        for _ in range(32):
            obj = obj.get_parent()
            if obj is None:
                break
            role = obj.get_role_name()
            if role in MENU_ROLES:
                found = obj
            elif role in ("application", "frame", "dialog", "window", "filler"):
                break
        return found

    def pump(self):
        """Dispatch queued AT-SPI events and remember announced popup roots."""
        if self.listener is None:
            return
        with self.lock:
            self.dispatch_events()
            pending = list(self.pending)
            self.pending.clear()
        for focus, shown, obj in pending:
            try:
                pid = obj.get_process_id()
                if pid not in self.watched:
                    continue
                known = self.announced.setdefault(pid, {})
                if focus:
                    # A menu opened by the pointer focuses its first item.
                    if not shown or obj.get_role_name() not in LABELLED_ROLES:
                        continue
                    obj = self.menu_root(obj)
                    if obj is None:
                        continue
                elif not shown:
                    known.pop(self.identity(obj), None)
                    continue
                elif obj.get_role_name() not in POPUP_EVENT_ROLES or obj.get_index_in_parent() >= 0:
                    continue  # Listed roots are found among the application's children.
                known[self.identity(obj)] = obj
                while len(known) > 32:
                    known.pop(next(iter(known)))
            except Exception:
                continue

    def application_children(self, pid):
        desktop = self.api.get_desktop(0)
        if desktop is None:
            return None
        desktop.clear_cache()
        children = []
        for i in range(desktop.get_child_count()):
            app = desktop.get_child_at_index(i)
            if app is None:
                continue
            app.clear_cache()
            if app.get_process_id() != pid:
                continue
            for j in range(app.get_child_count()):
                child = app.get_child_at_index(j)
                if child is None:
                    continue
                child.clear_cache()
                if not child.get_state_set().contains(self.api.StateType.DEFUNCT):
                    children.append(child)
        return children

    @staticmethod
    def popup_geometry(client):
        """Mapped popup surfaces of this window, relative to it (compositor view)."""
        from . import background
        try:
            return background.send(client, "popup_list")["popups"]
        except Exception:
            return []

    def popup_match(self, obj, popups, client):
        """Popups whose size matches this accessible's window extents."""
        rect = obj.get_extents(self.api.CoordType.WINDOW)
        if rect.width <= 0 or rect.height <= 0:
            return []
        keys = ("raw_w", "raw_h") if client.get("xwayland") else ("w", "h")
        return [p for p in popups if abs(p[keys[0]] - rect.width) <= 1 and abs(p[keys[1]] - rect.height) <= 1]

    def popups(self, client, root):
        """Showing menus and other popups that belong to this window.

        Like a macOS menu, they are observed as part of the window. A popup is
        accepted only when the compositor (or the X11 transient chain) shows a
        popup of the same size on this window and on no other window of the app.
        Returns [(accessible, origin)]: origin is the popup's window-relative
        (x, y, scale) when its elements report surface-relative extents, None
        when that position is ambiguous, or False when they already report
        window-relative extents.
        """
        pid = client["pid"]
        root_id = self.identity(root)
        candidates = {}
        listed = self.listed[1] if self.listed[0] == pid else self.application_children(pid)
        for child in listed or []:
            if self.identity(child) != root_id:
                candidates[self.identity(child)] = child
        for ident, obj in list(self.announced.get(pid, {}).items()):
            candidates.setdefault(ident, obj)
        showing = []
        for ident, obj in candidates.items():
            try:
                obj.clear_cache()
                states = obj.get_state_set()
                if states.contains(self.api.StateType.DEFUNCT) or not states.contains(self.api.StateType.SHOWING):
                    continue
                showing.append(obj)
            except Exception:
                self.announced.get(pid, {}).pop(ident, None)
        if not showing:
            return []
        popups = self.popup_geometry(client)
        if not popups:
            return []
        others = None
        found = []
        for obj in showing:
            matches = self.popup_match(obj, popups, client)
            if not matches:
                continue
            if others is None:
                from . import desktop
                others = [p for c in desktop.query("clients")
                          if c.get("pid") == pid and c.get("address") != client["address"] and c.get("mapped", True)
                          for p in self.popup_geometry(c)]
            if self.popup_match(obj, others, client):
                continue  # Another window of this app shows a popup like it.
            if len(matches) > 1:
                # Toolkits that report popup positions relative to their
                # toplevel (Qt, X11) disambiguate same-sized popups.
                screen = obj.get_extents(self.api.CoordType.SCREEN)
                base = root.get_extents(self.api.CoordType.SCREEN) if client.get("xwayland") else None

                def near(p):
                    scale = p.get("scale", 1) or 1
                    x, y = (screen.x, screen.y) if base is None else ((screen.x - base.x) / scale, (screen.y - base.y) / scale)
                    return abs(p["x"] - x) <= 2 and abs(p["y"] - y) <= 2
                matches = [p for p in matches if near(p)]
            origin = obj.get_extents(self.api.CoordType.WINDOW)
            if (origin.x, origin.y) != (0, 0):
                # GTK 4 reports popover content in its toplevel's coordinates.
                found.append((obj, False))
                continue
            popup = matches[0] if len(matches) == 1 else None
            found.append((obj, None if popup is None else (popup["x"], popup["y"], popup.get("scale", 1) or 1)))
        return found

    def root(self, client):
        children = self.application_children(client["pid"])
        self.listed = (client["pid"], children)  # reused by popups() in the same snapshot
        if children is None:
            return None
        # Direct application children are toplevels; Qt reports a plain QWidget
        # window as "filler". Menus can be "window" (GTK 3) or "frame" (Chromium).
        # GTK 3's file, colour and font dialogs report chooser roles.
        frames = [f for f in children if f.get_role_name() in (
            "frame", "window", "dialog", "alert", "filler", "file chooser", "color chooser", "font chooser")]
        cached = self.roots.get(client["address"])
        if cached:
            found = [f for f in frames if self.identity(f) == cached]
            if len(found) == 1:
                return found[0]
        if len(frames) > 1:
            # An open menu is a separate accessible window; it is never the root.
            popups = self.popup_geometry(client)
            if popups:
                frames = [f for f in frames if not self.popup_match(f, popups, client)] or frames
        named = [f for f in frames if f.get_name() == client.get("title")]
        # A lone candidate stands for this window only if the app has no other
        # window; otherwise a dialog could be observed as its main window.
        from . import desktop
        sole = sum(1 for c in desktop.query("clients")
                   if c.get("pid") == client["pid"] and c.get("mapped", True)) == 1
        chosen = named[0] if len(named) == 1 else frames[0] if len(frames) == 1 and sole else None
        if chosen is None and named:
            sized = []
            for frame in named:
                rect = frame.get_extents(self.api.CoordType.WINDOW)
                if (rect.width, rect.height) == tuple(client["size"]):
                    sized.append(frame)
            if len(sized) == 1:
                chosen = sized[0]
        if chosen is None and client.get('xwayland'):
            located = []
            for frame in frames:
                rect = frame.get_extents(self.api.CoordType.SCREEN)
                if (rect.x, rect.y, rect.width, rect.height) == tuple(client['at'] + client['size']):
                    located.append(frame)
            if len(located) == 1:
                chosen = located[0]
        if chosen is None and frames and self.probe_context:
            from . import background
            def active_frames():
                result = []
                for frame in frames:
                    frame.clear_cache()
                    if frame.get_state_set().contains(self.api.StateType.ACTIVE):
                        result.append(frame)
                return result
            with self.probe_context(client):
                restoration = {}
                try:
                    cleared = background.send(client, 'ax_probe_clear')
                    if client.get('xwayland'):
                        restoration['previous'] = cleared['previous']
                    deadline = time.monotonic() + .6
                    while active_frames() and time.monotonic() < deadline:
                        time.sleep(.02)
                    if active_frames():
                        raise ValueError('Application did not acknowledge accessibility identity probe')
                    background.send(client, 'ax_probe')
                    deadline = time.monotonic() + .6
                    while time.monotonic() < deadline:
                        active = active_frames()
                        if len(active) == 1:
                            chosen = active[0]
                            break
                        time.sleep(.02)
                finally:
                    background.send(client, 'ax_probe_end', **restoration)
        if chosen is not None:
            self.roots[client["address"]] = self.identity(chosen)
            return chosen
        if frames:
            raise ValueError("Ambiguous AT-SPI window; cannot safely choose a tree")
        return None

    def snapshot(self, client, query="", settle=False, menu=False):
        wid = client["address"]
        self.elements.pop(wid, None)
        root = self.root(client)
        if root is None:
            # 'x11' would be a lie on a Wayland surface. The official formatter
            # accepts a source string; this is the sole extended source value.
            return {"id": f"hyprland:{wid}", "role": "window",
                    "name": client.get("title", ""),
                    "description": "No AT-SPI tree; use screenshot coordinates.",
                    "children": []}, "hyprland"
        self.watched.add(client["pid"])
        self.pump()
        popups = self.popups(client, root)
        if settle:
            # Toolkits announce a menu's accessible objects shortly after the
            # compositor maps it. After an action, wait (bounded) until every
            # popup the compositor shows on this window is in the tree.
            # When the action usually opens a menu (menu=True), also wait for
            # the compositor to map one: under load that can take a while.
            deadline = time.monotonic() + 1.0
            while time.monotonic() < deadline:
                mapped = len(self.popup_geometry(client))
                if len(popups) >= mapped and (mapped or not menu):
                    break
                time.sleep(.05)
                self.pump()
                popups = self.popups(client, root)
        elements, seen, offsets = {}, set(), {}
        deadline = time.monotonic() + 8
        limit = 1500
        truncated = False

        def walk(obj, depth=0, popup=False, offset=None, shown_only=False):
            nonlocal truncated
            if len(seen) >= limit or depth > 40 or time.monotonic() > deadline:
                truncated = True
                return None
            ident = self.identity(obj)
            if ident in seen:
                return None
            obj.clear_cache()
            states = obj.get_state_set()
            if states.contains(self.api.StateType.DEFUNCT):
                return None
            if shown_only and not states.contains(self.api.StateType.SHOWING):
                return None  # A closed menu's item or an off-screen cell; not counted against the budget.
            seen.add(ident)
            role = obj.get_role_name()
            node = {"id": ident, "role": role, "name": self.name(obj, role),
                    "states": [], "actions": [], "children": []}
            for state in ("checked", "defunct", "editable", "enabled", "expanded",
                          "focusable", "focused", "selected", "sensitive", "showing",
                          "visible", "indeterminate", "checkable"):
                enum = getattr(self.api.StateType, state.upper(), None)
                if enum is not None and states.contains(enum):
                    node["states"].append(state)
            # GTK 4 reports usable widgets as sensitive but never enabled; the
            # official formatter would then label every control "disabled".
            if "sensitive" in node["states"] and "enabled" not in node["states"]:
                node["states"].append("enabled")
            if obj.is_action():
                node["actions"] = [name for name in self.action_names(obj) if name]
            if role != "password text" and obj.is_text():
                node["value"] = self.api.Text.get_text(obj, 0, min(obj.get_character_count(), 4000))
            elements[ident] = (obj, role, node["name"])
            shown_children = (role in SHOWN_CHILDREN_ROLES
                              or states.contains(self.api.StateType.MANAGES_DESCENDANTS))
            if popup:
                offsets[ident] = offset
            for i in range(min(obj.get_child_count(), 1500)):
                child = obj.get_child_at_index(i)
                if child is not None:
                    item = walk(child, depth + 1, popup, offset, shown_children)
                    if item is not None:
                        node["children"].append(item)
                if truncated:
                    break
            return node

        tree = walk(root)
        if tree is None:
            raise ValueError("AT-SPI window disappeared during observation")
        # Open menus become the window's last children, as a macOS menu is in
        # its app's tree. They get their own budget so a large window cannot
        # hide them; a menu already in the window's tree (a GTK 4 popover) stays.
        limit, deadline, root_truncated = len(seen) + 500, time.monotonic() + 2, truncated
        attached = []
        for obj, offset in popups:
            truncated, popup_truncated = False, truncated
            node = walk(obj, 1, offset is not False, offset or None)
            truncated = truncated or popup_truncated
            if node is not None:
                attached.append((self.identity(obj), node))
                tree["children"].append(node)
        truncated = truncated or root_truncated
        self.popup_roots[wid] = {ident for ident, _ in attached}
        if truncated:
            tree["description"] = "Accessibility tree truncated by time, depth, or node budget."
        elif not tree["children"]:
            # Typically a Chromium/Electron app started without accessibility.
            tree["description"] = ("This window exposes no accessible content; use screenshot coordinates. "
                                   "Chromium and Electron apps expose it when launched through getApp.")
        if query:
            def keep(node):
                kids = [v for c in node["children"] if (v := keep(c)) is not None]
                matches = query.casefold() in " ".join(str(node.get(k, "")) for k in ("name", "value", "role")).casefold()
                return {**node, "children": kids} if matches or kids else None
            tree = keep(tree) or {**tree, "children": []}
        self.elements[wid] = elements
        self.offsets[wid] = offsets
        return tree, "at_spi"

    @staticmethod
    def action_names(obj):
        """Action names by index; "" where the toolkit cannot name one.

        GTK 4 can count actions it then fails to name ("No action with index
        0", seen on Nautilus and GNOME Text Editor widgets); one such element
        must not fail the whole observation or hide the others' actions."""
        from gi.repository import GLib
        names = []
        for index in range(obj.get_n_actions()):
            try:
                names.append(obj.get_action_name(index) or "")
            except GLib.Error:
                names.append("")
        return names

    def resolve(self, client, ident):
        found = self.elements.get(client["address"], {}).get(ident)
        if found is None:
            raise ValueError("Unknown or stale element; refresh getAXState()")
        obj, role, name = found
        obj.clear_cache()
        if (obj.get_state_set().contains(self.api.StateType.DEFUNCT)
                or obj.get_role_name() != role or self.name(obj, role) != name
                or obj.get_process_id() != client["pid"]):
            raise ValueError("Element changed; refresh getAXState()")
        # A surviving object may have been reparented into another window.
        expected = self.root(client)
        popup_roots = self.popup_roots.get(client["address"], set())
        parent = obj
        for _ in range(64):
            if parent is None:
                break
            ident = self.identity(parent)
            if expected is not None and ident == self.identity(expected):
                return obj
            if ident in popup_roots:
                # A menu element is usable only while its menu stays open.
                parent.clear_cache()
                if not parent.get_state_set().contains(self.api.StateType.SHOWING):
                    raise ValueError("The menu containing this element has closed; refresh getAXState()")
                return obj
            parent = parent.get_parent()
        raise ValueError("Element no longer belongs to the selected window")

    def point(self, client, ident):
        obj = self.resolve(client, ident)
        rect = obj.get_extents(self.api.CoordType.WINDOW)
        if rect.width <= 0 or rect.height <= 0:
            raise NoBounds("Element has no usable bounds")
        offsets = self.offsets.get(client["address"], {})
        if ident in offsets:
            # Popup elements report extents relative to their popup surface.
            if offsets[ident] is None:
                raise ValueError("This menu element's position is unknown; use its accessibility action or screenshot coordinates")
            x, y, scale = offsets[ident]
            return x + (rect.x + rect.width / 2) / scale, y + (rect.y + rect.height / 2) / scale
        return rect.x + rect.width / 2, rect.y + rect.height / 2

    def on_screen(self, obj):
        states = obj.get_state_set()
        if not (states.contains(self.api.StateType.SHOWING) and states.contains(self.api.StateType.VISIBLE)):
            return False
        rect = obj.get_extents(self.api.CoordType.WINDOW)
        return rect.width > 0 and rect.height > 0

    def primary_action(self, client, ident, button):
        obj = self.resolve(client, ident)
        if not obj.is_action():
            return None
        if self.offsets.get(client["address"], {}).get(ident) and obj.get_role_name() in LABELLED_ROLES:
            # Click a menu item in an open popup like a user does: Qt's press
            # action triggers the item but leaves its menu open, unlike macOS.
            return None
        if button == "left" and obj.get_role_name() == "menu" and self.on_screen(obj):
            parent = obj.get_parent()
            if parent is not None and parent.get_role_name() == "menu bar":
                # Open a visible menu bar's menu as a user's click does: GTK 3's
                # click action on a menu bar item (Mousepad, LibreOffice) opens
                # the bar's first menu instead. A hidden menu bar (Firefox's)
                # keeps its action.
                return None
        names = ("click", "press", "dodefault") if button == "left" else ("showcontextmenu", "show context menu", "menu")
        # Chromium exposes link activation as "jump", including offscreen
        # links. It is a primary action, unlike an entry's "activate" action.
        if button == "left" and obj.get_role_name() == "link":
            names = (*names, "jump")
        actions = self.action_names(obj)
        found = [name for name in actions if name and name.casefold() in names]
        if len(found) > 1:
            raise ValueError("Ambiguous primary accessibility action")
        return found[0] if found else None

    def action(self, client, ident, name=None, button="left"):
        obj = self.resolve(client, ident)
        if not obj.is_action():
            raise ValueError("Element exposes no accessibility actions")
        actions = self.action_names(obj)
        if name is None:
            names = ("click", "press", "activate", "dodefault") if button == "left" else ("showcontextmenu", "show context menu", "menu")
            found = [i for i, a in enumerate(actions) if a.casefold() in names]
        else:
            found = [i for i, a in enumerate(actions) if a.casefold() == name.casefold()]
        if len(found) != 1:
            raise ValueError(f"Accessibility action unavailable or ambiguous; exposed actions: {actions}")
        if not obj.do_action(found[0]):
            raise RuntimeError("AT-SPI action returned false; not replayed")

    def select_text(self, client, ident, value, prefix=None, suffix=None, selection_type='text'):
        obj = self.resolve(client, ident)
        if obj.get_role_name() == 'password text':
            raise ValueError('Text selection by content is unavailable for password fields')
        if not obj.is_text():
            raise ValueError('Element does not expose the AT-SPI Text interface')
        count = obj.get_character_count()
        if count > 1_000_000:
            raise ValueError('Text element exceeds the selection observation limit')
        content = self.api.Text.get_text(obj, 0, count)
        candidates = []
        offset = 0
        while offset <= len(content):
            start = content.find(value, offset)
            if start < 0:
                break
            end = start + len(value)
            if ((prefix is None or content[:start].endswith(prefix)) and
                    (suffix is None or content[end:].startswith(suffix))):
                candidates.append((start, end))
            offset = start + 1
        if len(candidates) != 1:
            raise ValueError('Text not found' if not candidates else 'Text is ambiguous; supply prefix and/or suffix')
        start, end = candidates[0]
        if selection_type == 'text':
            if obj.get_n_selections():
                ok = obj.set_selection(0, start, end)
                for index in reversed(range(1, obj.get_n_selections())):
                    obj.remove_selection(index)
            else:
                ok = obj.add_selection(start, end)
            if not ok:
                raise RuntimeError('Application refused text selection')
            selected = self.api.Text.get_selection(obj, 0)
            if (selected.start_offset, selected.end_offset) != (start, end):
                raise RuntimeError('Application did not apply the requested selection')
        else:
            for index in reversed(range(obj.get_n_selections())):
                obj.remove_selection(index)
            offset = start if selection_type == 'cursor_before' else end
            if not obj.set_caret_offset(offset) or obj.get_caret_offset() != offset:
                raise RuntimeError('Application did not apply the requested caret position')

    def set_value(self, client, ident, value):
        obj = self.resolve(client, ident)
        # A spin button's value is its number: GTK 3 replaces its text without
        # changing the value until the field is activated or loses focus, so
        # the app (Mousepad's tab width) never sees the change.
        if obj.get_role_name() == 'spin button' and obj.is_value() and self.numeric(value) is not None:
            try:
                self.set_numeric(obj, value)
                return
            except RuntimeError:
                if not obj.is_editable_text():
                    raise
        if obj.is_editable_text():
            if not self.api.EditableText.set_text_contents(obj, value):
                raise RuntimeError('Application refused the replacement value')
            # Password fields must not be read back or included in diagnostics.
            if obj.get_role_name() == 'password text' or not obj.is_text():
                return
            if self.retained(obj, value):
                return
            # Some apps apply it late (retained() waits); Firefox web pages
            # ignore it. Focus the field and try once more; if that fails too,
            # the backend types the value into the focused field.
            focused = lambda: (obj.clear_cache(), obj.get_state_set().contains(self.api.StateType.FOCUSED))[1]
            if not focused() and obj.is_component() and obj.grab_focus():
                deadline = time.monotonic() + .6
                while not focused() and time.monotonic() < deadline:
                    time.sleep(.02)
                if (self.api.EditableText.set_text_contents(obj, value)
                        and self.retained(obj, value)):
                    return
            raise TextNotRetained(obj, focused())
        if obj.is_value():
            self.set_numeric(obj, value)
            return
        raise ValueError('Element does not expose an editable text or numeric value interface')

    @staticmethod
    def numeric(value):
        import math
        try:
            number = float(value)
        except ValueError:
            return None
        return number if math.isfinite(number) else None

    def set_numeric(self, obj, value):
        import math
        numeric = self.numeric(value)
        if numeric is None:
            raise ValueError('This control requires a numeric value')
        if not obj.get_minimum_value() <= numeric <= obj.get_maximum_value():
            raise ValueError('Value is outside the control range')
        if not obj.set_current_value(numeric):
            raise RuntimeError('Application refused the numeric value')
        # Firefox applies it in its content process, so it shows up late.
        deadline = time.monotonic() + 1.0
        while True:
            obj.clear_cache()
            if math.isclose(obj.get_current_value(), numeric, rel_tol=1e-6, abs_tol=1e-6):
                return
            if time.monotonic() > deadline:
                raise RuntimeError('Application did not retain the numeric value')
            time.sleep(.05)

    def retained(self, obj, value, timeout=1.0):
        """Whether a text element shows value, allowing for apps that update it asynchronously."""
        deadline = time.monotonic() + timeout
        while True:
            obj.clear_cache()
            if self.api.Text.get_text(obj, 0, obj.get_character_count()) == value:
                return True
            if time.monotonic() > deadline:
                return False
            time.sleep(.05)

    def viewport(self, client, ident, horizontal=False):
        """Measure the nearest visible scroll viewport, clipped to the window."""
        obj = self.resolve(client, ident)
        best = client['size'][0 if horizontal else 1]
        for _ in range(64):
            if obj is None:
                break
            if obj.get_role_name() in ('scroll pane', 'viewport', 'document web', 'document frame'):
                rect = obj.get_extents(self.api.CoordType.WINDOW)
                origin = rect.x if horizontal else rect.y
                length = rect.width if horizontal else rect.height
                visible = min(best, origin + length) - max(0, origin)
                if visible > 0:
                    return visible
            obj = obj.get_parent()
        return best

    def editable(self, client, ident):
        """Validate a type_text target before any input is delivered."""
        obj = self.resolve(client, ident)
        if not (obj.get_state_set().contains(self.api.StateType.EDITABLE) or obj.is_editable_text()):
            raise ValueError('Element is not editable; refresh getAXState() and choose an editable element')
        rect = obj.get_extents(self.api.CoordType.WINDOW)
        if rect.width <= 0 or rect.height <= 0:
            raise ValueError('Editable element has no visible bounds')
        return obj

    def focus_editable(self, client, ident):
        """Focus an editable element, keeping its caret and selection.

        Toolkits such as GTK select all text on focus; typing must not replace it.
        """
        obj = self.editable(client, ident)
        focused = lambda: (obj.clear_cache(), obj.get_state_set().contains(self.api.StateType.FOCUSED))[1]
        if focused():
            return
        text = obj.is_text()
        selection = self.api.Text.get_selection(obj, 0) if text and obj.get_n_selections() else None
        caret = obj.get_caret_offset() if text else None
        if not obj.is_component() or not obj.grab_focus():
            raise RuntimeError('Application refused to focus the editable element; no text typed')
        deadline = time.monotonic() + .6
        while not focused():
            if time.monotonic() > deadline:
                raise RuntimeError('Application did not focus the editable element; no text typed')
            time.sleep(.02)
        if not text:
            return
        if selection is not None:
            ok = obj.set_selection(0, selection.start_offset, selection.end_offset) if obj.get_n_selections() else obj.add_selection(selection.start_offset, selection.end_offset)
        else:
            for index in reversed(range(obj.get_n_selections())):
                obj.remove_selection(index)
            ok = obj.set_caret_offset(caret) and obj.get_caret_offset() == caret
        if not ok:
            raise RuntimeError('Editable element did not restore its caret or selection; no text typed')

    def insert_focused_text(self, client, value):
        """Insert Unicode using the selected X11 control's native text interface."""
        self.snapshot(client)
        candidates = [obj for obj, _, _ in self.elements[client['address']].values()
                      if obj.is_editable_text() and obj.is_text()
                      and obj.get_state_set().contains(self.api.StateType.FOCUSED)]
        if len(candidates) != 1:
            raise ValueError('Unicode XWayland typing requires one focused AT-SPI editable control')
        obj = candidates[0]
        if obj.get_n_selections():
            selected = self.api.Text.get_selection(obj, 0)
            start, end = selected.start_offset, selected.end_offset
            if not self.api.EditableText.delete_text(obj, start, end):
                raise RuntimeError('Application refused deletion of selected text')
        else:
            start = obj.get_caret_offset()
        if not self.api.EditableText.insert_text(obj, start, value, len(value.encode('utf-8'))):
            raise RuntimeError('Application refused Unicode text insertion')
        obj.set_caret_offset(start + len(value))

    def focused_terminal(self, client):
        """Identify terminal controls without changing the focused element."""
        self.snapshot(client)
        focused = [obj for obj, _, _ in self.elements.get(client['address'], {}).values()
                   if obj.get_state_set().contains(self.api.StateType.FOCUSED)]
        if len(focused) != 1:
            return False
        obj = focused[0]
        for _ in range(64):
            if obj is None:
                break
            if obj.get_role_name() == 'terminal':
                return True
            obj = obj.get_parent()
        return False
