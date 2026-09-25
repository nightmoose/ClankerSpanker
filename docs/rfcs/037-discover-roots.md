# RFC-037 — Import from disk finds GitHub Desktop clones; configurable roots

**Status:** Accepted
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc037-discover-roots
**Severity:** P2

---

## Problem

RFC-036's scan found only 4 repos on Astrodata. Most live in
`~/Documents/GitHub/Teladoc/<repo>` — GitHub Desktop's default clone folder
plus an org folder — three levels under `~/Documents`, one past the scan
depth. Machines also keep code in places no default list can guess.

## Fix

- Add roots `~/Documents/GitHub`, `~/Documents/Projects`, `~/Documents/Code`
  (2 levels each → `<org>/<repo>`).
- `config.json` `"discoverRoots": ["~/work", "/Volumes/Code"]` adds
  machine-specific roots (2 levels, `~` expanded).
- Walk bookkeeping remembers the depth a folder was walked with, so a
  shallow pass (e.g. `~/Documents`) no longer blocks a deeper one
  (`~/Documents/GitHub`). Repos are still de-duplicated by inode.

## Testing

- [x] `discover-repos.test.ts`: `Documents/GitHub/<org>/<repo>` found;
      `discoverRoots` with `~` found only when configured. Mac mini: 31 repos, 8 ms.
- [ ] Manual: Astrodata → Import lists the Teladoc repos.

## Rollout

1. `make check`; update both hosts. 2. STATUS / log.
