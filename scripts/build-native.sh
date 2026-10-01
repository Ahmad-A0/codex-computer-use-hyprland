#!/bin/sh
# Build the compositor plugin for the installed Hyprland headers, cached per
# plugin ABI under build/native/<abi>/, plus the ABI-independent X11 helpers.
# A running older Hyprland keeps its own cached build until the next login.
set -eu
export LC_ALL=C  # stable glob order; build IDs are hashed in this order
cd "$(dirname "$0")/.."
mkdir -p build/native
# Serialize both explicit builds and lifecycle reloads.
exec 9>build/compile.lock
flock 9

# Wait for an in-progress pacman transaction, so headers are complete.
waited=0
while [ -e /var/lib/pacman/db.lck ] && [ "$waited" -lt 600 ]; do
  sleep 2; waited=$((waited + 2))
done

abi=$(./scripts/hyprland-abi.sh)
out="build/native/$abi"
build_id=$({ printf '%s\n' "$abi"; cat native/*.cpp native/*.hpp; } | sha256sum | cut -d ' ' -f 1)
helpers_id=$(cat native/x11.cpp native/xclipboard.cpp native/*.hpp | sha256sum | cut -d ' ' -f 1)
mkdir -p "$out"
trap 'rm -f "$out/codex-background.so.new" build/codex-x11.new build/codex-xclipboard.new' EXIT

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

if [ "$(cat build/helpers-id 2>/dev/null)" != "$helpers_id" ] || [ ! -x build/codex-x11 ] || [ ! -x build/codex-xclipboard ]; then
  c++ -std=c++23 -O2 -Wall -Wextra $(pkg-config --cflags x11 xi xtst xcomposite json-c) native/x11.cpp -o build/codex-x11.new $(pkg-config --libs x11 xi xtst xcomposite json-c)
  c++ -std=c++23 -O2 -Wall -Wextra $(pkg-config --cflags x11 xres json-c) native/xclipboard.cpp -o build/codex-xclipboard.new $(pkg-config --libs x11 xres json-c)
  mv build/codex-xclipboard.new build/codex-xclipboard
  mv build/codex-x11.new build/codex-x11
  printf '%s\n' "$helpers_id" > build/helpers-id
fi
echo "$out/codex-background.so"
