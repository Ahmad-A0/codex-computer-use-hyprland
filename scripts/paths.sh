# Sourced by shell entry points with $project_dir set; mirrors
# src/codex_hyprland/paths.py. A checkout (pyproject.toml present) keeps
# generated files in build/ and runs from .venv; the system package keeps
# per-user builds in the XDG cache and locks in $XDG_RUNTIME_DIR.
codex_hyprland_name=codex-computer-use-hyprland
if [ -f "$project_dir/pyproject.toml" ]; then
  checkout=1
  cache_dir=${CODEX_HYPRLAND_CACHE_DIR:-$project_dir/build}
  lock_dir=$cache_dir
  helper_dir=$cache_dir
  python_bin=$project_dir/.venv/bin/python
else
  checkout=
  case "${XDG_CACHE_HOME:-}" in
    /*) cache_dir=${CODEX_HYPRLAND_CACHE_DIR:-$XDG_CACHE_HOME/$codex_hyprland_name} ;;
    *) cache_dir=${CODEX_HYPRLAND_CACHE_DIR:-$HOME/.cache/$codex_hyprland_name} ;;
  esac
  case "${XDG_RUNTIME_DIR:-}" in
    /*) lock_dir=$XDG_RUNTIME_DIR/$codex_hyprland_name ;;
    *) lock_dir=$cache_dir ;;
  esac
  helper_dir=$project_dir
  python_bin=/usr/bin/python3
fi
