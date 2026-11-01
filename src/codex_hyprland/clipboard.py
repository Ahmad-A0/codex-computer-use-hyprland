"""Targeted Wayland offers and format-preserving X11 clipboard transactions."""
from html.parser import HTMLParser
import json
import os
import select
import subprocess
import time
import tempfile
from . import background, desktop

class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.hidden = 0
    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.hidden += 1
        elif tag in ('br', 'p', 'div', 'li', 'tr', 'h1', 'h2', 'h3'):
            self.parts.append('\n')
    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.hidden = max(0, self.hidden - 1)
        elif tag in ('p', 'div', 'li', 'tr'):
            self.parts.append('\n')
    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def paste(client, value, format, trigger=None):
    if trigger is None:
        trigger = lambda: background.send(client, 'key', key='v', modifiers=['Control'])
    items = {}
    if format == 'md':
        from markdown_it import MarkdownIt
        markup = MarkdownIt('commonmark', {'html': False}).render(value)
        items['text/markdown'] = value
    elif format == 'html':
        markup = value
    else:
        markup = None
    if markup is not None:
        parser = PlainText(); parser.feed(markup)
        plain = ''.join(parser.parts).strip('\n')
        items['text/html'] = markup
    else:
        plain = value
    items.update({'text/plain;charset=utf-8': plain, 'text/plain': plain})
    return paste_items(client, items, trigger)


def paste_items(client, items, trigger):
    """Offer MIME data (str or bytes values) to the app's own paste action."""
    if client.get('xwayland'):
        return paste_x11(client, items, trigger)
    if all(isinstance(v, str) for v in items.values()):
        return offer(client, {'items': items}, trigger)
    # Saved snapshots carry arbitrary bytes; pass them in a private file.
    with tempfile.NamedTemporaryFile(prefix='codex-cua-request-', dir=os.environ['XDG_RUNTIME_DIR']) as blob:
        formats = []
        for mime, data in items.items():
            data = data.encode() if isinstance(data, str) else data
            blob.write(data); formats.append([mime, len(data)])
        blob.flush()
        return offer(client, {'blob': blob.name, 'formats': formats}, trigger)


