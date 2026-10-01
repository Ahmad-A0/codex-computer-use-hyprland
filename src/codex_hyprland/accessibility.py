"""Window-scoped AT-SPI snapshots with native object identities.

Use WINDOW extents on Wayland: SCREEN extents commonly have a false zero
origin. Never guess between several windows belonging to the same process.
"""
from __future__ import annotations

import time


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

    @staticmethod
    def identity(obj):
        return f"atspi:{obj.get_process_id()}:{obj.path}"

    def root(self, client):
        desktop = self.api.get_desktop(0)
        if desktop is None:
            return None
        desktop.clear_cache()
        frames = []
        for i in range(desktop.get_child_count()):
            app = desktop.get_child_at_index(i)
            if app is None:
                continue
            app.clear_cache()
            if app.get_process_id() != client["pid"]:
                continue
            for j in range(app.get_child_count()):
                frame = app.get_child_at_index(j)
                if frame is None:
                    continue
                frame.clear_cache()
                if frame.get_state_set().contains(self.api.StateType.DEFUNCT):
                    continue
                if frame.get_role_name() in ("frame", "window", "dialog", "alert"):
                    frames.append(frame)
        cached = self.roots.get(client["address"])
        if cached:
            found = [f for f in frames if self.identity(f) == cached]
            if len(found) == 1:
                return found[0]
        named = [f for f in frames if f.get_name() == client.get("title")]
        chosen = named[0] if len(named) == 1 else frames[0] if len(frames) == 1 else None
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

    def snapshot(self, client, query=""):
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
        elements, seen = {}, set()
        deadline = time.monotonic() + 8
        truncated = False

        def walk(obj, depth=0):
            nonlocal truncated
            if len(seen) >= 1500 or depth > 40 or time.monotonic() > deadline:
                truncated = True
                return None
            ident = self.identity(obj)
            if ident in seen:
                return None
            seen.add(ident)
            obj.clear_cache()
            states = obj.get_state_set()
            if states.contains(self.api.StateType.DEFUNCT):
                return None
            role = obj.get_role_name()
            node = {"id": ident, "role": role, "name": obj.get_name() or "",
                    "states": [], "actions": [], "children": []}
            for state in ("checked", "defunct", "editable", "enabled", "expanded",
                          "focusable", "focused", "selected", "sensitive", "showing",
                          "visible", "indeterminate", "checkable"):
                enum = getattr(self.api.StateType, state.upper(), None)
                if enum is not None and states.contains(enum):
                    node["states"].append(state)
            if obj.is_action():
                node["actions"] = [obj.get_action_name(i) for i in range(obj.get_n_actions())]
            if role != "password text" and obj.is_text():
                node["value"] = self.api.Text.get_text(obj, 0, min(obj.get_character_count(), 4000))
            elements[ident] = (obj, role, node["name"])
            for i in range(min(obj.get_child_count(), 1500)):
                child = obj.get_child_at_index(i)
                if child is not None:
                    item = walk(child, depth + 1)
                    if item is not None:
                        node["children"].append(item)
                if truncated:
                    break
            return node

        tree = walk(root)
        if tree is None:
            raise ValueError("AT-SPI window disappeared during observation")
        if truncated:
            tree["description"] = "Accessibility tree truncated by time, depth, or node budget."
        if query:
            def keep(node):
                kids = [v for c in node["children"] if (v := keep(c)) is not None]
                matches = query.casefold() in " ".join(str(node.get(k, "")) for k in ("name", "value", "role")).casefold()
                return {**node, "children": kids} if matches or kids else None
            tree = keep(tree) or {**tree, "children": []}
        self.elements[wid] = elements
        return tree, "at_spi"

    def resolve(self, client, ident):
        found = self.elements.get(client["address"], {}).get(ident)
        if found is None:
            raise ValueError("Unknown or stale element; refresh getAXState()")
        obj, role, name = found
        obj.clear_cache()
        if (obj.get_state_set().contains(self.api.StateType.DEFUNCT)
                or obj.get_role_name() != role or obj.get_name() != name
                or obj.get_process_id() != client["pid"]):
            raise ValueError("Element changed; refresh getAXState()")
        # A surviving object may have been reparented into another window.
        expected = self.root(client)
        parent = obj
        for _ in range(64):
            if parent is None:
                break
            if expected is not None and self.identity(parent) == self.identity(expected):
                return obj
            parent = parent.get_parent()
        raise ValueError("Element no longer belongs to the selected window")

    def point(self, client, ident):
        obj = self.resolve(client, ident)
        rect = obj.get_extents(self.api.CoordType.WINDOW)
        if rect.width <= 0 or rect.height <= 0:
            raise ValueError("Element has no usable bounds")
        return rect.x + rect.width / 2, rect.y + rect.height / 2

    def primary_action(self, client, ident, button):
        obj = self.resolve(client, ident)
        if not obj.is_action():
            return None
        names = ("click", "press", "dodefault") if button == "left" else ("showcontextmenu", "show context menu", "menu")
        # Chromium exposes link activation as "jump", including offscreen
        # links. It is a primary action, unlike an entry's "activate" action.
        if button == "left" and obj.get_role_name() == "link":
            names = (*names, "jump")
        actions = [obj.get_action_name(i) for i in range(obj.get_n_actions())]
        found = [name for name in actions if name.casefold() in names]
        if len(found) > 1:
            raise ValueError("Ambiguous primary accessibility action")
        return found[0] if found else None

    def action(self, client, ident, name=None, button="left"):
        obj = self.resolve(client, ident)
        if not obj.is_action():
            raise ValueError("Element exposes no accessibility actions")
        actions = [obj.get_action_name(i) for i in range(obj.get_n_actions())]
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
        import math
        obj = self.resolve(client, ident)
        if obj.is_editable_text():
            if not self.api.EditableText.set_text_contents(obj, value):
                raise RuntimeError('Application refused the replacement value')
            # Password fields must not be read back or included in diagnostics.
            if obj.get_role_name() != 'password text' and obj.is_text():
                actual = self.api.Text.get_text(obj, 0, obj.get_character_count())
                if actual != value:
                    raise RuntimeError('Application did not retain the replacement value')
            return
        if obj.is_value():
            try:
                numeric = float(value)
            except ValueError:
                raise ValueError('This control requires a numeric value') from None
            if not math.isfinite(numeric) or not obj.get_minimum_value() <= numeric <= obj.get_maximum_value():
                raise ValueError('Value is outside the control range')
            if not obj.set_current_value(numeric):
                raise RuntimeError('Application refused the numeric value')
            if not math.isclose(obj.get_current_value(), numeric, rel_tol=1e-6, abs_tol=1e-6):
                raise RuntimeError('Application did not retain the numeric value')
            return
        raise ValueError('Element does not expose an editable text or numeric value interface')

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
