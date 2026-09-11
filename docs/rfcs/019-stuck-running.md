# RFC-019 — Stuck "Running" + phantom pending questions

**Status:** Draft
**Date:** 2026-09-11
**Branch:** nightly-maintenance-2026-09-11-rfc019-stuck-running
**Severity:** P1

---

## Problem

Grok sessions get stuck showing `status: "running"` on the transcript
even after the model has clearly finished (last transcript entry is a
complete assistant answer, `stopReason: "end_turn"` written, ACP worker
already exited — `isLive: false`). The Mac status pill reads "Running"
and the "Still working…" pulse never clears.

Confirmed on Alex's mac at 2026-09-11 15:19Z for session
`a53072c3-ccae-4622-93e5-22d3107bd272` — REST `GET /sessions/:id`
returned:

```
status: "running"
stopReason: "end_turn"
isLive: false
pendingApproval: null
pendingQuestion: null
```

The end-of-turn block at `host/src/acp/session-manager.ts:3628-3646`
guards the flip to `idle`:

```ts
if (statusNow !== "cancelled" && statusNow !== "failed") {
  if (
    statusNow !== "awaiting_approval" &&
    statusNow !== "awaiting_question" &&
    live.pendingApprovals.size === 0 &&
    live.pendingQuestions.size === 0
  ) {
    live.session.status = "idle";
    …
  }
}
```

Two problems compound:

1. The check reads `live.pendingApprovals.size` /
   `live.pendingQuestions.size` — in-memory maps on `LiveSession` —
   instead of the persisted `session.pendingApproval` /
   `session.pendingQuestion`. The map is the wrong source of truth:
   the client only sees the persisted values, and the maps can hold
   phantoms that don't reflect what the user is being asked to act on.
2. `maybeParkAskUserQuestionFromTool` (line 3915-3926) already knows
   how to clear a stale `AskUserQuestion` when the tool call
   `completed` or `failed` — it flips `session.pendingQuestion = null`
   and `session.status = "running"`. But it **does not** remove the
   corresponding entry from `live.pendingQuestions`. That map entry
   becomes phantom immediately: persisted state is clean, in-memory
   map still gates the end-of-turn block.

Related surface: the "missing question" bug Alex flagged earlier is
the mirror image — a soft-parked question fires
`this.emitEvent(live.session, "question.needed", …)` but the client
never surfaces it. If the tool call subsequently completes,
`maybeParkAskUserQuestionFromTool` clears the persisted state without
draining the map. Turn ends, block skips, session sits "running"
forever with the client showing "Still working…".

Impact: every session that hits this path is functionally dead — the
user can't tell whether Grok is thinking, waiting, or hung. The only
recovery is to close as done and start over, which is what Alex has
been doing.

## Non-goals

- Rewriting the LiveSession bookkeeping. `live.pendingApprovals` /
  `live.pendingQuestions` remain diagnostic; we just stop treating
  them as the source of truth for gate decisions.
- Fixing the "missing question" surfacing bug in this RFC.
  Question-event delivery is a separate investigation (RFC-020
  material) — the fix here makes sure a *cleared* question doesn't
  strand the session, not that every parked question reaches the
  client.
- Retroactive repair of every stuck session on disk. One-shot patch
  for `a53072c3-…` is included as a soak step; production sessions
  will heal on their next event.

## Fix

Two small edits in `host/src/acp/session-manager.ts`, plus tests:

1. **End-of-turn block (lines 3628-3646).** Replace the
   `live.pendingApprovals.size === 0 && live.pendingQuestions.size === 0`
   check with `live.session.pendingApproval == null &&
   live.session.pendingQuestion == null`. The persisted session is
   authoritative — that's what the client renders.
2. **`maybeParkAskUserQuestionFromTool` (line 3915-3931).** When the
   underlying tool call `completed`/`failed`, drain matching entries
   from `live.pendingQuestions` alongside clearing the persisted
   fields. Symmetrical with how question resolution already handles
   it in `answerQuestion`.
3. **Tests** in `host/src/acp/session-manager.stuck-running.test.ts`
   (new file). Bump `host/test-baseline.txt` accordingly.

## Testing

- [ ] Vitest: new cases in `session-manager.stuck-running.test.ts`
      covering the four scenarios above. `test-baseline.txt` bumps
      to match.
- [ ] `make check` green.
- [ ] Manual soak on Alex's mac:
  - Kick the LaunchAgent so the fixed host loads
    (`launchctl kickstart -k gui/$(id -u)/com.nightmoose.grok-dispatch-host`).
  - Session `a53072c3-…` — send any follow-up message; the end-of-turn
    block now flips to idle instead of staying "running". A one-shot
    REST patch (see Rollout) unstucks it without needing a new turn.

## Rollout

1. Implement.
2. `make check`.
3. Bounce host: `launchctl kickstart -k gui/$(id -u)/com.nightmoose.grok-dispatch-host`.
4. One-shot repair for `a53072c3-…`: hand-patch the session file
   (`~/.grok-dispatch/sessions/a53072c3-ccae-4622-93e5-22d3107bd272.json`)
   — set `status: "idle"` and re-kick the agent so the in-memory copy
   picks up the disk state. Newer stuck sessions will heal on the next
   event under the fixed code path.
5. Update `docs/STATUS.md` → Accepted.
6. Append `MAINTENANCE_LOG.md`.

## Follow-ups

- **RFC-020 — question-event delivery.** Confirm every path that
  parks a `session.pendingQuestion` also lands a `question.needed`
  event the client actually processes. Includes tray + Mac-app
  visibility so a killed phone isn't the only surface.
- Audit `live.pendingApprovals` for the same map-vs-persisted skew.
  `parkToolApprovalFromDirect` and its resolvers look symmetrical
  today, but the same delete-from-persisted-forget-the-map pattern
  could exist somewhere I haven't traced.
- Consider dropping `live.pendingApprovals` / `live.pendingQuestions`
  as gate inputs entirely — reduce them to instrumentation.
