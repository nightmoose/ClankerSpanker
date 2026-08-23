#!/usr/bin/env python3
"""ClankerSpanker house-style gate (RFC-000).

Exit 0 = pass. Exit 1 = process/regression failure. Exit 2 = tooling error.

Always:
  - RFC files are NNN-slug.md and listed in docs/STATUS.md
  - host test count >= host/test-baseline.txt
  - every host/src/**/*.ts module has a sibling test or a TEST-EXCEPTIONS row

When compared to a git base (origin/main if present, else empty-tree):
  - heavy path changes require an RFC file and MAINTENANCE_LOG.md in the diff
  - new 192.168.* literals outside the allowlist fail
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RFC_DIR = ROOT / "docs" / "rfcs"
STATUS = ROOT / "docs" / "STATUS.md"
EXCEPTIONS = ROOT / "docs" / "TEST-EXCEPTIONS.md"
BASELINE = ROOT / "host" / "test-baseline.txt"
MAINTENANCE = ROOT / "MAINTENANCE_LOG.md"

HEAVY_PREFIXES = (
    "host/src/",
    "host/web/",
    "host/package.json",
    "desktop/src/",
    "desktop/renderer/",
    "desktop/package.json",
    "ios/",
    "shared/",
    "scripts/",
    "Makefile",
    ".github/workflows/",
)

DOC_ONLY_SUFFIXES = (".md",)
DOC_ONLY_PREFIXES = ("docs/",)

IP_ALLOWLIST = {
    "ios/GrokDispatch/GrokDispatch/Models/ConnectionDefaults.swift",
    "ios/GrokDispatch/GrokDispatch/Models/HostEndpoint.swift",
    "ios/GrokDispatch/GrokDispatch/Views/Auth/OnboardingView.swift",
    "host/src/platform.ts",
}

SKIP_SRC = re.compile(r"(^|/)(index|types)\.ts$")
TEST_SRC = re.compile(r"\.test\.ts$")
RFC_NAME = re.compile(r"^(\d{3})-[a-z0-9][a-z0-9.-]*\.md$")
IP_LIT = re.compile(r"192\.168\.\d{1,3}\.\d{1,3}")


def run(cmd: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=cwd or ROOT,
        text=True,
        capture_output=True,
    )


def git_output(args: list[str]) -> str:
    r = run(["git", *args])
    if r.returncode != 0:
        raise SystemExit(f"git {' '.join(args)} failed:\n{r.stderr}")
    return r.stdout


def base_ref() -> str | None:
    r = run(["git", "rev-parse", "--verify", "origin/main"])
    if r.returncode == 0:
        mb = run(["git", "merge-base", "origin/main", "HEAD"])
        if mb.returncode == 0:
            return mb.stdout.strip()
        return "origin/main"
    return None


def changed_files(base: str | None) -> list[str]:
    if not base:
        r = run(["git", "diff", "--name-only", "--cached"])
        names = [n for n in r.stdout.splitlines() if n]
        if names:
            return names
        r = run(["git", "ls-files"])
        return [n for n in r.stdout.splitlines() if n]
    out = git_output(["diff", "--name-only", f"{base}...HEAD"])
    unstaged = run(["git", "diff", "--name-only"]).stdout.splitlines()
    staged = run(["git", "diff", "--name-only", "--cached"]).stdout.splitlines()
    untracked = run(
        ["git", "ls-files", "--others", "--exclude-standard"]
    ).stdout.splitlines()
    return sorted(
        set(out.splitlines()) | set(unstaged) | set(staged) | set(untracked)
    )


def is_heavy(path: str) -> bool:
    if path.endswith(".md") or path.startswith("docs/"):
        return False
    return any(path == p or path.startswith(p) for p in HEAVY_PREFIXES)


def check_rfcs() -> list[str]:
    errors: list[str] = []
    files = sorted(
        p for p in RFC_DIR.glob("*.md") if p.name != "_template.md"
    )
    if not files:
        return ["no RFC files in docs/rfcs/ (need at least 000)"]
    nums: list[int] = []
    status = STATUS.read_text() if STATUS.exists() else ""
    if not STATUS.exists():
        errors.append("docs/STATUS.md is missing")
    for p in files:
        m = RFC_NAME.match(p.name)
        if not m:
            errors.append(f"RFC filename must be NNN-slug.md: {p.name}")
            continue
        nums.append(int(m.group(1)))
        needle = f"rfcs/{p.name}"
        if needle not in status:
            errors.append(f"docs/STATUS.md does not list {needle}")
    if nums:
        expect = list(range(min(nums), max(nums) + 1))
        missing = [n for n in expect if n not in nums]
        if missing:
            errors.append(
                "RFC numbering gap: missing "
                + ", ".join(f"{n:03d}" for n in missing)
            )
        dupes = sorted({n for n in nums if nums.count(n) > 1})
        if dupes:
            errors.append(
                "duplicate RFC numbers: "
                + ", ".join(f"{n:03d}" for n in dupes)
            )
    return errors


def exception_paths() -> set[str]:
    text = EXCEPTIONS.read_text() if EXCEPTIONS.exists() else ""
    found: set[str] = set()
    for m in re.finditer(r"`(host/src/[^`]+)`", text):
        found.add(m.group(1))
    return found


def check_test_exceptions() -> list[str]:
    errors: list[str] = []
    allowed = exception_paths()
    src_root = ROOT / "host" / "src"
    if not src_root.exists():
        return ["host/src missing"]
    for path in sorted(src_root.rglob("*.ts")):
        rel = path.relative_to(ROOT).as_posix()
        if TEST_SRC.search(rel) or SKIP_SRC.search(rel):
            continue
        test = path.with_name(path.stem + ".test.ts")
        # sibling in same dir; also allow foo.ts covered by foo.bar.test.ts nearby
        if test.exists():
            continue
        # session-manager.approvals.test.ts covers session-manager.ts
        stem = path.stem
        extras = list(path.parent.glob(f"{stem}*.test.ts"))
        if extras:
            continue
        if rel in allowed:
            continue
        errors.append(
            f"untested host module {rel} — add {path.stem}.test.ts "
            "or list it in docs/TEST-EXCEPTIONS.md (RFC required to add)"
        )
    listed_missing = [p for p in sorted(allowed) if not (ROOT / p).exists()]
    for p in listed_missing:
        errors.append(f"TEST-EXCEPTIONS lists missing file {p}")
    return errors


def check_test_ratchet() -> list[str]:
    if not BASELINE.exists():
        return ["host/test-baseline.txt missing"]
    try:
        baseline = int(
            next(
                ln.strip()
                for ln in BASELINE.read_text().splitlines()
                if ln.strip() and not ln.strip().startswith("#")
            )
        )
    except (StopIteration, ValueError):
        return ["host/test-baseline.txt has no integer count"]
    r = run(["npm", "test"], cwd=ROOT / "host")
    # vitest prints to stderr sometimes; combine
    blob = r.stdout + "\n" + r.stderr
    m = re.search(r"Tests\s+(\d+)\s+passed", blob)
    if r.returncode != 0:
        return [
            "host tests failed (ratchet not measured):\n"
            + blob[-2000:]
        ]
    if not m:
        return ["could not parse vitest summary for test-count ratchet"]
    count = int(m.group(1))
    if count < baseline:
        return [
            f"test-count ratchet: {count} tests < baseline {baseline}. "
            "Do not delete tests to go green. If a test is wrong, fix it."
        ]
    if count > baseline:
        print(
            f"note: {count} tests > baseline {baseline} — bump "
            "host/test-baseline.txt in this change."
        )
    else:
        print(f"test-count ratchet: {count} == baseline {baseline}")
    return []


def check_heavy_diff(files: list[str], base: str | None) -> list[str]:
    if not base:
        return []
    heavy = [f for f in files if is_heavy(f)]
    if not heavy:
        print("diff vs origin/main is docs/process-only — RFC-in-diff not required")
        return []
    rfc_touched = [
        f
        for f in files
        if f.startswith("docs/rfcs/")
        and f.endswith(".md")
        and not f.endswith("_template.md")
    ]
    errors: list[str] = []
    if not rfc_touched:
        errors.append(
            "heavy change without an RFC in the diff. Write docs/rfcs/NNN-slug.md "
            f"(see docs/HOUSE-STYLE.md). Heavy files: {', '.join(heavy[:12])}"
            + (" …" if len(heavy) > 12 else "")
        )
    if "MAINTENANCE_LOG.md" not in files:
        errors.append(
            "heavy change without MAINTENANCE_LOG.md in the diff — append a run entry"
        )
    return errors


def check_new_lan_ips(files: list[str], base: str | None) -> list[str]:
    errors: list[str] = []
    for path in files:
        if path in IP_ALLOWLIST:
            continue
        full = ROOT / path
        if not full.is_file():
            continue
        if full.suffix not in {".ts", ".js", ".swift", ".yml", ".yaml", ".json"}:
            continue
        try:
            text = full.read_text(errors="replace")
        except OSError:
            continue
        if not IP_LIT.search(text):
            continue
        # Only fail if the literal is new vs base
        if base:
            diff = run(["git", "diff", base, "--", path])
            if not IP_LIT.search(diff.stdout):
                continue
            if all(
                not IP_LIT.search(line)
                for line in diff.stdout.splitlines()
                if line.startswith("+") and not line.startswith("+++")
            ):
                continue
            added = [
                line
                for line in diff.stdout.splitlines()
                if line.startswith("+")
                and not line.startswith("+++")
                and IP_LIT.search(line)
            ]
            if not added:
                continue
        errors.append(
            f"new hardcoded LAN IP in {path} — "
            "ConnectionDefaults.lanHostURL is the known defect; do not copy it"
        )
    return errors


def main() -> int:
    os.chdir(ROOT)
    errors: list[str] = []
    print("== RFC index ==")
    errors += check_rfcs()
    print("== host test exceptions ==")
    errors += check_test_exceptions()
    print("== host test-count ratchet ==")
    errors += check_test_ratchet()
    base = base_ref()
    print(f"== diff vs {base or '(no origin/main)'} ==")
    files = changed_files(base)
    errors += check_heavy_diff(files, base)
    errors += check_new_lan_ips(files, base)
    if errors:
        print("\nHOUSE STYLE FAILED:")
        for e in errors:
            print(f"  - {e}")
        print("\nSee docs/HOUSE-STYLE.md")
        return 1
    print("\nhouse-style-check: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
