#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p build
# Serialize both explicit builds and lifecycle reloads.
exec 9>build/compile.lock
flock 9
build_id=$(cat native/*.cpp native/*.hpp /usr/include/hyprland/src/version.h | sha256sum | cut -d ' ' -f 1)
trap 'rm -f build/codex-background.so.new build/codex-x11.new build/codex-xclipboard.new' EXIT
c++ -std=c++23 -O2 -shared -fPIC -fno-gnu-unique -Wall -Wextra \
  "-DCODEX_BUILD_ID=\"$build_id\"" \
  $(pkg-config --cflags hyprland pixman-1 libdrm libinput libudev xkbcommon json-c) \
  native/background.cpp -o build/codex-background.so.new \
  $(pkg-config --libs xkbcommon json-c)
c++ -std=c++23 -O2 -Wall -Wextra $(pkg-config --cflags x11 xi xtst xcomposite json-c) native/x11.cpp -o build/codex-x11.new $(pkg-config --libs x11 xi xtst xcomposite json-c)
c++ -std=c++23 -O2 -Wall -Wextra $(pkg-config --cflags x11 xres json-c) native/xclipboard.cpp -o build/codex-xclipboard.new $(pkg-config --libs x11 xres json-c)
# Publish only when all compiles succeed; never truncate a mapped shared library.
mv build/codex-xclipboard.new build/codex-xclipboard
mv build/codex-x11.new build/codex-x11
mv build/codex-background.so.new build/codex-background.so
printf '%s\n' "$build_id" > build/native-build-id.new
mv build/native-build-id.new build/native-build-id
