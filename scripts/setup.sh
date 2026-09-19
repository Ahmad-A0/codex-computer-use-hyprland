#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"
python_bin=${HYPRLAND_PYTHON:-/usr/bin/python3}
"$python_bin" -c 'import gi; gi.require_version("Atspi", "2.0"); from gi.repository import Atspi, Gio; from PIL import Image'
for tool in hyprctl grim uv; do
  command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }
done
if [ ! -x .venv/bin/python ]; then
  uv venv --python "$python_bin" --system-site-packages .venv
fi
.venv/bin/python -c 'import gi; gi.require_version("Atspi", "2.0"); from gi.repository import Atspi, Gio; from PIL import Image'
uv pip install --python .venv/bin/python -e .
.venv/bin/sky-hyprland doctor
