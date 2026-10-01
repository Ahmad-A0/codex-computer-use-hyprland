"""Load the matching built module after compositor restart; drain before upgrades."""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import time
from . import desktop as hyprctl
from .paths import project_root

ROOT = project_root()


def status():
    try:
        result = json.loads(hyprctl._run('codex-background', '{"op":"status"}'))
        return result if result.get('ok') else None
    except (ValueError, RuntimeError):
        return None


def ensure_loaded():
    module = ROOT / 'build/codex-background.so'
    fingerprint = ROOT / 'build/native-build-id'
    if not module.is_file() or not fingerprint.is_file():
        raise RuntimeError('Build the native provider first: scripts/build-native.sh')
    instance = os.environ.get('HYPRLAND_INSTANCE_SIGNATURE', 'unknown')
    lock = ROOT / 'build' / ('load-' + instance.replace('/', '_') + '.lock')
    with contextlib.ExitStack() as stack:
        compiler = stack.enter_context((ROOT / 'build/compile.lock').open('a'))
        fcntl.flock(compiler, fcntl.LOCK_SH)
        expected = fingerprint.read_text().strip()
        held = stack.enter_context(lock.open('a'))
        fcntl.flock(held, fcntl.LOCK_EX)
        current = status()
        if current and current.get('build') == expected:
            return current
        if current:
            if current.get('busy'):
                raise RuntimeError('Native provider upgrade deferred: an input transaction is active')
            if current.get('version', 1) >= 2:
                response = json.loads(hyprctl._run('codex-background', '{"op":"drain"}'))
                if not response.get('ok'):
                    raise RuntimeError('Cannot drain the old native provider: ' + str(response))
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    current = status()
                    if current and not current.get('offers', 0):
                        break
                    time.sleep(.025)
                else:
                    raise RuntimeError('Native reload deferred: applications still hold clipboard offers')
            result = hyprctl._run('plugin', 'unload', str(module))
            if result.strip() != 'ok':
                raise RuntimeError('Cannot unload old native provider: ' + result)
        result = hyprctl._run('plugin', 'load', str(module))
        current = status()
        if not current or current.get('build') != expected:
            raise RuntimeError('Cannot load matching native provider; rebuild against the running Hyprland headers. ' + result)
        return current
