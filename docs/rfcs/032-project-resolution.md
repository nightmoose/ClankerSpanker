# RFC-032 — Projects follow the folder: `~` expansion, inference, overlap warnings

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc032-project-resolution
**Severity:** P1

---

## Problem

Measured on 2026-09-25 across 169 sessions:

- 63 (37%) had no `projectId`. A project was only set when picked in the
  composer; cwd-only dispatches and every Claude/Grok session imported from
  disk stayed untagged, even inside a project's folder (23 of them).
- `resolveProjectPath` matched a cwd only when it *equalled* a project's
  first path — subfolders and secondary paths never matched.
- JourneyQuest was stored as `~/journeyquest`. `resolve()` does not expand
  `~`, so the project resolved to `<cwd>/~/journeyquest`; its sessions ran
  in `~/Projects` and the one real JourneyQuest session had no project.
  The Mac New Project placeholder (`~/Projects/Foo`) invites this.
- Two projects claim `~/Projects` ("Projects" and ClankerSpanker's second
  path) and nothing warns about it.
- The browser client shows a folder fragment instead of the project name and
  lists archived projects in the composer.

## Non-goals

- Changing the owner's project list (a separate, owner-approved cleanup).
- Claude config-dir / Grok-home consolidation (profiles, separate RFC).
- A "Tidy projects" view (P3 follow-up).

## Fix

- `host/src/project-resolve.ts`: `expandHome`, `inferProjectId` (longest
  matching project path, case-insensitive, archived ignored; a tie between
  two different projects is ambiguous → no guess), `nonAbsolutePaths`,
  `projectOverlapWarnings`.
- `normalizeProject` expands `~` (fixes stored `~/journeyquest` on load).
- `resolveProjectPath` (cwd-only dispatch) tags the session via inference.
- `GET /sessions` fills a missing `projectId` by inference for display.
- `POST` / `PATCH /projects`: 400 on relative paths; response carries
  `warnings` for same/inside/contains overlaps.
- Browser `/app/`: session cards show the project name (folder on hover);
  composer hides archived projects.

## Testing

- [x] `project-resolve.test.ts`: `~` expansion; longest prefix; sibling
      prefixes (`mercenary` vs `mercenary-ios`); case-insensitive; ambiguous
      overlap → none; archived ignored; relative paths flagged; overlap
      warnings; `normalizeProject` expands; `resolveProjectPath` infers.
- [x] Manual: `/app/` session list shows project names; untagged sessions 63 → 41 (rest: home dir, Bricklayer worktrees, old ArcadeBox path).

## Rollout

1. `make check`; Install / update host.
2. `docs/STATUS.md` → Shipped; `MAINTENANCE_LOG.md`.

## Follow-ups

- Owner cleanup of the project list (overlaps, Bricklayer worktree root).
- Persist inferred ids on import; Mac/iOS surface `warnings` in the editor.
