"""Locate project assets from a source checkout or its installed environment."""
import os
from pathlib import Path
import sys


def project_root():
    configured = os.environ.get('CODEX_HYPRLAND_ROOT')
    candidates = [Path(configured)] if configured else [
        Path(__file__).resolve().parents[2], Path(sys.prefix).parent,
    ]
    for path in candidates:
        if (path / 'bin/sky-hyprland').is_file() and (path / 'pyproject.toml').is_file():
            return path.resolve()
    raise RuntimeError('Cannot locate provider assets; set CODEX_HYPRLAND_ROOT to the installation directory.')
