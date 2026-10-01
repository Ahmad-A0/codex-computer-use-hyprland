#!/bin/sh
# Print the newest upstream versions this provider must keep working with:
# OpenAI's ChatGPT/Codex desktop package (ships the computer-use runtime) and
# Arch's Hyprland. Output: {"chatgpt-bin":"…","hyprland":"…"}
set -eu
hyprland=$(curl -fsS https://archlinux.org/packages/extra/x86_64/hyprland/json/ |
  python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["pkgver"] + "-" + d["pkgrel"])')
chatgpt=$(curl -fsS https://persistent.oaistatic.com/codex-app-prod/linux/arch/x86_64/openai-chatgpt.db |
  tar -xzO --wildcards '*/desc' | awk '/^%NAME%$/{getline; n=$0} /^%VERSION%$/{getline; if (n=="chatgpt-bin") print}')
[ -n "$hyprland" ] && [ -n "$chatgpt" ] || { echo 'upstream lookup failed' >&2; exit 1; }
printf '{"chatgpt-bin":"%s","hyprland":"%s"}\n' "$chatgpt" "$hyprland"
