"""Disposable GTK 4 app: Ctrl+C offers rich formats, Ctrl+V records every pasted format."""
import hashlib
import json
from pathlib import Path
import struct
import sys
import zlib

import gi
gi.require_version("Gtk", "4.0")
from gi.repository import Gtk, Gdk, Gio, GLib

# Text, HTML, a PNG and arbitrary binary bytes, so a snapshot must keep all formats.
def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
PNG = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0))
       + chunk(b"IDAT", zlib.compress(b"\0\xff\0\0\0\xff\0\0\0\0\xff\xff\xff\xff")) + chunk(b"IEND", b""))
FORMATS = {"text/plain;charset=utf-8": "Copied café ✓".encode(), "text/html": b"<b>Copied</b> caf\xc3\xa9",
           "image/png": PNG, "application/x-codex-binary": bytes(range(256)) * 64}
output = Path(sys.argv[1])
state = {"copies": 0, "pastes": [], "offered": {k: hashlib.sha256(v).hexdigest() for k, v in FORMATS.items()}}


def save():
    output.write_text(json.dumps(state))


def paste(clipboard):
    received = {}
    mimes = list(clipboard.get_formats().get_mime_types() or [])
    def next_format():
        if not mimes:
            state["pastes"].append(received); save(); return
        mime = mimes.pop(0)
        def opened(source, result):
            try:
                stream, _ = clipboard.read_finish(result)
            except GLib.Error:
                next_format(); return
            target = Gio.MemoryOutputStream.new_resizable()
            def spliced(out, result):
                out.splice_finish(result)
                received[mime] = hashlib.sha256(out.steal_as_bytes().get_data()).hexdigest()
                next_format()
            target.splice_async(stream, Gio.OutputStreamSpliceFlags.CLOSE_SOURCE | Gio.OutputStreamSpliceFlags.CLOSE_TARGET,
                                GLib.PRIORITY_DEFAULT, None, spliced)
        clipboard.read_async([mime], GLib.PRIORITY_DEFAULT, None, opened)
    next_format()


def pressed(controller, keyval, keycode, modifiers):
    if not modifiers & Gdk.ModifierType.CONTROL_MASK:
        return False
    clipboard = window.get_clipboard()
    if keyval in (Gdk.KEY_c, Gdk.KEY_C):
        providers = [Gdk.ContentProvider.new_for_bytes(k, GLib.Bytes.new(v)) for k, v in FORMATS.items()]
        clipboard.set_content(Gdk.ContentProvider.new_union(providers))
        state["copies"] += 1; save(); return True
    if keyval in (Gdk.KEY_v, Gdk.KEY_V):
        paste(clipboard); return True
    return False


app = Gtk.Application(application_id="dev.codex.ClipboardFixture", flags=Gio.ApplicationFlags.NON_UNIQUE)
def activate(application):
    global window
    window = Gtk.ApplicationWindow(application=application, title="Codex Clipboard Fixture")
    window.set_default_size(420, 300)
    label = Gtk.Label(label="Clipboard surface")
    label.set_focusable(True)
    window.set_child(label)
    keys = Gtk.EventControllerKey()
    keys.connect("key-pressed", pressed)
    window.add_controller(keys)
    window.present()
    save()
app.connect("activate", activate)
app.run([])
