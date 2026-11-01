"""Transport to our compositor module; no global-seat input fallback."""
import json
import subprocess
import tempfile
import os
import contextlib
import time
from pathlib import Path
from . import desktop as hyprctl
from .paths import helper

# Keys each XWayland window holds (Sky key_down and per-action chords). The
# X11 helper's private keyboard holds exactly the target's keys for each run.
held = {}
X11_OPERATIONS = ('click', 'move', 'drag', 'scroll', 'key', 'text', 'point', 'ax_probe', 'ax_probe_clear',
                  'ax_probe_end', 'popup_capture', 'popup_list', 'hold', 'button', 'drag_motion')
ACTIVATING = ('drag', 'click', 'key', 'text', 'hold', 'button', 'drag_motion')


def x11_release(display):
    """Release every key and button the private X11 devices still hold."""
    request = json.dumps({'op': 'release_all', 'display': display})
    subprocess.run([str(helper('codex-x11')), request], capture_output=True, timeout=10)


def send(client, operation, **fields):
    if client.get('xwayland') and operation in X11_OPERATIONS:
        info = send(client, 'x11_info')
        request = dict(op=operation, xid=info['xid'], display=info['display'], width=client['size'][0], height=client['size'][1],
                       held=held.get(client['address'], []), **fields)
        program = helper('codex-x11')
        if operation in ACTIVATING:
            send(client, 'activation_begin')
        try:
            result = subprocess.run([str(program), json.dumps(request)], capture_output=True, text=True, timeout=60)
        finally:
            if operation in ACTIVATING:
                send(client, 'activation_end')
        try:
            response = json.loads(result.stdout)
        except ValueError:
            raise RuntimeError('X11 input helper failed: ' + result.stderr.strip()) from None
        if result.returncode or not response.get('ok'):
            raise RuntimeError(response.get('error', 'X11 input failed'))
        return response
    payload = json.dumps(dict(op=operation, address=client['address'], **fields), ensure_ascii=True, separators=(',', ':'))
    with contextlib.ExitStack() as stack:
        if len(payload.encode()) > 60000:
            transfer = stack.enter_context(tempfile.NamedTemporaryFile(prefix='codex-cua-request-', dir=os.environ['XDG_RUNTIME_DIR'], mode='w+'))
            transfer.write(payload); transfer.flush()
            payload = json.dumps({'op': 'request_file', 'path': transfer.name})
        result = hyprctl._run('codex-background', payload)
    try:
        response = json.loads(result)
    except ValueError:
        raise RuntimeError('Background input module unavailable; restart the provider so it builds and loads the plugin for this Hyprland session.') from None
    if not response.get('ok'):
        raise RuntimeError(response.get('error', 'Background input failed'))
    return response


def capture(client):
    stable = client.get('stableId')
    if not stable:
        raise RuntimeError('Hyprland does not expose the stable toplevel ID needed for background capture')
    with refreshing(client) as lease:
        # Hyprland never completes a toplevel capture of a window lying outside
        # its own monitor; say so instead of waiting for grim's timeout.
        if lease.get('copyable') is False:
            raise RuntimeError('Hyprland cannot capture this window: it lies outside the monitor of its workspace. '
                               'Move it onto that monitor to take screenshots.')
        # Hyprland 0.57 fails a frame whose buffer no longer matches the window
        # (it was resizing, e.g. after a text change), and grim 1.5 then
        # crashes instead of exiting. The next attempt sees the settled size.
        for attempt in range(4):
            try:
                return subprocess.run(['grim', '-T', stable, '-s', '1', '-t', 'png', '-'], check=True, capture_output=True, timeout=15).stdout
            except subprocess.TimeoutExpired:
                raise RuntimeError('Hyprland did not deliver a capture of this window within 15 seconds') from None
            except subprocess.CalledProcessError:
                if attempt == 3:
                    raise RuntimeError('Hyprland failed to capture this window (it kept changing size)') from None
                time.sleep(0.1 * (attempt + 1))
                settle(client)


@contextlib.contextmanager
def refreshing(client):
    lease = send(client, 'refresh_begin')
    try:
        settle(client)
        yield lease
    finally:
        send(client, 'refresh_end', token=lease['token'])


def settle(client):
    # Round trips let the client process input and submit buffers after its
    # pending frame callbacks. Bound animation work rather than waiting for
    # identical pixels (which would hang on a blinking cursor or video).
    quiet = 0
    for attempt in range(12):
        state = send(client, 'refresh')
        quiet = quiet + 1 if not state['callbacks'] else 0
        time.sleep(.016)
        if attempt >= 3 and quiet >= 2:
            break


