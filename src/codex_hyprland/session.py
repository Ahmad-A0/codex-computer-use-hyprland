"""Resolve one live compositor and its matching Wayland socket."""
import json
import os
import subprocess


def ensure_session_env():
    os.environ.setdefault('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')
    signature = os.environ.get('HYPRLAND_INSTANCE_SIGNATURE')
    if signature and os.environ.get('WAYLAND_DISPLAY'):
        return
    result = subprocess.run(['hyprctl', 'instances', '-j'], check=True,
                            capture_output=True, text=True, timeout=5)
    instances = json.loads(result.stdout)
    if signature:
        candidates = [item for item in instances if item['instance'] == signature]
    else:
        display = os.environ.get('WAYLAND_DISPLAY')
        candidates = [item for item in instances if not display or item['wl_socket'] == display]
    if not candidates:
        raise RuntimeError('No live Hyprland instance matches this session')
    selected = max(candidates, key=lambda item: item.get('time', 0))
    if not signature:
        os.environ['HYPRLAND_INSTANCE_SIGNATURE'] = selected['instance']
    if not os.environ.get('WAYLAND_DISPLAY'):
        os.environ['WAYLAND_DISPLAY'] = selected['wl_socket']
