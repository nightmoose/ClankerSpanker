# RFC-069 — Cheap session-list: slim shape, ETag, paging

**Status:** Shipped
**Date:** 2026-10-20
**Branch:** rfc-069-sessions-list-summary
**Severity:** P1

---

## Problem

`GET /sessions` is fetched by every client on each refresh — including the iPhone over Tailscale.

Measured 2026-10-20 against the live gateway with 229 sessions (102 active + 127 archived):

| Metric | Before |
|--------|--------|
| Response size | 398,058 bytes |
| Latency (best of 3) | ~501 ms |
| Sessions | 229 total |
| Average bytes / session | ~1,677 |

**Root cause — `prompt` dominates the payload.**

Field breakdown across all 229 session objects:

| Field | Total chars | Share |
|-------|-------------|-------|
| `prompt` | 206,643 | **53 %** |
| `transcriptPreview` | 35,978 | 9 % |
| `id` | 8,702 | 2 % |
| `cwd` | 8,116 | 2 % |
| `grokSessionId` | 5,168 | 1 % — never rendered in any list view |
| `claudeSessionId` | 2,964 | <1 % — not in any list view |
| `error` | 2,795 | <1 % — detail only |
| `completedAt` | 2,392 | <1 % — detail only |

Prompts are not length-capped today; a single multi-file session prompt can be >2 KB.
`toSummary()` also allocated a reversed copy of up to 120 transcript entries per session
(`[...s.transcript].reverse().find(…)`), producing extra GC pressure on every list request.

None of the list views render `error`, `completedAt`, `pendingApprovalId`, `botId`,
`grokSessionId`, `claudeSessionId`, or `antigravityConversationId`.

## Non-goals

- Server-push / WebSocket invalidation for the session list.
- Client-side "load more" UI in web / desktop (infrastructure lands here; UI wiring is a follow-up).
- Removing full `GET /sessions` (kept for backward compat with clients that haven't adopted `?view=summary`).

## Fix

### 1. `GET /sessions?view=summary` — slim shape

New `PublicSessionListItem` type (`host/src/types.ts`) containing only what list views render:

```
id, title, status, model, cwd, projectId, planMode,
archived, archivedAt, isLive, backend,
profileId, profileName, profileColor,
grokHomeLabel, transcriptPreview, prompt (≤160 chars),
updatedAt, createdAt, toolCallCount,
creditsUsedDeltaPct, creditsUsedAt
```

Dropped vs. `PublicSessionSummary`: `grokSessionId`, `completedAt`, `error`,
`pendingApprovalId`, `botId`, `claudeSessionId`, `antigravityConversationId`.
All are `Optional` in the Swift `SessionSummary` Codable struct — older builds
decode these as `nil` without error.

### 2. Paging — `?limit=N&cursor=<opaque>&archivedCursor=<opaque>`

`pageItems<T>()` exported from `host/src/sessions/store.ts` pages any sorted array
via an opaque base64url cursor (encodes `{ id }` of the last returned item).
Default limit is 200, capped at 500. The response includes `nextCursor` and
`archivedNextCursor` when more pages exist.

### 3. ETag — `computeSessionListETag(body)`

SHA-1 of the serialised response body (first 16 hex digits, quoted).
The server sets `ETag` on every summary response and returns `304 Not Modified`
when `If-None-Match` matches — a no-change refresh costs ~0 bytes.

### 4. Cheap transcript scan

`toSummary()` and `toListItem()` now iterate from the end of the transcript
array instead of spreading + reversing (saves the allocation of up to 120
entries per session per request call).

### 5. All clients switched to `?view=summary`

| File | Change |
|------|--------|
| `host/web/app.js` | `refresh()` → `/sessions?view=summary` |
| `desktop/renderer/api.js` | `Api.sessions()` → `/sessions?view=summary` |
| `ios/.../Services/APIClient.swift` | `sessions(host:query:)` → adds `view=summary` param |
| `ios/.../Models/Session.swift` | `SessionsResponse` gains optional `nextCursor` / `archivedNextCursor` |

### Estimated after numbers

Projected by applying the transformation to the live payload captured above:

| Metric | Before (measured) | After (estimated) |
|--------|-------------------|-------------------|
| Session-object bytes | 384,151 | ~183,000 (−52 %) |
| Full response bytes | 398,058 | ~197,000 (−50 %) |
| Unchanged-list refresh | 398,058 | ~0 (304 Not Modified) |

## Testing

- [x] `SessionStore.toListItem` — shape, dropped fields, prompt truncation, transcript scan, backward compat for `toSummary` (`store.test.ts`)
- [x] `pageItems` — first page, second page from cursor, end-of-list, malformed cursor (`store.test.ts`)
- [x] `computeSessionListETag` — quoted string, stable, changes on body change (`store.test.ts`)
- [ ] ETag `304` round-trip — requires server integration test (`server.ts` is in TEST-EXCEPTIONS)
- [ ] iOS on device — not tested on a physical device
- [ ] Mac app build — not verified (Swift tests build to /tmp, not ~/Applications)
- [ ] Desktop Electron — not run

## Rollout

1. Ship this PR.
2. Old clients calling `/sessions` (no `?view=summary`) keep getting the full shape — no breakage.
3. Updated clients call `/sessions?view=summary` — slim payload + ETags.
4. `nextCursor` / `archivedNextCursor` are optional in Swift; unused until "load more" UI lands.

## Follow-ups

- Wire "load more" in the iOS dashboard and desktop session list.
- Persist `transcriptPreview` on `DispatchSession` so it doesn't need a transcript scan on every list request.
- Cache the sorted session list in memory (invalidated on `save()` / `persist()`) to avoid re-reading all disk files per request.
- Add server integration tests for the summary endpoint and ETag 304 round-trip.
