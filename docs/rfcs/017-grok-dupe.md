# RFC-017 — Duplicate Grok assistant messages

**Status:** Draft
**Date:** 2026-09-11
**Branch:** nightly-maintenance-2026-09-11-rfc017-grok-dupe
**Severity:** P1

---

## Problem

Grok assistant responses sometimes render as two adjacent NightMoose
bubbles in the transcript. The second bubble is a truncated repeat of
the first — starts mid-sentence ("new doc, and it is an **overview
only**." instead of "There is one new doc, and…"), cuts off before the
first bubble's final paragraph.

Read paths involved:

- `host/src/acp/session-manager.ts:3683-3691` — `agent_message_chunk`
  events append to `live.assistantBuffer` and emit `transcript`
  streaming events (event-only, not persisted).
- `host/src/acp/session-manager.ts:3702` — `tool_call` first calls
  `flushAssistant(live)`, which persists whatever is in the buffer as
  a new `TranscriptEntry`.
- `host/src/acp/session-manager.ts:4106-4121` — `flushAssistant()`
  writes a fresh `TranscriptEntry` (`randomUUID` id) with the whole
  buffer and clears it. Also called after `session/prompt` returns
  (line 3626) and on the error path (3650).
- `ios/.../SessionDetailViewModel.swift:511-517` — streaming chunks
  append to `streamingText`; the clear-and-reload happens on the
  non-streaming `transcript` event (line 556-558).

Two plausible root causes:

1. **Genuine model behavior.** Grok streams text, calls a tool
   (`flushAssistant` at 3702 persists entry A), does more work,
   resumes with more text, and `session/prompt` returning triggers
   `flushAssistant` again to persist entry B. If the model's second
   text happens to restart its answer (common for smaller models
   summarizing after a Read), two entries land — both starting with
   near-identical wording. No host bug; the two entries reflect what
   the model said. But the transcript renders them as duplicate-
   looking bubbles because we don't visually distinguish "same turn"
   from "distinct turns."
2. **Client-side race on reload.** If a non-streaming `transcript`
   event arrives while the client is mid-load from an earlier reload,
   the load might briefly see the pre-flush state, then re-fetch after
   the flush, layering a duplicate. Less likely — `handleSocketAndReload`
   cancels the debounced task and awaits `load()` — but plausible
   during WS reconnects (`replayMissedEvents`).

Neither hypothesis is proven without an on-disk session snapshot for
one of the affected chats. That's the first step in Rollout.

Impact if we ship without this: the transcript is confusing but
correct enough to keep working. Users think they're seeing broken
output; support surface grows over time.

## Non-goals

- Rewriting the ACP streaming pipeline. `agent_message_chunk` +
  `flushAssistant` semantics stay.
- Suppressing Grok's actual multi-part responses. If the model
  legitimately splits a turn across tool calls, both parts stay in
  the transcript.
- Changing the persisted schema. Any dedup metadata rides on
  `TranscriptEntry` alongside existing fields.

## Fix

Two-step, gated by hypothesis validation:

### Step 1 — Diagnose (this RFC before landing code)

- Add `turnId` (UUID per `session/prompt` invocation) to `LiveSession`
  and stamp it on each `TranscriptEntry` and streaming event via
  `session-manager.ts`. Cheap and reversible.
- Log entries at `flushAssistant` with `[turn <turnId>] persist entry
  {id, chars}` so a live soak shows exactly how many entries a single
  Grok turn produces.
- Pull `~/.grok-dispatch/sessions/<sid>.json` for one of Alex's
  affected sessions and eyeball the transcript array.

### Step 2 — Fix by hypothesis

- **If model behavior (multiple entries per turn):** in the client
  (`TranscriptView`), collapse consecutive assistant entries that share
  a `turnId` into a single visual bubble. `session.toolCalls` still
  render as their own rows in the interleaved timeline based on `at`;
  the assistant text just merges visually. Host stays as-is.
- **If reload race:** guard `handleSocketAndReload` so a `transcript`
  event that carries a `turnId` we already have in
  `detail.transcript` is treated as a no-op (already loaded). No host
  change.
- **If both:** land the client dedup helper; it covers both cases with
  one code path.

## Testing

- [ ] `host/src/acp/session-manager.turnId.test.ts` — vitest cases:
      each `session/prompt` produces exactly one `turnId`, propagated
      through streaming events and persisted entries.
- [ ] Manual soak — trigger a Grok turn with two Read tools, verify
      one turnId across all events even though transcript entries may
      split at flushes.
- [ ] Regression check on the affected chat: dupe bubble collapses to
      a single bubble after the client fix lands.

## Rollout

1. Land Step 1 diagnostic instrumentation on this branch (no user-
   visible change).
2. Kick the LaunchAgent, tail `~/Library/Logs/grok-dispatch-host.log`,
   reproduce the dupe.
3. Land Step 2 based on evidence.
4. `make check`
5. `docs/STATUS.md` → Accepted; append `MAINTENANCE_LOG.md`.

## Follow-ups

- If step 1 shows Grok CLI itself is re-emitting completed text, file
  upstream and add a temporary content-hash de-dupe in
  `flushAssistant` — but only after confirming the ACP contract.
- Reconsider whether `agent_message_chunk` should also be stamped
  with `turnId` for the streaming buffer; nice for future
  observability but not required for the dupe fix.
