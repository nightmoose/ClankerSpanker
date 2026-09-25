# RFC-024 — iOS multi-host: WS pool, per-host fan-out, hostId end-to-end

**Status:** Shipped
**Date:** 2026-09-21
**Branch:** nightly-maintenance-2026-09-21-rfc024-ios-multi-host
**Severity:** P1 — first real two-host test on 2026-09-21 broke visibly. Only the primary host's profiles/sessions/bots/tasks are listed on iOS, secondary-host approvals never push, kill-state pushes are single-host, and the Mac shell clobbers a remote selection on every startup.

---

## Problem

The iOS/Mac client was built for one host and now treats `selectedHost` as an
implicit global. Adding a second `HostEndpoint` exposes ~15 concrete
regressions:

**Data invisible or misrouted (Broken):**

- `WebSocketClient` holds a single socket bound to `selectedHost`
  (`WebSocketClient.swift`, `AppState.swift` connect at ~L88–103, L340,
  L373, L474, L489, L506, L738). Approvals, `question.needed`,
  `session.updated`, badges, tasks refresh — all silent for every host that
  isn't currently selected.
- `AppState.refreshSessions` fetches profiles across all hosts (~L665–694) but
  sessions from only `selectedHost` (~L718–730). Mixed fan-out is the reason
  "only the primary host's profiles are listed" reads as a profile bug —
  profiles are actually correct there; every other list is wrong.
- Attention badge + banner count only `selectedHost` (`AppState.swift`
  ~L295–307, L606–612).
- APNs registration only calls `selectedHost` (`AppState.swift` ~L132–152,
  `APIClient.swift` ~L748–754). Kill-state pushes come from whichever host
  was selected at token mint; `lastPushRegistration` key `hostId|token`
  freezes the state.
- Bots list is single-host (`BotsViewModel.swift` ~L22, L50, L67, L96, L126,
  L145).
- Global tasks single-host (`TasksView.swift` ~L66, L145–149, L286, L295,
  L321, L334).
- `DashboardViewModel` attaches disk/claude/agy hints against
  `selectedHost` even when the hint originated from a different host
  (~L17–129).
- `MacCommandCenter` opens session detail against `selectedHost`, not the
  session's own host (~L417–419). Cross-host row selection → 404.
- `ensureLocalHostOnMac` unconditionally forces the socket to loopback on
  every Mac startup (`AppState.swift` ~L269–271). A Mac that is also a
  client to a bigger host loses its remote selection.
- `dedupeSessions` collapses cross-host id collisions
  (`AppState.swift` ~L752–780).

**Silently wrong (Confusing):**

- `handleNotificationAction` falls back to `selectedHost` when `hostId` is
  missing from the notification userInfo (`AppState.swift` ~L157–171). Post
  host-switch taps hit the wrong host and 404.
- `HostedSession` model exists but is never used (`Models/HostEndpoint.swift`
  ~L111–116); UIs render `SessionSummary` with no host label, so "All hosts"
  chip mode is unreadable.
- Terminal opens against `selectedHost` only (`TerminalView.swift` ~L10–71).
- Refresh errors collapse to `errors.first` (`AppState.swift` ~L711–713,
  L737) — a dead secondary hides behind a healthy primary or vice-versa.
- Profile-usage 60s poll iterates hosts serially (`ProfileSegmentBar.swift`
  ~L99–107); one wedged secondary stalls the loop until per-host timeout.
- Chip caption `"All profiles · <host.name>"` shows only `selectedHost`
  (`ProfileSegmentBar.swift` ~L209–222).

## Non-goals

- Electron parity. Follows in RFC-025 (mirror of this once the shape settles).
- Host-side dataDir/port collision detection. Different-machine hosts don't
  collide; same-machine two-host is already rejected by `EADDRINUSE`. If it
  bites, it gets its own RFC.
- Host-side APNs device-ownership refactor. The push payload already carries
  `data.hostId` (`host/src/notify/push.ts:24–29`); the actual gap is that the
  phone doesn't register with every host. Fix is client-side.
- `ConnectionDefaults.lanHostURL` (`192.168.50.9`) rework. Still a known
  defect; onboarding UX is a separate follow-up.
- Bonjour discovery of hosts. Follow-up if the LAN "who's out there" story
  becomes real.

## Fix

### Host (small)

1. **`GET /host/self`** on `host/src/server.ts`. Returns
   `{ hostId, name, version, bindPort }`. `hostId` is a stable UUID
   persisted in `config.hostId` (minted on first boot; written back to
   `config.json`). `name` defaults to `os.hostname()`; version from
   `package.json`. Auth still required (the token is trivial to obtain from
   the phone once onboarded; no reason to make identity anonymous).
2. Persist `hostId` in the config file so it survives restart. Mirror the
   profiles/projects one-shot-migration shape already in `loadConfig`.

Everything else is client-side.

### iOS — one connection per host

3. **`HostConnection`** actor (new, `Services/HostConnection.swift`): owns
   one `URLSessionWebSocketTask` for one `HostEndpoint`, tracks last-seen
   `seq`, exposes an event callback + `reconnect()` and `close()`. Replay
   uses the existing `/sessions/:id/events?since=N`.

4. **`HostConnectionPool`** actor (new,
   `Services/HostConnectionPool.swift`):
   `Dictionary<HostEndpoint.ID, HostConnection>`. Maintains one connection
   per enabled host, adds/removes as `hostEndpoints` mutates, publishes a
   merged event stream tagged with `hostId`. Replaces the single
   `WebSocketClient` at the AppState boundary; the class stays for the
   Mac terminal path only.

