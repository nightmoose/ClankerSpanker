#!/usr/bin/env bash
# Allocate the next RFC number and copy the template.
# Refuses to reuse a number that any branch, index row, or promise already owns.
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

# Numbers are global. If fetch fails, a taken number on an unfetched branch
# would be invisible, so refuse rather than guess.
if ! git -C "$ROOT" fetch --quiet --prune origin; then
  echo "refusing to allocate: git fetch origin failed, so a number taken on another branch might be reused" >&2
  exit 1
fi

nnn="$(python3 "$ROOT/scripts/rfc_alloc.py" --root "$ROOT")" || {
  echo "refusing to allocate an RFC number" >&2
  exit 1
}
if [[ ! "$nnn" =~ ^[0-9]{3}$ ]]; then
  echo "refusing to allocate: allocator returned '$nnn'" >&2
  exit 1
fi

# The number is taken if any file already uses it, whatever the slug is.
shopt -s nullglob
existing=( "$RFC_DIR"/${nnn}-*.md )
shopt -u nullglob
if (( ${#existing[@]} > 0 )); then
  echo "refusing to reuse RFC-${nnn}: ${existing[*]}" >&2
  exit 1
fi

dest="$RFC_DIR/${nnn}-${slug}.md"
if [[ -e "$dest" ]]; then
  echo "refusing to reuse RFC-${nnn}: $dest already exists" >&2
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

# Re-check after the write so two allocators cannot both land the same number.
shopt -s nullglob
again=( "$RFC_DIR"/${nnn}-*.md )
shopt -u nullglob
if (( ${#again[@]} != 1 )); then
  rm -f "$dest"
  echo "refusing to reuse RFC-${nnn}: another file appeared (${again[*]})" >&2
  exit 1
fi

echo "Wrote $dest"
echo "Branch: $branch"
echo "Add a row to docs/rfcs/README.md, then:"
echo "  git checkout -b $branch"
