#!/bin/sh
# Guest side of the end-to-end VM, run as root: install what a user would on
# Arch (Hyprland, the provider's prerequisites, test apps, ChatGPT/Codex) and
# start a real Hyprland session for USER through tty1 autologin.
set -eu
user=${1:-tester}
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fingerprint=3BFA0E4AE8B8CC16A2D9BA684A3B4A566C4660E4

# OpenAI's signed repository provides chatgpt-bin and its cua_node runtime.
fpr=$(gpg --batch --show-keys --with-colons "$here/openai-chatgpt.gpg" | awk -F: '$1 == "fpr" { print $10; exit }')
[ "$fpr" = "$fingerprint" ] || { echo "OpenAI key fingerprint mismatch: $fpr" >&2; exit 1; }
pacman-key --init >/dev/null 2>&1
pacman-key --populate archlinux >/dev/null 2>&1
pacman-key --add "$here/openai-chatgpt.gpg" >/dev/null 2>&1
pacman-key --lsign-key "$fingerprint" >/dev/null 2>&1
grep -q '^\[openai-chatgpt\]' /etc/pacman.conf || cat >> /etc/pacman.conf <<'EOF'

[openai-chatgpt]
SigLevel = Required DatabaseRequired TrustedOnly
Server = https://persistent.oaistatic.com/codex-app-prod/linux/arch/$arch
EOF
sed -i 's/^#\?ParallelDownloads.*/ParallelDownloads = 10/' /etc/pacman.conf

pacman -Sy --noconfirm --needed --noprogressbar archlinux-keyring
# Keep the running kernel's modules: no reboot happens before the tests.
pacman -Su --noconfirm --needed --noprogressbar --ignore linux \
  hyprland xorg-xwayland mesa grim wl-clipboard uv \
  python-gobject at-spi2-core python-pillow \
  base-devel pkgconf json-c libxkbcommon libx11 libxi libxtst libxcomposite libxres libxfixes \
  gtk3 python-pyqt6 chromium foot ttf-dejavu nodejs npm chatgpt-bin
npm install -g --silent @openai/codex

home=$(getent passwd "$user" | cut -d: -f6)
install -d -o "$user" -g "$user" "$home/.config" "$home/.config/hypr"
install -m 644 -o "$user" -g "$user" "$here/hyprland.lua" "$home/.config/hypr/hyprland.lua"
grep -q start-hyprland "$home/.bash_profile" 2>/dev/null || cat >> "$home/.bash_profile" <<'EOF'
if [ -z "${WAYLAND_DISPLAY:-}" ] && [ "$(tty)" = /dev/tty1 ]; then
  exec start-hyprland > "$HOME/hyprland.out" 2>&1
fi
EOF
chown "$user:$user" "$home/.bash_profile"

mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf <<EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty -o '-p -f -- \\\\u' --noclear --autologin $user %I \$TERM
EOF
systemctl daemon-reload
systemctl restart getty@tty1
