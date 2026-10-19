#!/usr/bin/env bash
# Allocate the next RFC number and copy the template.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RFC_DIR="$ROOT/docs/rfcs"
slug="${1:-}"
if [[ -z "$slug" ]]; then
  echo "usage: scripts/new-rfc.sh short-slug" >&2
  exit 2
fi
if [[ ! "$slug" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "slug must be lowercase kebab-case" >&2
  exit 2
fi

# Numbers are global across every branch, not just this checkout.
# Fetch first so a number claimed on someone else's branch is seen.
git -C "$ROOT" fetch --quiet --prune origin 2>/dev/null \
  || echo "warning: git fetch origin failed; numbers on unfetched branches are not seen" >&2

next=63   # 000-062 are allocated (some kept in a private repo; 062 is reserved by RFC-061)
while read -r name; do
  [[ "$name" =~ ^[0-9]{3}- ]] || continue
  n=$((10#${name:0:3}))
  if (( n >= next )); then next=$((n + 1)); fi
done < <(
  ls "$RFC_DIR"
  git -C "$ROOT" for-each-ref --format='%(refname)' refs/heads refs/remotes/origin \
    | while read -r ref; do git -C "$ROOT" ls-tree --name-only "$ref" docs/rfcs/ 2>/dev/null; done \
    | xargs -n1 basename 2>/dev/null
)
nnn="$(printf '%03d' "$next")"
dest="$RFC_DIR/${nnn}-${slug}.md"
if [[ -e "$dest" ]]; then
  echo "already exists: $dest" >&2
  exit 1
fi
today="$(date +%F)"
branch="rfc-${nnn}-${slug}"
awk -v nnn="$nnn" -v slug="$slug" -v today="$today" -v branch="$branch" '
  NR==1 { print "# RFC-" nnn " — Title"; next }
  /^\*\*Status:\*\*/ { print "**Status:** Draft"; next }
  /^\*\*Date:\*\*/ { print "**Date:** " today; next }
  /^\*\*Branch:\*\*/ { print "**Branch:** " branch; next }
  { print }
' "$RFC_DIR/_template.md" > "$dest"

echo "Wrote $dest"
echo "Branch: $branch"
echo "Add a row to docs/rfcs/README.md, then:"
echo "  git checkout -b $branch"
