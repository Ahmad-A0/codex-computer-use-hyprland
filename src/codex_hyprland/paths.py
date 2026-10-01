"""Locate provider files in a git checkout or the system package.

A checkout (its root has pyproject.toml) keeps generated files in build/ and runs
from .venv. The package installs read-only files under /usr/lib/NAME and keeps
per-user builds in ${XDG_CACHE_HOME:-~/.cache}/NAME and locks in
$XDG_RUNTIME_DIR/NAME. scripts/paths.sh and scripts/paths.mjs mirror these rules;
CODEX_HYPRLAND_CACHE_DIR overrides the cache directory in all three.
"""
import os
from pathlib import Path
import sys

NAME = 'codex-computer-use-hyprland'
PACKAGE_ROOT = Path('/usr/lib') / NAME


def project_root():
    configured = os.environ.get('CODEX_HYPRLAND_ROOT')
    candidates = [Path(configured)] if configured else [
        Path(__file__).resolve().parents[2], Path(sys.prefix).parent, PACKAGE_ROOT,
    ]
    for path in candidates:
        if (path / 'bin/sky-hyprland').is_file() and (path / 'scripts/launch.mjs').is_file():
            return path.resolve()
    raise RuntimeError('Cannot locate provider assets; set CODEX_HYPRLAND_ROOT to the installation directory.')


def is_checkout(root=None):
    return ((root or project_root()) / 'pyproject.toml').is_file()


def _xdg(variable, fallback):
    value = os.environ.get(variable, '')
    return Path(value) if os.path.isabs(value) else fallback


def cache_dir():
    """Writable per-user builds: native/<abi>/, runtime/<hash>/ and, in a checkout, X11 helpers."""
    if os.environ.get('CODEX_HYPRLAND_CACHE_DIR'):
        return Path(os.environ['CODEX_HYPRLAND_CACHE_DIR'])
    root = project_root()
    if is_checkout(root):
        return root / 'build'
    return _xdg('XDG_CACHE_HOME', Path.home() / '.cache') / NAME


def lock_dir():
    if is_checkout():
        return cache_dir()
    runtime = _xdg('XDG_RUNTIME_DIR', None)
    return runtime / NAME if runtime else cache_dir()


def helper(name):
    """An ABI-independent X11 helper: built into the checkout cache, shipped by the package."""
    root = project_root()
    return (cache_dir() if is_checkout(root) else root) / name
