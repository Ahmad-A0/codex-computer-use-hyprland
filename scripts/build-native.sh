#!/bin/sh
# Build the compositor plugin for the installed Hyprland headers, cached per
# plugin ABI under <cache>/native/<abi>/ (build/ in a checkout, the XDG cache for
# the package; see scripts/paths.sh). A checkout also builds the ABI-independent
# X11 helpers there; the package ships them. A running older Hyprland keeps its
# own cached build until the next login.
#   build-native.sh                 build for the installed headers
#   build-native.sh --helpers DIR   build only the X11 helpers into DIR (packaging)
set -eu
export LC_ALL=C  # stable glob order; build IDs are hashed in this order
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"
. "$project_dir/scripts/paths.sh"

build_helpers() {
  c++ -std=c++23 -O2 -Wall -Wextra $extra_cxxflags $(pkg-config --cflags x11 xi xtst xcomposite json-c) native/x11.cpp -o "$1/codex-x11.new" $extra_ldflags $(pkg-config --libs x11 xi xtst xcomposite json-c)
  c++ -std=c++23 -O2 -Wall -Wextra $extra_cxxflags $(pkg-config --cflags x11 xres xfixes json-c) native/xclipboard.cpp -o "$1/codex-xclipboard.new" $extra_ldflags $(pkg-config --libs x11 xres xfixes json-c)
  mv "$1/codex-xclipboard.new" "$1/codex-xclipboard"
  mv "$1/codex-x11.new" "$1/codex-x11"
}

extra_cxxflags= extra_ldflags=
if [ "${1:-}" = --helpers ]; then
  # Packaging honours the distribution's CPPFLAGS/CXXFLAGS/LDFLAGS (hardening).
  extra_cxxflags="${CPPFLAGS:-} ${CXXFLAGS:-}" extra_ldflags=${LDFLAGS:-}
  mkdir -p "$2"
  build_helpers "$2"
  exit
fi

mkdir -p "$cache_dir/native" "$lock_dir"
# Serialize both explicit builds and lifecycle reloads.
exec 9>"$lock_dir/compile.lock"
flock 9

# Wait for an in-progress pacman transaction, so headers are complete.
waited=0
while [ -e /var/lib/pacman/db.lck ] && [ "$waited" -lt 600 ]; do
  sleep 2; waited=$((waited + 2))
done

abi=$(./scripts/hyprland-abi.sh)
out="$cache_dir/native/$abi"
build_id=$({ printf '%s\n' "$abi"; cat native/*.cpp native/*.hpp; } | sha256sum | cut -d ' ' -f 1)
helpers_id=$(cat native/x11.cpp native/xclipboard.cpp native/*.hpp | sha256sum | cut -d ' ' -f 1)
mkdir -p "$out"
trap 'rm -f "$out/codex-background.so.new" "$helper_dir/codex-x11.new" "$helper_dir/codex-xclipboard.new"' EXIT

if [ "$(cat "$out/build-id" 2>/dev/null)" != "$build_id" ]; then
  c++ -std=c++23 -O2 -shared -fPIC -fno-gnu-unique -Wall -Wextra \
    "-DCODEX_BUILD_ID=\"$build_id\"" \
    $(pkg-config --cflags hyprland pixman-1 libdrm libinput libudev xkbcommon json-c) \
    native/background.cpp -o "$out/codex-background.so.new" \
    $(pkg-config --libs xkbcommon json-c)
  # Never truncate a shared library a compositor may have mapped.
  mv "$out/codex-background.so.new" "$out/codex-background.so"
  printf '%s\n' "$build_id" > "$out/build-id.new"
  mv "$out/build-id.new" "$out/build-id"
fi

if [ -n "$checkout" ] && { [ "$(cat "$helper_dir/helpers-id" 2>/dev/null)" != "$helpers_id" ] || [ ! -x "$helper_dir/codex-x11" ] || [ ! -x "$helper_dir/codex-xclipboard" ]; }; then
  build_helpers "$helper_dir"
  printf '%s\n' "$helpers_id" > "$helper_dir/helpers-id"
fi
echo "$out/codex-background.so"
