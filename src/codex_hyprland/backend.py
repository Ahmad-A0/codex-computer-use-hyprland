"""Sky Linux wire operations implemented with Hyprland, Wayland and AT-SPI."""
from __future__ import annotations

import contextlib
import fcntl
import io
import math
import os
import shlex
import sys
import json
import shutil
import uuid
from pathlib import Path
import tempfile
import time

from .accessibility import Accessibility
from . import background, session, desktop, guards


def number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number")
    return value


def positive_id(value):
    if type(value) is not int or not 0 < value <= 2**53 - 1:
        raise ValueError("window.id must be a positive JavaScript-safe integer")
    return value


def text(value, name, empty=True):
    if not isinstance(value, str) or "\0" in value or (not empty and not value.strip()):
        raise ValueError(f"{name} must be {'a nonempty' if not empty else 'a'} string without NUL")
    return value


class Backend:
    def __init__(self):
        import gi
        gi.require_version("Gio", "2.0")
        from gi.repository import Gio
        session.ensure_session_env()
        os.environ.setdefault("DBUS_SESSION_BUS_ADDRESS", f"unix:path={os.environ['XDG_RUNTIME_DIR']}/bus")
        self.hypr, self.gio = desktop, Gio
        self.seat_depth = 0
        self.ax = Accessibility(self.seat)
        self.trust = guards.Guards(self.ax)
        self.directory = tempfile.TemporaryDirectory(prefix="sky-hyprland-")
        self.captures = 0
        self.identities = {}
        self.pointer_position = None
        self.capture_origins = {}
        self.observation_deadlines = {}

    def defer_observation(self, params):
        window = params.get('window')
        key = window.get('id') if isinstance(window, dict) else None
        self.observation_deadlines[key] = time.monotonic() + .25

    def wait_for_observation(self, client=None):
        key = int(client['address'], 16) if client else None
        deadline = max(self.observation_deadlines.pop(key, 0),
                       self.observation_deadlines.pop(None, 0))
        if client is None:
            deadline = max([deadline, *self.observation_deadlines.values()])
            self.observation_deadlines.clear()
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(remaining)

    def close(self):
        self.directory.cleanup()

    def clients(self):
        return [c for c in self.hypr.query("clients") if c.get("mapped", True)]

    def window(self, c, active=None):
        wid = positive_id(int(c["address"], 16))
        self.identities.setdefault(wid, (c["pid"], c.get("initialClass", c.get("class"))))
        return {"id": wid, "app": c.get("class") or c.get("initialClass") or "unknown",
                "title": c.get("title", ""), "x": c["at"][0], "y": c["at"][1],
                "width": c["size"][0], "height": c["size"][1],
                "focused": c["address"] == active, "modal": False,
                "window_type": "normal"}

    def list_windows(self, _):
        active = (self.hypr.query("activewindow") or {}).get("address")
        clients = self.clients()
        current = {int(c["address"], 16) for c in clients}
        # Remember retired IDs to prevent a stale binding from hitting a reused address.
        for wid in self.identities.keys() - current:
            self.identities[wid] = None
        return [self.window(c, active) for c in clients]

    def apps(self):
        return [a for a in self.gio.AppInfo.get_all() if a.get_id() and a.should_show()]

    @staticmethod
    def app_aliases(app):
        wmclass = app.get_startup_wm_class() if hasattr(app, "get_startup_wm_class") else None
        return {s.casefold() for s in (app.get_id().removesuffix(".desktop"), app.get_name(),
                wmclass, Path(app.get_executable() or "").name) if s}

    def terminal_client(self, client):
        # Desktop categories cover terminal emulators regardless of brand or
        # custom window class. Executable matching handles e.g. floating windows.
        names = {client.get(k, "").casefold() for k in ("class", "initialClass")}
        try:
            executable = Path(f'/proc/{client["pid"]}/exe').resolve(strict=True)
        except OSError:
            executable = None
        for app in self.apps():
            categories = (app.get_categories() or "").split(";") if hasattr(app, "get_categories") else []
            if "TerminalEmulator" not in categories:
                continue
            candidate = shutil.which(app.get_executable() or "")
            if names & self.app_aliases(app) or (executable and candidate and Path(candidate).resolve() == executable):
                return True
        return False

    def list_apps(self, _):
        windows = self.list_windows({})
        result = []
        for a in self.apps():
            aliases = self.app_aliases(a)
            result.append({"id": a.get_id(), "name": a.get_display_name(),
                           "windows": [w for w in windows if w["app"].casefold() in aliases]})
        return sorted(result, key=lambda a: (a["name"].casefold(), a["id"]))

    def target(self, value):
        if not isinstance(value, dict):
            raise ValueError("A window from listWindows() is required")
        wid = positive_id(value.get("id"))
        client = next((c for c in self.clients() if int(c["address"], 16) == wid), None)
        if client is None:
            raise ValueError(f"Window {wid} is unavailable")
        identity = (client["pid"], client.get("initialClass", client.get("class")))
        if wid in self.identities and self.identities[wid] != identity:
            raise ValueError("Window ID was reused; restart the binding")
        self.identities.setdefault(wid, identity)
        self.trust.guard_client(client)
        return client

    @contextlib.contextmanager
    def seat(self, client=None):
        if self.seat_depth:
            if client:
                self.trust.guard_client(client)
                self.trust.guard_auth_client(client, False)
            yield
            return
        with open(guards.lock_path(), "a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if guards.enabled("READONLY"):
                raise RuntimeError("Read-only mode is set: input is refused")
            # Sky returns void on success. Reporting a dry-run as success would
            # lie to its caller, so reject instead of silently dropping input.
            if guards.enabled("DRYRUN"):
                raise RuntimeError("Dry-run mode is set: input was not delivered")
            self.trust.guard_seat()
            self.trust.guard_session_lock(client is not None, False)
            self.trust.guard_keyboard_layer(client is not None, False)
            if client:
                self.trust.guard_client(client)
                self.trust.guard_auth_client(client, False)
            self.seat_depth += 1
            try:
                yield
            finally:
                self.seat_depth -= 1
                self.trust.remember_seat()

    @contextlib.contextmanager
    def app_action(self, client):
        with self.seat(client):
            background.send(client, 'prepare_action')
            try:
                yield
            finally:
                background.send(client, 'activation_end')

    def active_target(self):
        c = self.hypr.query("activewindow") or {}
        if not c.get("address"):
            raise RuntimeError("No active application window")
        return self.target({"id": int(c["address"], 16)})

    def input_target(self, c, x, y):
        if c is not None:
            return c, x, y
        # A global coordinate targets its visible topmost application without
        # changing focus. App-bound CUA operations already supply the window.
        matches = [v for v in self.clients() if v.get("visible", False)
                   and v["at"][0] <= x < v["at"][0] + v["size"][0]
                   and v["at"][1] <= y < v["at"][1] + v["size"][1]]
        if not matches:
            raise ValueError("No application window at global coordinate")
        matches.sort(key=lambda v: (not v.get("floating", False), v.get("focusHistoryID", 999)))
        c = self.target({"id": int(matches[0]["address"], 16)})
        self.trust.guard_auth_client(c, False)
        return c, x - c["at"][0], y - c["at"][1]

    def focus(self, c):
        if (self.hypr.query("activewindow") or {}).get("address") == c["address"]:
            return self.target({"id": int(c["address"], 16)})
        desktop.focus_window(c["address"])
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            active = self.hypr.query("activewindow") or {}
            if active.get("address") == c["address"]:
                fresh = self.target({"id": int(c["address"], 16)})
                if fresh["size"] == c["size"] and fresh["at"] == c["at"]:
                    return fresh
                c = fresh
            time.sleep(0.025)
        raise RuntimeError("Target did not acquire focus; no input delivered")

    def point(self, c, x, y):
        x, y = number(x, "x"), number(y, "y")
        if c:
            w, h = c["size"]
            if not 0 <= x < w or not 0 <= y < h:
                background.send(c, "point", x=x, y=y)
            return c["at"][0] + x, c["at"][1] + y
        return x, y

    def location(self, p, c):
        if "element_id" in p:
            if not c or "x" in p or "y" in p:
                raise ValueError("An element requires one window and no coordinates")
            return self.ax.point(c, text(p["element_id"], "element_id", False))
        if c and "x" not in p and "y" not in p:
            return c["size"][0] / 2, c["size"][1] / 2
        origin = self.capture_origins.get(c["address"], (0, 0)) if c else (0, 0)
        return number(p.get("x"), "x") + origin[0], number(p.get("y"), "y") + origin[1]

    def screenshot(self, c=None):
        from PIL import Image
        if c:
            self.trust.guard_session_lock(True, False)
            data = background.capture(c)
            meta = {"geometry": [*c["at"], *c["size"]]}
        else:
            self.trust.guard_session_lock(False, False)
            data, meta = desktop.capture()
        # Return one image pixel per logical input pixel at EVERY output scale.
        # The unchanged CUA API exposes no alternate coordinate metadata.
        size = tuple(meta["geometry"][2:])
        with Image.open(io.BytesIO(data)) as image:
            image = image.convert("RGB")
            if image.size != size:
                image = image.resize(size, Image.Resampling.LANCZOS)
            if c:
                image, origin = background.composite_popups(c, image)
                self.capture_origins[c["address"]] = origin
            self.captures += 1
            path = Path(self.directory.name) / f"{self.captures}.jpg"
            image.save(path, "JPEG", quality=90)
        # Calls are serialized and Sky reads each path before its next request.
        previous = Path(self.directory.name) / f"{self.captures - 2}.jpg"
        previous.unlink(missing_ok=True)
        return [{"filepath": str(path)}]

    def get_window_state(self, p):
        c = self.target(p.get("window"))
        include = p.get("include_screenshot", True)
        if type(include) is not bool:
            raise ValueError("include_screenshot must be boolean")
        query = text(p.get("query", ""), "query")
        self.wait_for_observation(c)
        screenshots = self.screenshot(c) if include else []
        c = self.target(p["window"])
        tree, source = self.ax.snapshot(c, query)
        active = (self.hypr.query("activewindow") or {}).get("address")
        return {"window": self.window(c, active), "ax_tree": tree,
                "ax_tree_source": source, "screenshots": screenshots}

    def get_screenshot(self, _):
        self.wait_for_observation()
        return self.screenshot()

    def click(self, p):
        c = self.target(p["window"]) if "window" in p else None
        button = {"l": "left", "r": "right", "m": "middle"}.get(p.get("mouse_button"), p.get("mouse_button", "left"))
        if button not in ("left", "right", "middle"):
            raise ValueError("Invalid mouse_button")
        count = p.get("click_count", 1)
        if type(count) is not int or not 1 <= count <= 3:
            raise ValueError("click_count must be 1, 2, or 3")
        if "element_id" in p:
            if not c or "x" in p or "y" in p or count != 1 or button == "middle":
                raise ValueError("Element clicks require a window and one left or right click")
            ident = text(p["element_id"], "element_id", False)
            action = self.ax.primary_action(c, ident, button)
            if action is not None:
                with self.app_action(c):
                    self.ax.action(c, ident, name=action)
                return
            # Pick the coordinate channel BEFORE acting if AT-SPI offers no
            # click/menu action. Do not retry a failed or refused action.
            x, y = self.ax.point(c, ident)
            self.point(c, x, y)
            with self.seat(c):
                background.send(c, 'click', x=x, y=y, button=button, count=1)
            return
        x, y = self.location(p, c)
        self.point(c, x, y)
        with self.seat(c):
            c, x, y = self.input_target(c, x, y)
            background.send(c, "click", x=x, y=y, button=button, count=count)

    def scroll(self, p):
        c = self.target(p["window"]) if "window" in p else None
        directions = {"up": (0, -1), "u": (0, -1), "down": (0, 1), "d": (0, 1),
                      "left": (-1, 0), "l": (-1, 0), "right": (1, 0), "r": (1, 0)}
        if p.get("direction") not in directions:
            raise ValueError("Unknown scroll direction")
        if "pages" in p and "pixels" in p:
            raise ValueError("Specify pages or pixels, not both")
        if "pages" in p:
            pages = number(p["pages"], "pages")
            if pages <= 0:
                raise ValueError("pages must be positive")
            horizontal = directions[p["direction"]][0] != 0
            if c and "element_id" in p:
                extent = self.ax.viewport(c, text(p["element_id"], "element_id", False), horizontal)
            else:
                extent = (c or self.active_target())["size"][0 if horizontal else 1]
            pixels = pages * extent
        else:
            pixels = number(p.get("pixels", 500), "pixels")
        if not 0 < pixels <= 8388607:
            raise ValueError("pixels must be positive and fit Wayland's signed 24.8 coordinates")
        x, y = self.location(p, c)
        self.point(c, x, y)
        dx, dy = directions[p["direction"]]
        with self.seat(c):
            c, x, y = self.input_target(c, x, y)
            background.send(c, "scroll", x=x, y=y, dx=dx * pixels, dy=dy * pixels)

    def drag(self, p):
        c = self.target(p["window"]) if "window" in p else None
        path = p.get("path")
        if not isinstance(path, list) or len(path) != 2 or not all(isinstance(v, dict) for v in path):
            raise ValueError("This backend accepts a two-point drag path (the cua.drag contract)")
        points = [(number(v.get("x"), "x"), number(v.get("y"), "y")) for v in path]
        if c:
            ox, oy = self.capture_origins.get(c["address"], (0, 0))
            points = [(x+ox, y+oy) for x,y in points]
        self.point(c, *points[0])
        with self.seat(c):
            source, x, y = self.input_target(c, *points[0])
            end_x, end_y = points[1]
            if c is None:
                destination, end_x, end_y = self.input_target(None, end_x, end_y)
            elif 0 <= end_x < c["size"][0] and 0 <= end_y < c["size"][1]:
                destination = source
            else:
                destination, end_x, end_y = self.input_target(None, c["at"][0] + end_x, c["at"][1] + end_y)
            self.trust.guard_client(destination)
            self.trust.guard_auth_client(destination, False)
            if source.get("xwayland") or destination.get("xwayland"):
                if not source.get("xwayland") or not destination.get("xwayland"):
                    raise ValueError("Mixed Wayland/XWayland drag-and-drop requires the compositor data bridge")
                destination_info = background.send(destination, "x11_info")
                background.send(source, "drag", x=x, y=y, end_x=end_x, end_y=end_y,
                                destination_xid=destination_info['xid'],
                                destination_width=destination['size'][0], destination_height=destination['size'][1])
            else:
                background.drag(source, destination, (x, y), (end_x, end_y))

    def type_text(self, p):
        c = self.target(p["window"]) if "window" in p else None
        value = text(p.get("text"), "text")
        if not value:
            return
        c = c or self.active_target()
        with self.seat(c):
            self.trust.guard_password_field(c, False)
            if c.get("xwayland") and any(ord(char) > 127 for char in value):
                self.ax.insert_focused_text(c, value)
            else:
                background.type_text(c, value)

    def press_key(self, p):
        c = self.target(p["window"]) if "window" in p else None
        key = text(p.get("key"), "key", False)
        aliases = {"Control_L": "ctrl", "Control_R": "ctrl", "Shift_L": "shift", "Shift_R": "shift",
                   "Alt_L": "alt", "Alt_R": "altgr", "Super_L": "super", "Super_R": "super"}
        key = "+".join(aliases.get(k.strip(), k.strip()) for k in key.split("+"))
        modifiers, symbol = desktop.parse_combo(key)
        c = c or self.active_target()
        names = {"ctrl": "Control", "shift": "Shift", "alt": "Mod1", "logo": "Mod4", "altgr": "Mod5"}
        with self.seat(c):
            if not symbol:
                symbol = {"ctrl": "Control_L", "shift": "Shift_L", "alt": "Alt_L", "logo": "Super_L", "altgr": "ISO_Level3_Shift"}[modifiers[-1]]
            background.send(c, "key", key=symbol, modifiers=[names[m] for m in modifiers])

    def paste(self, p):
        from .clipboard import paste
        c = self.target(p.get("window"))
        value = text(p.get("text"), "text")
        format = p.get("format", "text")
        if format not in ("text", "html", "md"):
            raise ValueError("paste format must be text, html, or md")
        with self.seat(c):
            self.trust.guard_password_field(c, False)
            terminal = self.ax.focused_terminal(c) or self.terminal_client(c)
            modifiers = ['Control', 'Shift'] if terminal else ['Control']
            def trigger():
                background.send(c, 'key', key='v', modifiers=modifiers)
            paste(c, value, format, trigger)

    def select_text(self, p):
        c = self.target(p.get("window"))
        ident = text(p.get("element_id"), "element_id", False)
        value = text(p.get("text"), "text")
        prefix = text(p["prefix"], "prefix") if "prefix" in p else None
        suffix = text(p["suffix"], "suffix") if "suffix" in p else None
        selection = p.get("selection_type", "text")
        if selection not in ("text", "cursor_before", "cursor_after"):
            raise ValueError("Unknown selection type")
        with self.seat(c):
            self.ax.select_text(c, ident, value, prefix, suffix, selection)

    def set_value(self, p):
        c = self.target(p.get("window"))
        ident = text(p.get("element_id"), "element_id", False)
        value = text(p.get("value"), "value")
        with self.seat(c):
            self.trust.guard_password_field(c, False)
            self.ax.set_value(c, ident, value)

    def perform_secondary_action(self, p):
        c = self.target(p.get("window"))
        ident = text(p.get("element_id"), "element_id", False)
        action = text(p.get("action"), "action", False)
        with self.app_action(c):
            self.ax.action(c, ident, name=action)

    def resolve_app(self, p):
        name = text(p.get("app"), "app", False)
        entries = self.apps()
        exact = [a for a in entries if a.get_id() == name or
                 (hasattr(a, "get_filename") and a.get_filename() == name)]
        matches = exact or [a for a in entries if a.get_name().casefold() == name.casefold()]
        if not exact and len(matches) > 1:
            running = {a['id'] for a in self.list_apps({}) if a['windows']}
            preferred = [a for a in matches if a.get_id() in running]
            if preferred:
                matches = preferred
        if len(matches) != 1:
            raise ValueError("App not found or ambiguous; use its inventory ID or desktop-entry path")
        ident = matches[0].get_id()
        launched = False
        deadline = time.monotonic() + 10
        while True:
            app = next(a for a in self.list_apps({}) if a["id"] == ident)
            windows = app["windows"]
            if windows:
                order = {int(c["address"], 16): c.get("focusHistoryID", 999) for c in self.clients()}
                windows.sort(key=lambda w: (not w["focused"], order.get(w["id"], 999)))
                return windows[0]
            if not launched:
                self.launch_app({"app": ident})
                launched = True
            if time.monotonic() >= deadline:
                raise RuntimeError("Application did not expose a window after launch")
            time.sleep(.05)

    def launch_app(self, p):
        name = text(p.get("app"), "app", False)
        apps = self.apps()
        matches = [a for a in apps if a.get_id() == name]
        if not matches:
            matches = [a for a in apps if a.get_name().casefold() == name.casefold()]
        if len(matches) != 1:
            raise ValueError("App not found or ambiguous; use its exact inventory ID")
        status = Path(self.directory.name) / ('launch-' + uuid.uuid4().hex + '.json')
        with self.seat():
            env = {k: os.environ[k] for k in ("XDG_DATA_HOME", "XDG_DATA_DIRS", "DBUS_SESSION_BUS_ADDRESS", "WAYLAND_DISPLAY") if k in os.environ}
            command = shlex.join(["env", *(f"{k}={v}" for k, v in env.items()), sys.executable,
                                  "-m", "codex_hyprland.launch", matches[0].get_id(), str(status)])
            command = "[no_initial_focus on; focus_on_activate off] " + command
            if self.hypr.provider() == self.hypr.LUA:
                result = self.hypr._run("dispatch", "hl.dsp.exec_cmd(" + self.hypr.lua_str(command) + ")")
                if result.strip() != "ok":
                    raise RuntimeError(f"Application launch failed: {result}")
            else:
                self.hypr.dispatch("exec", command)
        # Wait for the launcher's result, not a new window. getApp's resolver
        # handles initial window readiness; launch_app may reuse a running app.
        deadline = time.monotonic() + 5
        try:
            while time.monotonic() < deadline:
                if status.exists():
                    result = json.loads(status.read_text())
                    if not result.get('ok'):
                        raise RuntimeError('Application launch failed: ' + result.get('error', 'unknown error'))
                    return
                time.sleep(.025)
            raise RuntimeError('Application launcher did not acknowledge the request; inspect inventory before retrying')
        finally:
            status.unlink(missing_ok=True)

    def activate_window(self, p):
        c = self.target(p.get("window"))
        with self.seat(c):
            self.focus(c)

    def move(self, p):
        c = self.target(p["window"]) if "window" in p else None
        x, y = self.location(p, c)
        self.point(c, x, y)
        with self.seat(c):
            c, x, y = self.input_target(c, x, y)
            background.send(c, "move", x=x, y=y)
            self.pointer_position = self.point(c, x, y)

    def move_relative(self, p):
        offsets = [p.get(k) for k in ("dx", "dy")]
        if any(type(v) is not int or not -32768 <= v <= 32767 for v in offsets):
            raise ValueError("Relative offsets must be integers in [-32768, 32767]")
        x, y = self.pointer_position or self.hypr.cursor_pos()
        self.move({"x": x + offsets[0], "y": y + offsets[1]})
