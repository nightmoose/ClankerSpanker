# RFC-025 — Electron desktop multi-host: WS pool, per-host fan-out, hostId end-to-end

**Status:** Accepted
**Date:** 2026-09-22
**Branch:** nightly-maintenance-2026-09-22-rfc025-desktop-multi-host
**Severity:** P1 — mirror of RFC-024 for the Linux Electron client. Without this, adding a second host to `desktop/` hides sessions from every host that isn't `activeHostId`, drops WS events, and routes approval-notification clicks to the wrong host.

---

## Problem

RFC-024 fixed the iOS/Mac client's implicit-single-host assumption. The
Electron desktop app in `desktop/` has the same shape: schema is
plural (`hosts[]` + `activeHostId`), but every downstream code path
treats one host as *the* host.

Concrete regressions with two hosts:

- **Single WS.** `desktop/src/main.js` holds one `HostWsMonitor` bound
  to `effectiveConnection()` of the active host. WS events from every
  non-active host are dropped — tray badge, OS notifications, and the
  renderer's live-event stream miss them entirely.
- **Notification action mis-routes.** `main.js:176–186` sends
  `session:approval-action` with `sessionId` + `approvalId` but no
  `hostId`. Clicking Approve on a notification that fired from host B
  while host A is active hits host A for that id → 404 or (worse)
  approves the wrong operation.
- **Single-host reads.** `refreshSessions` in `desktop/renderer/app.js`
  calls `Api.sessions()` / `Api.projects()` / `Api.profiles()` once
  against `activeHostId`'s connection — sessions on other hosts never
  appear in the list. Same for `renderBots()`, `renderTasks()`,
  `renderProfiles()`.
- **Session detail routes to active host.** Clicking a session in the
  list runs `Api.session(id)` against `activeHostId`; if that session
  actually lives on host B, the call 404s or, if an id happens to
  collide, silently returns the wrong session.
- **`state.lastSeqBySession` is flat.** Replay/catch-up keys on
  session id alone, so seqs from different hosts alias each other →
  events get dropped or double-applied.
- **Approvals/prompts/answers all hit active host.** Wire actions
  (`Api.approve/reject/answer/prompt/cancel/close/deleteSession/…`)
  never see a host context; they use module-global connection state.
- **Compose profile bar** shows only the active host's profiles. Same
  UX problem RFC-024 fixed on iOS Settings.
- **Tray + notification body** don't name the host, so with two hosts
  the user can't tell which one raised an alert.

`config-store.js` schema is already plural (`hosts[]` + `activeHostId`);
the fix is client-side plumbing, not schema.

## Non-goals

- Rewriting `HostProcessManager` to manage multiple local host processes.
  Only one local host can bind port 8787; multi-host means one local +
  N remote. Local process management stays single-host.
- Full renderer overhaul (routing, view layer). This RFC threads `hostId`
  through the existing view scaffolding without restructuring it.
- Desktop APNs / push tokens. Electron uses in-process WS + OS
  notifications; no push tokens to fan out.
- Bonjour discovery / host onboarding UX (follow-up).

## Fix

### Main process

1. **`desktop/src/host-ws.js`** — `HostWsMonitor` accepts a `hostId` in
   its constructor. All `onStatus`/`onNotify`/`onEvent` callbacks
   receive that `hostId` so downstream code can route per-host.

2. **`desktop/src/host-ws-pool.js`** (new) — `HostWsPool` owns one
   `HostWsMonitor` per host in `loadConfig().hosts`. Public surface:
   `sync(hosts, connFor)` reconciles the pool to the current host
   list; `stop()` closes all; `snapshot()` returns per-host status.
   Fires `onStatus(hostId, status)` and `onEvent(hostId, event)`.

3. **`desktop/src/main.js`** — replaces the single `monitor` global
   with the pool. `notify()` includes `hostId` in the
   `session:approval-action` and `session:focus` IPC payloads so the
   renderer can look up the owning host. Notification titles/bodies
   include the host's name when >1 host is configured. Tray status
   pill becomes "N/M hosts live" instead of a single tri-state.