def disown(client):
    """Make the module hold the user's clipboard if the target app holds it.

    A toolkit answers a paste in the app that owns the desktop selection from
    its own copied data and reads no offer (GTK 3, so Firefox, after the user
    copied in it). Every format is read and the module takes over the selection
    with those bytes; the user's clipboard keeps its contents, and the app,
    no longer its owner, reads the private offer."""
    state = background.send(client, 'selection_owner')
    if not state['own']:
        return
    identity = state['identity']
    mimes = [m for m in dict.fromkeys(state['mimes']) if m not in SELECTION_REQUESTS]
    if len(mimes) > 128:
        raise RuntimeError('Clipboard advertises too many formats')
    formats, total, deadline = [], 0, time.monotonic() + 10
    with tempfile.TemporaryDirectory(prefix='codex-cua-request-', dir=os.environ['XDG_RUNTIME_DIR']) as directory:
        for index, mime in enumerate(mimes):
            pipe = os.path.join(directory, str(index))
            os.mkfifo(pipe, 0o600)
            fd = os.open(pipe, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
            try:
                background.send(client, 'selection_read', identity=identity, mime=mime, path=pipe)
                data = read_pipe(fd, min(32 << 20, (64 << 20) - total), deadline, mime)
            finally:
                os.close(fd)
            formats.append((mime, data)); total += len(data)
    if not formats:
        raise RuntimeError('The application holding the clipboard offers no readable format')
    with tempfile.NamedTemporaryFile(prefix='codex-cua-request-', dir=os.environ['XDG_RUNTIME_DIR']) as blob:
        for _, data in formats:
            blob.write(data)
        blob.flush()
        background.send(client, 'selection_adopt', identity=identity, blob=blob.name,
                        formats=[[mime, len(data)] for mime, data in formats])


def offer(client, fields, trigger):
    """Offer data privately to the client and run its paste.

    Apps may read a new selection as soon as it is offered (Chromium's
    clipboard observers do), and handle the paste shortcut much later, after
    the input still queued before it (a long typed text). The paste is the
    read that follows the shortcut: the offer stays private and current until
    then, and a window on a hidden workspace gets frame callbacks meanwhile,
    since a toolkit that redrew waits for one before reading further input.
    Ending the transaction at the early read let the paste find another
    selection (Chromium then pasted nothing, or the user's clipboard)."""
    disown(client)
    token = background.send(client, 'paste_begin', **fields)['token']
    lease = None
    try:
        def status():
            reply = background.send(client, 'paste_status', token=token)
            if reply['failed']:
                raise RuntimeError('Application closed its clipboard transfer before completion')
            return reply['received'], reply['completed']
        # Reads of the offer itself, before the shortcut.
        early, since, deadline = status(), time.monotonic(), time.monotonic() + 1
        while time.monotonic() < deadline and time.monotonic() - since < .15:
            time.sleep(.025)
            if (now := status()) != early:
                early, since = now, time.monotonic()
        def own_windows():
            return {c['address'] for c in desktop.query('clients') if c.get('pid') == client['pid']}
        before = own_windows()
        trigger()
        start = quiet = leased = checked = time.monotonic()
        lease = background.send(client, 'refresh_begin')['token']
        last = None
        while True:
            received, completed = signature = status()
            now = time.monotonic()
            if signature != last:
                last, quiet = signature, now
            done = completed == received and now - quiet >= .2
            if done and received > early[0]:
                return
            # An app that pastes what it read when offered reads no more.
            if done and early[1] and now - start >= 5:
                return
            # The app answered the paste with a window of its own (LibreOffice's
            # Text Import dialog, slow to open, reads the offer before it): the
            # paste was handled; the agent continues in that dialog.
            if now - checked >= .25:
                checked = now
                if own_windows() - before:
                    return
            if now - start >= 10:
                raise RuntimeError('Application did not consume the private clipboard offer')
            if now - leased >= 4:  # leases lapse after five seconds
                background.send(client, 'refresh_end', token=lease)
                lease, leased = None, now
                lease = background.send(client, 'refresh_begin')['token']
            background.send(client, 'refresh')
            time.sleep(.025)
    finally:
        try:
            if lease is not None:
                background.send(client, 'refresh_end', token=lease)
        finally:
            background.send(client, 'paste_end', token=token)


# ICCCM selection requests that are not data formats. GTK 3 also lists them as
# Wayland MIME types (SAVE_TARGETS for clipboard managers) but never answers
# them, and DELETE/INSERT_* would modify the app's selection.
SELECTION_REQUESTS = frozenset(('TARGETS', 'TIMESTAMP', 'MULTIPLE', 'SAVE_TARGETS', 'DELETE',
                                'INSERT_SELECTION', 'INSERT_PROPERTY'))


def read_pipe(fd, limit, deadline, mime=None):
    chunks, size = [], 0
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            raise RuntimeError('Application did not finish writing its copied data'
                               + (f' ({mime})' if mime else ''))
        chunk = os.read(fd, 1 << 16)
        if not chunk:
            return b''.join(chunks)
        size += len(chunk)
        if size > limit:
            raise RuntimeError('Clipboard snapshot exceeds size limit')
        chunks.append(chunk)


def copy(client, trigger):
    """Run the app's Copy without changing the desktop clipboard; return {mime: bytes}."""
    if client.get('xwayland'):
        return copy_x11(client, trigger)
    background.send(client, 'copy_begin')
    try:
        trigger()
        deadline = time.monotonic() + 3
        while not (state := background.send(client, 'copy_status'))['captured']:
            if time.monotonic() > deadline:
                raise RuntimeError('Copy did not update the clipboard; select content first')
            time.sleep(.025)
        mimes = [m for m in dict.fromkeys(state['mimes']) if m not in SELECTION_REQUESTS]
        if len(mimes) > 128:
            raise RuntimeError('Clipboard advertises too many formats')
        result, total, deadline = {}, 0, time.monotonic() + 10
        with tempfile.TemporaryDirectory(prefix='codex-cua-request-', dir=os.environ['XDG_RUNTIME_DIR']) as directory:
            for index, mime in enumerate(mimes):
                pipe = os.path.join(directory, str(index))
                os.mkfifo(pipe, 0o600)
                fd = os.open(pipe, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
                try:
                    background.send(client, 'copy_read', mime=mime, path=pipe)
                    data = read_pipe(fd, min(32 << 20, (64 << 20) - total), deadline, mime)
                finally:
                    os.close(fd)
                if data:
                    result[mime] = data; total += len(data)
        if not result:
            raise RuntimeError('Copy produced no readable clipboard data')
        return result
    finally:
        background.send(client, 'copy_end')


def wayland_snapshot(client, info):
    # XWM rejects unfocused X clients reading a Wayland-owned selection.
    # Read through Wayland instead; the helper accepts this snapshot only
    # after verifying that XWM itself owns the X selection.
    snapshot = {}
    types = subprocess.run(['wl-paste', '--list-types'], check=True,
                           capture_output=True, timeout=3).stdout.decode().splitlines()
    if len(types) > 256:
        raise RuntimeError('Clipboard advertises too many formats')
    total = 0
    for mime in dict.fromkeys(types):
        with tempfile.TemporaryFile() as data:
            subprocess.run(['wl-paste', '--no-newline', '--type', mime],
                           check=True, stdout=data, stderr=subprocess.DEVNULL, timeout=3)
            size = data.tell();total += size
            if size > 32*1024*1024 or total > 64*1024*1024:
                raise RuntimeError('Clipboard snapshot exceeds size limit')
            data.seek(0);snapshot[mime] = data.read().hex()
    if background.send(client, 'x11_info')['clipboard_identity'] != info['clipboard_identity']:
        raise RuntimeError('Clipboard changed during snapshot; paste not started')
    return snapshot


def x11_owner(client, request):
    """Start the X11 selection helper; return it, its reply reader and x11_info."""
    from .paths import helper
    info = background.send(client, 'x11_info')
    if info.get('clipboard_wayland'):
        info['wayland_snapshot'] = wayland_snapshot(client, info)
    process = subprocess.Popen([str(helper('codex-xclipboard'))], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True, start_new_session=True)
    def reply():
        if not select.select([process.stdout], [], [], 12)[0]:
            raise RuntimeError('X11 clipboard owner timed out')
        line = process.stdout.readline()
        if not line:
            raise RuntimeError('X11 clipboard ownership changed during paste')
        result = json.loads(line)
        if not result.get('ok'):
            raise RuntimeError(result.get('error', 'X11 clipboard failed'))
        return result
    try:
        process.stdin.write(json.dumps({**info, **request})+'\n')
        process.stdin.flush()
        initial = reply()
        if initial.get('snapshot_ready'):
            if background.send(client, 'x11_info')['clipboard_identity'] != info['clipboard_identity']:
                raise RuntimeError('Clipboard changed before paste; paste not started')
            process.stdin.write('own\n');process.stdin.flush()
            initial = reply()
    except BaseException:
        finish_owner(process)
        raise
    return process, reply, initial


def finish_owner(process):
    process.stdin.close(); process.stdout.close()
    # The owner keeps the restored formats alive until the next copy or X server exit.
    # EOF also triggers restoration if this provider is interrupted.
    if process.poll() is not None:
        process.wait()


# X11-only text targets; UTF8_STRING becomes the Wayland plain-text MIME type.
X11_TEXT = ('UTF8_STRING', 'STRING', 'TEXT', 'COMPOUND_TEXT')


def copy_x11(client, trigger):
    process, reply, initial = x11_owner(client, {'mode': 'copy'})
    try:
        if not initial.get('armed'):
            raise RuntimeError('X11 clipboard helper did not arm the copy')
        trigger()
        result = reply()  # One line: restoration done, with the copied formats.
        if not result.get('restored'):
            raise RuntimeError('X11 clipboard restoration was not acknowledged')
        formats = {name: bytes.fromhex(data) for name, data in result['formats'].items()}
    finally:
        finish_owner(process)
    if 'UTF8_STRING' in formats:
        formats.setdefault('text/plain;charset=utf-8', formats['UTF8_STRING'])
    return {name: data for name, data in formats.items() if name not in X11_TEXT and data}


def paste_x11(client, items, trigger):
    encoded = {k: (v.encode() if isinstance(v, str) else v).hex() for k, v in items.items()}
    process, reply, initial = x11_owner(client, {'items_hex': encoded})
    ready = initial.get('ready', False)
    try:
        if not ready:
            raise RuntimeError('Clipboard owner did not acknowledge readiness')
        trigger()
        deadline = time.monotonic() + 6
        last = None
        quiet = time.monotonic()
        while time.monotonic() < deadline:
            process.stdin.write('status\n'); process.stdin.flush()
            result = reply()
            signature = (result['received'], result['completed'])
            if signature != last:
                last, quiet = signature, time.monotonic()
            if result['completed'] and result['received'] == result['completed'] and time.monotonic()-quiet >= .3:
                break
            time.sleep(.025)
        else:
            raise RuntimeError('X11 application did not consume the clipboard offer')
    finally:
        try:
            if ready and process.poll() is None:
                process.stdin.write('end\n'); process.stdin.flush()
                if not reply().get('restored'):
                    raise RuntimeError('X11 clipboard restoration was not acknowledged')
        finally:
            finish_owner(process)