def caught_up(client, done=None, limit=10):
    """Let a window handle the input already sent to it.

    A window on a hidden workspace gets no frame callbacks, and a toolkit
    that redrew waits for one before handling further input, so typed text
    can queue up there for seconds. Service the window's frame callbacks until
    done() holds or, without it, until the window stops asking for frames
    (about a fifth of a second), within limit seconds."""
    deadline = time.monotonic() + limit
    lease = send(client, 'refresh_begin')['token']
    leased = checked = time.monotonic()
    try:
        quiet = 0
        while time.monotonic() < deadline:
            if done is not None and time.monotonic() - checked >= .1:
                if done():
                    return True
                checked = time.monotonic()
            if done is None and quiet >= 12:
                return True
            if time.monotonic() - leased >= 4:  # leases lapse after five seconds
                send(client, 'refresh_end', token=lease)
                lease, leased = send(client, 'refresh_begin')['token'], time.monotonic()
            quiet = quiet + 1 if not send(client, 'refresh')['callbacks'] else 0
            time.sleep(.016)
        return False
    finally:
        send(client, 'refresh_end', token=lease)


def type_text(client, value):
    # Bound IPC and compositor event-loop work, including Unicode keymap size.
    chunk = ''
    extras = set()
    for char in value:
        new = ord(char) > 126 and char not in extras
        if len(chunk) >= 512 or (new and len(extras) >= 16):  # the module has 19 spare keys
            send(client, 'text', text=chunk)
            with refreshing(client):
                pass
            chunk, extras = '', set()
        chunk += char
        if ord(char) > 126:
            extras.add(char)
    if chunk:
        send(client, 'text', text=chunk)


def drag(source, destination, start, end):
    import time
    send(source, 'drag_begin', x=start[0], y=start[1])
    finished = False
    try:
        world_start = (source['at'][0] + start[0], source['at'][1] + start[1])
        world_end = (destination['at'][0] + end[0], destination['at'][1] + end[1])
        for step in range(1, 25):
            fraction = step / 24
            gx = world_start[0] + (world_end[0] - world_start[0]) * fraction
            gy = world_start[1] + (world_end[1] - world_start[1]) * fraction
            inside_dest = (destination['at'][0] <= gx < destination['at'][0] + destination['size'][0]
                           and destination['at'][1] <= gy < destination['at'][1] + destination['size'][1])
            target = destination if inside_dest else source
            send(target, 'drag_move', x=gx-target['at'][0], y=gy-target['at'][1])
            time.sleep(.02)
        # Allow the destination to negotiate MIME and action before dropping.
        deadline = time.monotonic() + .75
        while time.monotonic() < deadline:
            send(destination, 'drag_move', x=end[0], y=end[1])
            status = send(source, 'drag_status')
            if not status['dnd'] or status['accepted']:
                break
            time.sleep(.02)
        status = send(source, 'drag_end')
        deadline = time.monotonic() + 3
        while not status['finished'] and time.monotonic() < deadline:
            time.sleep(.02)
            status = send(source, 'drag_status')
        if not status['finished']:
            raise RuntimeError('Drop target did not finish the drag-and-drop transfer')
        finished = True
    finally:
        if not finished:
            send(source, 'drag_cancel')


def composite_popups(client, image):
    """Return an app-only image and its window-relative origin."""
    import math
    from PIL import Image
    with tempfile.NamedTemporaryFile(prefix='codex-cua-popup-', dir=os.environ['XDG_RUNTIME_DIR']) as pixels:
        state = send(client, 'popup_capture', path=pixels.name)
        layers = []
        for popup in state['popups']:
            pixels.seek(int(popup['offset']))
            raw = pixels.read(int(popup['bytes']))
            layer = Image.frombytes('RGBA', (int(popup['width']), int(popup['height'])), raw)
            transform = int(popup['transform'])
            if transform >= 4:
                layer = layer.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
            if transform % 4:
                layer = layer.rotate(90 * (transform % 4), expand=True)
            scale = popup['scale']
            box = tuple(round(v*scale) for v in (popup['crop_x'], popup['crop_y'], popup['crop_x']+popup['w'], popup['crop_y']+popup['h']))
            layer = layer.crop(box).resize((round(popup['w']), round(popup['h'])), Image.Resampling.LANCZOS)
            layers.append((popup['x'], popup['y'], layer))
    if not layers:
        return image, (0, 0)
    left = math.floor(min(0, *(x for x,y,layer in layers)))
    top = math.floor(min(0, *(y for x,y,layer in layers)))
    right = math.ceil(max(image.width, *(x+layer.width for x,y,layer in layers)))
    bottom = math.ceil(max(image.height, *(y+layer.height for x,y,layer in layers)))
    if (right-left)*(bottom-top) > 16_777_216:
        raise RuntimeError('App and popup capture exceeds image size limit')
    canvas = Image.new('RGBA', (right-left, bottom-top), (30,30,30,255))
    canvas.paste(image, (-left,-top))
    for x,y,layer in layers:
        canvas.alpha_composite(layer, (round(x-left),round(y-top)))
    return canvas.convert('RGB'), (left,top)
