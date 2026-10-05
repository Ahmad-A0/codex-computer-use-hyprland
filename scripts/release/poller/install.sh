#!/bin/sh
# Install the upstream poller as a user timer on HOST (default: this machine).
# Needs curl, python3, tar and gh logged in with the repo and workflow scopes
# there; `loginctl enable-linger` keeps it running without a login session.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
host=${1:-}
run() { if [ -n "$host" ]; then ssh "$host" "$@"; else sh -c "$*"; fi; }
copy() { if [ -n "$host" ]; then scp -q "$@"; else cp "$@"; fi; }
dest() { if [ -n "$host" ]; then echo "$host:$1"; else echo "$1"; fi; }
lib='.local/lib/codex-hyprland-poll' units='.config/systemd/user'
run "mkdir -p \$HOME/$lib \$HOME/$units"
home=$(run 'printf %s "$HOME"')
copy "$here/poll-upstream.sh" "$here/../upstream.sh" "$(dest "$home/$lib/")"
copy "$here/codex-hyprland-poll.service" "$here/codex-hyprland-poll.timer" "$(dest "$home/$units/")"
run "chmod +x \$HOME/$lib/*.sh && systemctl --user daemon-reload && systemctl --user enable --now codex-hyprland-poll.timer && systemctl --user list-timers codex-hyprland-poll.timer --no-pager"
