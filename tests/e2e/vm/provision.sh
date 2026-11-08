#!/bin/sh
# Guest side of the end-to-end VM, run as root: install what a user would on
# Arch (Hyprland, the provider's prerequisites, test apps, ChatGPT/Codex), set
# up a Hyprland session for USER through tty1 autologin from the next boot, and
# clean up so the disk can be cached.
#   provision.sh USER [release | git COMMIT]
# git replaces Arch's Hyprland with its development branch at COMMIT
# (hyprland-git.sh).
set -eu
user=${1:-tester}
variant=${2:-release}
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
# The cloud image's single mirror sometimes stalls; pacman falls back in order.
cat >> /etc/pacman.d/mirrorlist <<'EOF'
Server = https://geo.mirror.pkgbuild.com/$repo/os/$arch
Server = https://mirror.rackspace.com/archlinux/$repo/os/$arch
Server = https://mirrors.kernel.org/archlinux/$repo/os/$arch
EOF
# Retries resume where a stalled download left off.
retry() { for n in 1 2 3; do "$@" && return; echo "retrying ($n): $*" >&2; sleep 10; done; "$@"; }

retry pacman -Sy --noconfirm --needed --noprogressbar archlinux-keyring
# Keep the running kernel's modules: no reboot happens before the tests.
retry pacman -Su --noconfirm --needed --noprogressbar --ignore linux \
  hyprland xorg-xwayland mesa grim wl-clipboard uv \
  python-gobject at-spi2-core python-pillow \
  base-devel pkgconf json-c libxkbcommon libx11 libxi libxtst libxcomposite libxres libxfixes \
  gtk3 python-pyqt6 chromium foot ttf-dejavu nodejs npm chatgpt-bin \
  gnome-text-editor mousepad featherpad gnome-calculator firefox xterm wtype \
  nautilus libreoffice-fresh git
retry npm install -g --silent @openai/codex
if [ "$variant" = git ]; then sh "$here/hyprland-git.sh" "$3"; fi

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

# No xdg-desktop-portal: GTK file choosers stay in-process.
rm -rf /var/cache/pacman/pkg/* /root/.npm
cloud-init clean --logs
# Commit the deletions first: btrfs trims only space a committed transaction freed.
sync
fstrim -a
df -h /
