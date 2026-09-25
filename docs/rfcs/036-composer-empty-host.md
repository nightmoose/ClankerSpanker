# RFC-036 — A host with no projects is usable from the composer

**Status:** Accepted
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc036-composer-empty-host
**Severity:** P1

---

## Problem

Two-host soak: starting a session on Astrodata (fresh config, no projects)
dead-ended. The phone composer showed a sentence pointing at another tab,
refused `/` with an error naming *this* Mac's projects ("Pick Mercenary iOS
/ ClankerSpanker …"), and **Import from disk** found nothing — because
`discoverKnownProjects()` was a hardcoded list of one Mac's repos
(`~/Projects/GrokDispatch`, `~/mercenary`, …). A typed `~/x` folder was not
expanded either.

## Non-goals

- Mac composer's "add folders" (it registers folders on the *local* host
  even for a remote target) — Mac-as-client multi-host follow-up.
- Removing the legacy `knownWorkspaceProjects` helpers.

## Fix

- Host: `discover-repos.ts` — git repos directly in `$HOME` and ≤ 2 levels
  under `~/Projects`, `~/projects`, `~/Developer`, `~/dev`, `~/code`, `~/src`,
  `~/Documents`, `~/GitHub`, `~/repos`; skips hidden, `node_modules`,
  `Library` and media folders; doesn't descend into repos; de-duplicates by
  inode (APFS `Projects` = `projects`); cap 100; ids `<slug>-<hash6>`.
  `POST /projects/discover` uses it (3 ms for 31 repos on the Mac mini).
- Host: custom cwd expands `~`; the `/` refusal explains why and names no
  one's projects.
- iPhone composer: empty state offers **Import from ⟨host⟩…** and
  **New project…** in place (the Projects tab's sheets, bound to the
  profile's host), then reloads and selects the new project.

## Testing

- [x] `discover-repos.test.ts` (4): roots/depth, skips + nested repos,
      limit, stable ids.
- [x] `project-resolve.test.ts`: `~` cwd expands; `/` message is generic.
- [ ] Manual: phone → Astrodata profile → Import from Astrodata… → pick →
      picker shows it → dispatch.

## Rollout

1. `make check`; update both hosts (`scripts/update-mac-host.sh`).
2. Rebuild phone (Deez Nutz).
3. `docs/STATUS.md` → Shipped; `MAINTENANCE_LOG.md`.
