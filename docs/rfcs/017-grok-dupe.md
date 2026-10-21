# RFC-017 — Duplicate Grok assistant messages

**Status:** Shipped
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

Read paths (line numbers from the original note drifted when RFC-055
moved Grok inbound to `host/src/acp/runners/grok-events.ts`):

- `agent_message_chunk` appends to `live.assistantBuffer` and emits a
  streaming `transcript` event. The event is not persisted.
- `tool_call` calls `flushAssistant` first, which writes a new
  `TranscriptEntry` (`randomUUID` id) for the whole buffer and clears it.
- `session-manager.ts` `promptTurn` calls `flushAssistant` again when
  `session/prompt` returns, and on the error path.
- The web transcript renders one bubble per persisted entry. It has no
  streaming buffer, so a second saved entry is a second bubble on every
  client after reload.
- iOS `isRedundantStreamingChunk` already drops a live streaming chunk
  of 8+ characters when the last assistant entry contains it. The
  comment there records the ACP behavior: Grok emits overlapping
  `agent_message_chunk`s. That guard never runs on the persisted entry,
  so the second bubble comes back on the next load.

Root cause: the second bubble is not a second answer. It is a slice of
text already flushed in the same turn. Grok streams the full reply, a
tool call flushes it, then an overlapping `agent_message_chunk` arrives
whose text starts mid-sentence and stops before the first entry's last
paragraph. The host appended that slice to the empty buffer and the
prompt-end flush saved it as its own `TranscriptEntry`. A model that
really continues after the tool — new text that is not a slice of what
this turn already saved — still gets its own entry.

No affected-session snapshot is in the repo. The shape of the reported
bubble (a middle slice, not a restart from the first word) matches the
overlapping-chunk path, and the iOS guard was written for that path.

## Non-goals

- Rewriting the ACP streaming pipeline. `agent_message_chunk` +
  `flushAssistant` semantics stay.
- Suppressing Grok's actual multi-part responses. If the model
  legitimately splits a turn across tool calls, both parts stay in
  the transcript.
- Changing the persisted schema. Any dedup metadata rides on
  `TranscriptEntry` alongside existing fields.

## Fix

`mergeGrokAssistantChunk` in `host/src/acp/runners/grok-events.ts` folds
each `agent_message_chunk` before it touches the buffer:

- A sliding window or a cumulative snapshot updates the open buffer by
  the new tail only, so one bubble does not repeat itself.
- A chunk of 24+ characters that is a verbatim slice of assistant text
  already flushed in this turn is dropped. No streaming event, no second
  entry. `promptTurn` clears that committed text at the start of the
  next turn, so a later turn can repeat an earlier answer.
- `flushAssistant` applies the same check to the whole buffer. A replay
  that arrived as pieces shorter than 24 characters is dropped once the
  pieces join into a slice of text this turn already saved.

A follow-up sentence that is not contained in the committed text is
persisted, including when it shares a short phrase with the earlier
entry. Persisted `TranscriptEntry` fields are unchanged.

## Testing

- [x] `host/src/acp/runners/grok-events.test.ts` — the reported shape
      (full reply, tool-call flush, mid-sentence slice, prompt-end
      flush) leaves one transcript entry. A real follow-up sentence
      still produces a second entry. Sliding-window and cumulative
      chunks compose into one buffer. A short reply that happens to
      occur inside the previous text is kept.
- [ ] Manual soak — a Grok turn with two Read tools on an affected
      chat. Not run here. See Follow-ups.

## Rollout

1. Land the chunk merge and the flush check.
2. `make check`
3. Record the status on the row in `docs/rfcs/README.md` (RFC-000).

## Follow-ups

- Manual soak: trigger a Grok turn with two Read tools and confirm the
  affected chat no longer grows a second mid-sentence bubble. This
  environment has no Grok CLI session and no iOS device.
- File the overlapping `agent_message_chunk` behavior upstream. The
  host drop is the guard while that stands.
- `turnId` on streaming events was the original diagnostic step. It is
  not required to stop the duplicate entry.
