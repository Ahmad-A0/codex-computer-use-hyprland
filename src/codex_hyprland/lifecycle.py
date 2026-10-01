"""Load the plugin built for the running Hyprland, building it on first use."""
import contextlib
import fcntl
import hashlib
import json
import os
import subprocess
import time
from pathlib import Path
from . import desktop as hyprctl
from .paths import cache_dir, lock_dir, project_root

ROOT = project_root()


def status():
    try:
        result = json.loads(hyprctl._run('codex-background', '{"op":"status"}'))
        return result if result.get('ok') else None
    except (ValueError, RuntimeError):
        return None


def header_abi():
    return subprocess.run([ROOT / 'scripts/hyprland-abi.sh'], check=True,
                          capture_output=True, text=True).stdout.strip()


def build_id(abi):
    digest = hashlib.sha256((abi + '\n').encode())
    for pattern in ('*.cpp', '*.hpp'):
        for path in sorted((ROOT / 'native').glob(pattern), key=lambda p: p.name):
            digest.update(path.read_bytes())
    return digest.hexdigest()


def ensure_built(abi):
    """Return the cached plugin for this ABI, compiling it when stale."""
    module = cache_dir() / 'native' / abi / 'codex-background.so'
    stamp = module.with_name('build-id')
    expected = build_id(abi)
    if module.is_file() and stamp.is_file() and stamp.read_text().strip() == expected:
        return module, expected
    installed = header_abi()
    if installed != abi:
        raise RuntimeError(f'Hyprland was upgraded: running {abi}, installed headers {installed}. '
                           'Log out and back in (or restart Hyprland) to use the new version.')
    result = subprocess.run([ROOT / 'scripts/build-native.sh'], capture_output=True, text=True, timeout=600)
    if result.returncode or stamp.read_text().strip() != expected:
        raise RuntimeError('Native plugin build failed for this Hyprland version; it may need a provider update.\n'
                           + (result.stderr or result.stdout)[-2000:])
    return module, expected


def mapped_modules():
    # The loaded build may come from another installation (a checkout or the package).
    with contextlib.suppress(OSError, ValueError, KeyError, StopIteration, subprocess.SubprocessError):
        signature = os.environ.get('HYPRLAND_INSTANCE_SIGNATURE')
        instances = json.loads(subprocess.run(['hyprctl', 'instances', '-j'], capture_output=True,
                                              text=True, timeout=5).stdout)
        pid = next(item['pid'] for item in instances if item['instance'] == signature)
        for line in Path(f'/proc/{pid}/maps').read_text().splitlines():
            path = line.split(maxsplit=5)[5:]
            if path and path[0].removesuffix(' (deleted)').endswith('/codex-background.so'):
                yield Path(path[0].removesuffix(' (deleted)'))


def loaded_candidates(module):
    # hyprctl unloads by path only; try every location a build may have used.
    yield module
    yield from dict.fromkeys(mapped_modules())
    yield from (cache_dir() / 'native').glob('*/codex-background.so')
    yield ROOT / 'build/codex-background.so'


def ensure_loaded():
    abi = hyprctl.query('version')['abiHash']
    module, expected = ensure_built(abi)
    instance = os.environ.get('HYPRLAND_INSTANCE_SIGNATURE', 'unknown')
    locks = lock_dir()
    locks.mkdir(parents=True, exist_ok=True)
    lock = locks / ('load-' + instance.replace('/', '_') + '.lock')
    with contextlib.ExitStack() as stack:
        compiler = stack.enter_context((locks / 'compile.lock').open('a'))
        fcntl.flock(compiler, fcntl.LOCK_SH)
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
            for path in loaded_candidates(module):
                with contextlib.suppress(RuntimeError):
                    if hyprctl._run('plugin', 'unload', str(path)).strip() == 'ok':
                        break
            else:
                raise RuntimeError('Cannot unload the old native provider; restart Hyprland.')
        result = hyprctl._run('plugin', 'load', str(module))
        current = status()
        if not current or current.get('build') != expected:
            raise RuntimeError('Cannot load the native provider for this Hyprland session. ' + result)
        return current
