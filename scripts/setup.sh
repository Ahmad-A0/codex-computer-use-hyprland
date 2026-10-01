#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"
python_bin=${HYPRLAND_PYTHON:-/usr/bin/python3}
"$python_bin" -c 'import gi; gi.require_version("Atspi", "2.0"); from gi.repository import Atspi, Gio; from PIL import Image'
command -v uv >/dev/null || { echo 'Missing: uv' >&2; exit 1; }
# Recreate only this generated environment when its interpreter or bindings
# change. uv handles the locked package installation below.
if [ ! -x .venv/bin/python ] || ! .venv/bin/python -c '
import os,sys
assert os.path.realpath(sys._base_executable) == os.path.realpath(sys.argv[1])
import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, Gio
from PIL import Image
' "$python_bin"; then
  uv venv --clear --python "$python_bin" --system-site-packages --no-managed-python .venv
fi
export UV_PROJECT_ENVIRONMENT="$project_dir/.venv"
# The project version does not change with its sources; always reinstall it.
uv sync --locked --no-editable --no-dev --python "$python_bin" --no-managed-python \
  --reinstall-package codex-computer-use-hyprland
