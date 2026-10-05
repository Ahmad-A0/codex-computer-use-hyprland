#!/bin/sh
# Run every few minutes on an always-on machine (systemd timer in this
# directory). When OpenAI's chatgpt-bin or Arch's hyprland differs from the
# versions main last tested (upstream.json), trigger watch-upstream once for
# that combination. GitHub's own schedule stays as a daily fallback.
set -eu
repo=${REPO:-Ahmad-A0/codex-computer-use-hyprland}
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
state=${XDG_STATE_HOME:-$HOME/.local/state}/codex-hyprland-poll
mkdir -p "$state"
canon() { python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin), separators=(",", ":"), sort_keys=True))'; }

latest=$("$here/upstream.sh" | canon)
tested=$(gh api "repos/$repo/contents/upstream.json" -H 'Accept: application/vnd.github.raw' |
  python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["tested"].get("versions", {})))' | canon)
if [ "$latest" = "$tested" ]; then
  rm -f "$state/triggered"
  exit 0
fi
# Trigger once per new combination: a failing one opens an issue and the fix
# agent; re-triggering it every few minutes would only repeat that.
if [ "$latest" = "$(cat "$state/triggered" 2>/dev/null)" ]; then
  exit 0
fi
echo "upstream changed: tested $tested, latest $latest; triggering watch-upstream"
gh workflow run watch-upstream.yml -R "$repo"
printf '%s\n' "$latest" > "$state/triggered"