### Renderer

4. **`desktop/renderer/api.js`** — every method accepts an optional
   trailing `hostConn = { hostURL, token }` argument. When present it
   overrides the module singleton for that one call. Adds
   `Api.forHost(hostConn)` factory returning a facade whose methods
   auto-pass `hostConn`. The singleton stays for compose defaults
   (where "current host" is the right choice).

5. **`desktop/renderer/app.js`** — `state.connByHost: Map<hostId,
   {hostURL, token}>` populated from the desktop config. New
   `hostConnFor(hostId)` helper returns that map entry.
   `refreshSessions()` fans `/sessions` + `/projects` + `/profiles`
   out across every host with `Promise.allSettled`, stamps `hostId`
   on every session (and disk/claude/agy hint) before merging into
   `state.sessions[]`. Dedup key becomes `${hostId}|${sessionId}`.
   `state.lastSeq` becomes a Map keyed on the composite so replay
   doesn't alias across hosts.

6. **`renderProfiles()`** groups profiles by host (one heading per
   host); solo-host installs render as before.

7. **`openSession(id)` / `catchUpEvents()` / approval / question /
   prompt / archive / unarchive / delete / rename / cancel / close /
   transfer / reincarnate / setSessionProject / addExtraDirs /
   sessionFile / toolCall** — all resolve the session's `hostId` from
   `state.sessions` and use `Api.forHost(hostConnFor(hostId))`.

8. **`Api.dispatch` / compose** continues to use the singleton
   connection (i.e. the currently active host); compose always fires
   against "who I'm focused on".

9. **`renderBots()`** fans out `/bots` across every host, stamps each
   with `hostId`. Bot mutations (patch/run/outbox) use
   `Api.forHost(hostConnFor(bot.hostId))`.

10. **`renderTasks()`** same treatment: fan-out `/tasks`, resolve
    per-task host via `state.sessions` (task carries
    `sourceSessionId`). Toggle/delete route to the session's owning
    host.

11. **Notification action IPC** — `session:approval-action` handler in
    `app.js` reads `hostId` from the payload and calls
    `Api.forHost(hostConnFor(hostId)).approve(...)`. If `hostId` is
    absent (legacy notification), best-effort fall back to the active
    host.

### UX

12. **Session row host badge** — when >1 host is configured, session
    row shows a small chip with the host's name. Solo-host is
    unchanged.

13. **Chip caption** — "Active: HostName" replaced by "N hosts · M
    live" when >1 host, so users see aggregate reachability.

## Testing

- `make check` — desktop has no host tests, so `make check` covers
  host/openapi only. The test-count ratchet is not affected.
- Manual soak (deferred to Alex):
  1. Launch Electron with two hosts configured.
  2. Both hosts' sessions appear in the merged list, each row tagged
     with its host chip.
  3. Trigger an approval on the non-active host → notification body
     names that host; clicking Approve routes correctly (verify by
     observing the target host's log).
  4. Kill the remote host mid-refresh → tray pill drops to "1/2 live"
     without blanking the local host's list.
  5. Bots + tasks show entries from both hosts.

## Rollout

1. `make check`.
2. No host redeploy required — RFC-025 is desktop-side only.
3. Alex launches the updated Electron shell (`npm start` in
   `desktop/`) on Nomad and soak-tests.
4. `docs/STATUS.md` → Shipped on merge.
5. Append `MAINTENANCE_LOG.md`.

## Follow-ups

- **Bonjour / discovery** for onboarding a second host without typing an IP.
- **Per-host process control**: today `HostProcessManager` only
  manages the one local host. If Alex ever runs two Nodes on the same
  machine (different ports), that's a follow-up.
- **Renderer view routing overhaul**: `state.detail` is still
  session-id keyed globally; a proper router keyed on `(hostId, id)`
  would eliminate a lot of the manual lookups in this RFC.