5. **`AppState.multiHostRefresh()`** replaces `refreshSessions`'s
   single-host fetch. Fan-outs `GET /sessions` (and archived/disk-hints/
   claude/agy) to every enabled host in parallel with a `TaskGroup`.
   Merges results pre-tagged with `hostId`. Dedupe key becomes
   `(hostId, id)`. Per-host failures are collected and surfaced as a
   single "N hosts unreachable" banner rather than the first-error
   string.

6. **`SessionSummary` carries `hostId`.** Optional `hostId: String?` for
   wire compatibility (host doesn't emit it — client stamps it on
   receive). Everywhere that constructs a `SessionSummary` gets the
   caller's host, not `selectedHost`. `HostedSession` (already defined,
   never used) is deleted — folded in.

7. **`endpoint(for session:)`** helper on `AppState`: given a
   `SessionSummary`, returns its owning `HostEndpoint`. All session-scoped
   API calls (`open`, `send`, `approve`, `answer`, `attach*`, terminal,
   file viewer) route through this helper, never through `selectedHost`.
   `MacCommandCenter` selection, `DashboardViewModel` attach flows, and
   notification action dispatch all switch to it.

### iOS — behavior changes

8. **APNs registration fans out.** `AppState.applyDeviceToken(_:)`
   iterates every enabled host. `lastPushRegistration` becomes
   `Set<String>` keyed by `hostId|token`; on token change, all four (or
   however many hosts) hit the wire.

9. **Notification action routing by `hostId`.**
   `handleNotificationAction` reads `hostId` from the notification
   `userInfo` (push data already carries it — `host/src/notify/push.ts`)
   and looks up the endpoint in `hostEndpoints`. If the `hostId` doesn't
   match any known endpoint, the action fails with a toast; no
   `selectedHost` fallback.

10. **Attention badge is cross-host.** `applicationIconBadgeNumber` +
    home-banner count use the merged sessions list. Same for
    `attentionSessions`.

11. **Kill `ensureLocalHostOnMac` clobber.** The bootstrap keeps its
    "seed a local host if none exist" behavior but only when
    `hostEndpoints.isEmpty`. It never overwrites an existing selection.

12. **Sessions dedupe is `(hostId, id)`.** `AppState.dedupeSessions` keys
    on the composite. Two hosts that imported the same Grok/Claude
    session id now coexist as two rows.

13. **Bots + Tasks fan out.** `BotsViewModel` and `TasksView` gain a
    per-host loop (parallel via `TaskGroup`) and tag each result with
    `hostId`. Row rendering shows a host chip when more than one host has
    an entry.

14. **Terminal per-host.** `TerminalView` takes an optional
    `HostEndpoint` and opens against that. When opened from a session
    context, uses `endpoint(for: session)`.

### iOS — UX changes

15. **Profile list grouped by host.** Settings profile picker renders a
    `Section` per host with the host's name as the header. Empty hosts
    collapse. Solves the user-reported "only primary host's profiles are
    listed" symptom.

16. **Host label on session rows** when more than one host is enabled.
    `SessionRowView` shows a small trailing chip with the host's name.
    Single-host installations show nothing.

17. **Chip caption fix.** `ProfileSegmentBar` caption reads
    `"All profiles · N hosts"` when the chip mode spans all hosts;
    single-host installs and single-host-selected mode keep the
    `"All profiles · <host.name>"` shape.

18. **Profile-usage poll parallelizes.** The 60s poll becomes a
    `TaskGroup` across hosts with per-host timeout (2s), so one wedged
    secondary can't stall the loop.

## Testing

- [x] Host: `host/src/server.self.test.ts` — `GET /host/self` returns
      `{hostId, name, version, bindPort}`, `hostId` stable across boots,
      minted-and-persisted on first load without one.
- [x] Host: `config.test.ts` addition — `loadConfig` mints `hostId` when
      missing and rewrites the file; existing `hostId` preserved.
- [x] Test-count ratchet raised for host-side additions.
- [ ] Manual soak on iPhone (Deez Nutz):
      1. Add second host in Settings → Hosts.
      2. Both hosts appear in the host picker.
      3. Settings → Profiles: both hosts' profiles listed under distinct
         sections.
      4. Sessions list shows sessions from both hosts, with host labels.
      5. Trigger an approval on the non-selected host → phone gets APNs
         push and tapping the notification routes to the correct host.
      6. Approve → session resumes on the correct host.
      7. Kill app, trigger approvals on both hosts → both push badge.
      8. Force-quit host B → phone shows "1 host unreachable" banner but
         host A's sessions still refresh.
- [ ] Manual soak on Mac: launch with a remote host already selected in
      keychain; verify `ensureLocalHostOnMac` doesn't clobber it. Verify
      selecting a session belonging to the remote host opens correctly.
- [x] `make check`.

## Rollout

1. `make check`.
2. Kick LaunchAgent (host has new route + config migration).
3. Rebuild `ClankerSpankerPhone` → install to Deez Nutz. Same for Mac
   scheme.
4. `docs/STATUS.md` → Accepted (Shipped once merged to main).
5. Append `MAINTENANCE_LOG.md`.

## Follow-ups

- **RFC-025:** Electron parity — mirror the pool + fan-out + hostId
  changes in `desktop/`.
- **Bonjour / host discovery** so onboarding doesn't have to know the LAN
  IP by heart.
- **Cross-host session-id prefix** on the wire, if two hosts actively
  hold the same imported id turns into a real ergonomic problem.
- **`ConnectionDefaults.lanHostURL`** rework.
- **Per-host token rotation UX**: "rotate all" affordance eventually.
