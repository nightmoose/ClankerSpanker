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

next=0
for f in "$RFC_DIR"/[0-9][0-9][0-9]-*.md; do
  [[ -e "$f" ]] || continue
  n=$((10#$(basename "$f" | cut -c1-3)))
  if (( n >= next )); then next=$((n + 1)); fi
done
nnn="$(printf '%03d' "$next")"
dest="$RFC_DIR/${nnn}-${slug}.md"
if [[ -e "$dest" ]]; then
  echo "already exists: $dest" >&2
  exit 1
fi
today="$(date +%F)"
branch="nightly-maintenance-${today}-rfc${nnn}-${slug}"
awk -v nnn="$nnn" -v slug="$slug" -v today="$today" -v branch="$branch" '
  NR==1 { print "# RFC-" nnn " — Title"; next }
  /^\*\*Status:\*\*/ { print "**Status:** Draft"; next }
  /^\*\*Date:\*\*/ { print "**Date:** " today; next }
  /^\*\*Branch:\*\*/ { print "**Branch:** " branch; next }
  { print }
' "$RFC_DIR/_template.md" > "$dest"

echo "Wrote $dest"
echo "Branch: $branch"
echo "Add a row to docs/STATUS.md, then:"
echo "  git checkout -b $branch"
