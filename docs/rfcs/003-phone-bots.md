# RFC-003 — Create and run bots from the iPhone app

**Status:** Accepted
**Date:** 2026-08-24
**Branch:** nightly-maintenance-2026-08-24-rfc002-session-chat-files-folders
**Severity:** P1 — daily-driver phone UX
**Addresses:** hunters exist on the host and Mac command center; the iOS
app has no Bots tab, so you cannot create a bot or fire **Run now** from
the phone.

---

## Problem

Mac `MacCommandCenter` has a Bots root tab: list, New bot sheet,
enable/interval, standing job, **Run now**, last session, outbox.

The iPhone chrome (`PhoneMainTabStrip` / `MainTabView`) is Sessions /
Projects / Tasks / Dispatch / Settings. `AppTab` has no `.bots`.
`BotsView` exists as a leftover NavigationSplitView and is never
mounted. `NewBotSheet` is a Mac-sized panel (`minWidth: 560`) with no
iOS navigation chrome.

The host already has `GET/POST /bots`, `PATCH /bots/:id`,
`POST /bots/:id/run`, outbox. The phone API client already calls them.
This is a missing surface, not missing backend.

## Non-goals

- A sixth Mac tab (Mac already has Bots).
- Browser `/app/` bots (Linux Electron already has hunters).
- Deleting bots from the phone (Mac also has no delete in the sheet).
- Changing hunter semantics (still drafts to `.bot-outbox/`, nothing sent).

## Fix

1. `AppTab.bots`. Phone tab strip: **Bots** (scope icon) between Tasks
   and Dispatch.
2. `MainTabView` hosts `BotsView`.
3. iOS `BotsView`: NavigationStack list (not split view). Chrome **+**
   opens `NewBotSheet`. Row → detail with enable, interval, job, Run now,
   last session, outbox. Run now / Open last run push `SessionDetailView`.
4. `NewBotSheet`: iOS `NavigationStack` + `Form`; keep the Mac panel.

## Testing

- [ ] `make check` (no new host tests; wire already exists).
- [ ] iPhone: Bots tab → New bot → Create; **Run now** opens the session.
- [ ] Mac Bots tab unchanged (⌘2).

## Rollout

1. Land with the named branch.
2. `make check`
3. `docs/STATUS.md` → Shipped when merged
4. Append `MAINTENANCE_LOG.md`
5. Rebuild the iOS / iPhone scheme.

## Follow-ups

- Delete bot from clients.
- Browser `/app/` bots UI.
