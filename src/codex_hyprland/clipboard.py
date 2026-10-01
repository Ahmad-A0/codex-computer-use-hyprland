"""Targeted Wayland offers and format-preserving X11 clipboard transactions."""
from html.parser import HTMLParser
import time
import tempfile
from . import background

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
    if client.get('xwayland'):
        return paste_x11(client, items, trigger)
    token = background.send(client, 'paste_begin', items=items)['token']
    try:
        trigger()
        deadline = time.monotonic() + 4
        last = None
        quiet = time.monotonic()
        while time.monotonic() < deadline:
            status = background.send(client, 'paste_status', token=token)
            signature = (status['received'], status['completed'], status['failed'])
            if signature != last:
                last, quiet = signature, time.monotonic()
            if status['failed']:
                raise RuntimeError('Application closed its clipboard transfer before completion')
            if status['completed'] and status['received'] == status['completed'] and time.monotonic() - quiet >= .2:
                return
            time.sleep(.025)
        raise RuntimeError('Application did not consume the private clipboard offer')
    finally:
        background.send(client, 'paste_end', token=token)


def paste_x11(client, items, trigger):
    import json
    import select
    import subprocess
    from pathlib import Path
    info = background.send(client, 'x11_info')
    snapshot = {}
    if info.get('clipboard_wayland'):
        # XWM rejects unfocused X clients reading a Wayland-owned selection.
        # Read through Wayland instead; the helper accepts this snapshot only
        # after verifying that XWM itself owns the X selection.
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
        info['wayland_snapshot'] = snapshot
    from .paths import project_root
    helper = project_root() / 'build/codex-xclipboard'
    process = subprocess.Popen([str(helper)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True, start_new_session=True)
    ready = False
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
        process.stdin.write(json.dumps({**info, 'items': items})+'\n')
        process.stdin.flush()
        initial = reply()
        if initial.get('snapshot_ready'):
            if background.send(client, 'x11_info')['clipboard_identity'] != info['clipboard_identity']:
                raise RuntimeError('Clipboard changed before paste; paste not started')
            process.stdin.write('own\n');process.stdin.flush()
            initial = reply()
        ready = initial.get('ready', False)
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
        if ready and process.poll() is None:
            try:
                process.stdin.write('end\n'); process.stdin.flush()
                if not reply().get('restored'):
                    raise RuntimeError('X11 clipboard restoration was not acknowledged')
            finally:
                process.stdin.close(); process.stdout.close()
        else:
            process.stdin.close(); process.stdout.close()
        # The owner keeps the restored formats alive until the next copy or X server exit.
        # EOF also triggers restoration if this provider is interrupted.
        if process.poll() is not None:
            process.wait()
