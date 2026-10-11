#!/bin/sh
# Publish the next release at COMMIT (tested by RUN_URL) if anything users
# install changed since the last release. Tests, CI, docs and upstream.json
# records alone do not make a release. Prints the new tag, or nothing.
set -eu
commit=$1 run=$2
# Paths that do not change what users install.
set -- . ':!tests' ':!.github' ':!docs' ':!upstream.json' ':!AGENTS.md' ':!README.md' ':!.gitignore' ':!scripts/release'
last=$(gh release list --exclude-drafts --limit 1 --json tagName --jq '.[0].tagName // ""')
if [ -z "$last" ]; then
  version=v$(python3 -c 'import tomllib; print(tomllib.load(open("pyproject.toml","rb"))["project"]["version"])')
  range=$commit
else
  version=$(echo "$last" | awk -F. -v OFS=. '{ $NF += 1; print }')
  range=$last..$commit
fi
if [ -n "$last" ] && [ -z "$(git log --format=%h "$range" -- "$@")" ]; then
  echo "Nothing users install changed since $last; no release." >&2
  exit 0
fi
notes=$(mktemp)
{
  echo '## Changes'
  git log --no-merges --format='- %s' "$range" -- "$@" | grep -v '^- Tested with ' | head -100
  echo
  echo '## Tested with'
  # VERSIONS (JSON from the end-to-end run) overrides the upstream.json record.
  python3 -c 'import json, os; v=json.loads(os.environ.get("VERSIONS") or "null") or json.load(open("upstream.json"))["tested"].get("versions", {}); print("\n".join(f"- {k} {x}" for k, x in v.items()) or "- (no upstream record yet)")'
  echo
  echo "End-to-end run: $run"
} > "$notes"
# Older drafts (from the manual-approval era) are superseded.
for draft in $(gh release list --json tagName,isDraft --jq '.[] | select(.isDraft) | .tagName'); do
  gh release delete "$draft" --yes >&2
done
gh release create "$version" --target "$commit" --title "$version" --notes-file "$notes" --latest >&2
echo "$version"
