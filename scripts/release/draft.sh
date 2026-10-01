#!/bin/sh
# Create or replace the single draft release for COMMIT (tested by RUN_URL).
set -eu
commit=$1 run=$2
last=$(gh release list --exclude-drafts --limit 1 --json tagName --jq '.[0].tagName // ""')
if [ -z "$last" ]; then
  version=v$(python3 -c 'import tomllib; print(tomllib.load(open("pyproject.toml","rb"))["project"]["version"])')
  range=$commit
else
  version=$(echo "$last" | awk -F. -v OFS=. '{ $NF += 1; print }')
  range=$last..$commit
fi
if [ -n "$last" ] && [ -z "$(git log --format=%h "$range" -- . ':!upstream.json')" ]; then
  echo "No changes since $last; no draft needed."
  exit 0
fi
notes=$(mktemp)
{
  echo '## Changes'
  git log --no-merges --format='- %s' "$range" -- . ':!upstream.json' | head -100
  echo
  echo '## Tested with'
  python3 -c 'import json; t=json.load(open("upstream.json"))["tested"]; v=t.get("versions", {}); print("\n".join(f"- {k} {x}" for k, x in v.items()) or "- (no upstream record yet)")'
  echo
  echo "End-to-end run: $run"
} > "$notes"
for draft in $(gh release list --json tagName,isDraft --jq '.[] | select(.isDraft) | .tagName'); do
  gh release delete "$draft" --yes
done
gh release create "$version" --draft --target "$commit" --title "$version" --notes-file "$notes"
echo "Drafted $version at $commit"
