#!/bin/sh
# Keep a checkout installation on the latest release. Releases are cut only from
# commits that passed the end-to-end suite on main, so a dedicated clone that
# follows them runs tested code while a development checkout stays free for
# branches. Fetches tags, checks out the newest v* release detached and
# reinstalls (./install) when it changed; an unchanged release does nothing.
#   scripts/update.sh            update now
#   scripts/update.sh --enable   also install and start an hourly user timer
#   scripts/update.sh --disable  stop and remove that timer
set -eu
# The checkout below replaces this file: read it whole before running it.
{
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"
units=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
unit=codex-hyprland-update
case "${1:-}" in
  '') ;;
  --enable)
    mkdir -p "$units"
    cp systemd/$unit.timer "$units/"
    sed "s|@ROOT@|$project_dir|" systemd/$unit.service > "$units/$unit.service"
    systemctl --user daemon-reload
    systemctl --user enable --now $unit.timer >/dev/null 2>&1
    echo "Hourly updates enabled for $project_dir ($unit.timer)." ;;
  --disable)
    systemctl --user disable --now $unit.timer >/dev/null 2>&1 || true
    rm -f "$units/$unit.timer" "$units/$unit.service"
    systemctl --user daemon-reload
    echo "Hourly updates disabled."; exit 0 ;;
  *) echo 'Usage: scripts/update.sh [--enable|--disable]' >&2; exit 2 ;;
esac

# Never move a working copy that someone is developing in.
if branch=$(git symbolic-ref -q --short HEAD); then
  echo "This checkout is on branch $branch; updates follow releases in a dedicated clone" >&2
  echo "(git clone $(git remote get-url origin) ~/.local/share/codex-computer-use-hyprland)." >&2
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo 'This checkout has local changes; not updating.' >&2
  exit 1
fi

git fetch -q --tags --force origin
latest=$(git tag -l 'v[0-9]*' --sort=-v:refname | head -1)
[ -n "$latest" ] || { echo 'No release tags found.' >&2; exit 1; }
installed=$(cat build/installed-release 2>/dev/null || true)
if [ "$installed" = "$latest" ] && [ "$(git rev-parse HEAD)" = "$(git rev-parse "$latest^{commit}")" ]; then
  echo "Up to date ($latest)."
  exit 0
fi
echo "Updating ${installed:-checkout} -> $latest"
git -c advice.detachedHead=false checkout -q --detach "$latest"
./install
mkdir -p build
echo "$latest" > build/installed-release
exit
}
