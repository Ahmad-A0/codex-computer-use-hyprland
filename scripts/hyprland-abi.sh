#!/bin/sh
# Print the plugin ABI hash of the installed Hyprland headers, in the format of
# __hyprland_api_get_client_hash(): commit plus dependency major.minor versions.
set -eu
header=${HYPRLAND_VERSION_HEADER:-/usr/include/hyprland/src/version.h}
value() { sed -n "s/^#define $1 *\"\\(.*\\)\"/\\1/p" "$header"; }
minor() { value "$1" | sed 's/\.[^.]*$//'; }
printf '%s_aq_%s_hu_%s_hg_%s_hc_%s_hlg_%s\n' "$(value GIT_COMMIT_HASH)" \
  "$(minor AQUAMARINE_VERSION)" "$(minor HYPRUTILS_VERSION)" \
  "$(minor HYPRGRAPHICS_VERSION)" "$(minor HYPRCURSOR_VERSION)" "$(minor HYPRLANG_VERSION)"
