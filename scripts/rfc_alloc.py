#!/usr/bin/env python3
"""Pick the next RFC number and refuse to reuse one that is already taken.

Numbers are global: this checkout, every local and origin branch, branch
names, the index, and an explicit "RFC-NNN will…" promise. Gaps are not
filled. The candidate is max(taken)+1. If that candidate is already taken,
this exits 1 instead of writing it.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

RFC_FILE = re.compile(r"^(\d{3})-[a-z0-9][a-z0-9.-]*\.md$")
BRANCH_NUM = re.compile(r"rfc-?(\d{3})(?:[^0-9]|$)", re.IGNORECASE)
INDEX_ROW = re.compile(r"^\|\s*(\d{3})\s*\|")
PROMISE = re.compile(r"RFC-(\d{3})\s+will\b", re.IGNORECASE)


def git(root: Path, args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(root), *args],
        text=True,
        capture_output=True,
    )


def filenames_from_listing(names: list[str]) -> dict[int, set[str]]:
    """Map a number to the RFC filenames that claim it."""
    found: dict[int, set[str]] = {}
    for name in names:
        base = Path(name).name
        m = RFC_FILE.match(base)
        if not m:
            continue
        found.setdefault(int(m.group(1)), set()).add(base)
    return found


def local_rfc_names(rfc_dir: Path) -> list[str]:
    if not rfc_dir.is_dir():
        return []
    return [p.name for p in rfc_dir.iterdir() if p.is_file()]


def ref_rfc_names(root: Path) -> list[str]:
    refs = git(root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"])
    if refs.returncode != 0:
        return []
    names: list[str] = []
    for ref in refs.stdout.splitlines():
        if ref.endswith("/HEAD"):
            continue
        listed = git(root, ["ls-tree", "--name-only", ref, "docs/rfcs/"])
        if listed.returncode != 0:
            continue
        names.extend(listed.stdout.splitlines())
        m = BRANCH_NUM.search(ref)
        if m:
            # A branch name owns the number even before the file exists.
            names.append(f"{int(m.group(1)):03d}-branch-claim.md")
    return names


def index_numbers(index: Path) -> list[str]:
    if not index.is_file():
        return []
    names: list[str] = []
    for line in index.read_text(errors="replace").splitlines():
        m = INDEX_ROW.match(line)
        if m:
            names.append(f"{m.group(1)}-index-claim.md")
    return names


def promise_numbers(rfc_dir: Path) -> list[str]:
    if not rfc_dir.is_dir():
        return []
    names: list[str] = []
    for path in rfc_dir.glob("*.md"):
        try:
            text = path.read_text(errors="replace")
        except OSError:
            continue
        for m in PROMISE.finditer(text):
            names.append(f"{m.group(1)}-promised.md")
    return names


def claims(root: Path) -> dict[int, set[str]]:
    rfc_dir = root / "docs" / "rfcs"
    names = (
        local_rfc_names(rfc_dir)
        + ref_rfc_names(root)
        + index_numbers(rfc_dir / "README.md")
        + promise_numbers(rfc_dir)
    )
    return filenames_from_listing(names)


def _synthetic(name: str) -> bool:
    return name.endswith(("-branch-claim.md", "-index-claim.md", "-promised.md"))


def real_collisions(claimed: dict[int, set[str]]) -> list[str]:
    """Two different on-disk RFC filenames for one number.

    Synthetic claim names (branch, index, promise) are not filenames.
    """
    errors: list[str] = []
    for num, names in sorted(claimed.items()):
        files = sorted(n for n in names if n.endswith(".md") and not _synthetic(n))
        if len(files) > 1:
            errors.append(f"RFC-{num:03d} is used by more than one file: {', '.join(files)}")
    return errors


def taken_numbers(claimed: dict[int, set[str]]) -> set[int]:
    return set(claimed)


def next_number(taken: set[int]) -> int:
    """Smallest integer above every taken number. Does not fill gaps."""
    if not taken:
        return 0
    return max(taken) + 1


def allocate(root: Path) -> tuple[int, list[str]]:
    claimed = claims(root)
    collisions = real_collisions(claimed)
    if collisions:
        return -1, collisions
    taken = taken_numbers(claimed)
    n = next_number(taken)
    if n in taken:
        return -1, [f"refusing to reuse RFC-{n:03d}"]
    return n, []


def main(argv: list[str]) -> int:
    root = Path.cwd()
    if "--root" in argv:
        root = Path(argv[argv.index("--root") + 1]).resolve()
    n, errors = allocate(root)
    if errors or n < 0:
        for err in errors:
            print(err, file=sys.stderr)
        print("refusing to allocate a number", file=sys.stderr)
        return 1
    # Re-read once so a file that appeared during the scan cannot slip through.
    taken = taken_numbers(claims(root))
    if n in taken:
        print(f"refusing to reuse RFC-{n:03d}", file=sys.stderr)
        return 1
    print(f"{n:03d}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
