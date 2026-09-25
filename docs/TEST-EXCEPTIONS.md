# Host modules without a sibling `*.test.ts`

RFC-000 grandfathers these so the check can land without a test-writing push.
**Removing a line means you added tests** — that is the intended direction.
Adding a line requires an RFC (new untested surface is the failure mode).

| Path | Why untested today |
|---|---|
| `host/src/types.ts` | Types only |
| `host/src/index.ts` | Process entry |
| `host/src/config.ts` | File I/O + discovery; needs fs fixtures |
| `host/src/platform.ts` | OS / NIC probing |
| `host/src/notify/local.ts` | Desktop notification shell-out |
| `host/src/server.ts` | HTTP+WS monolith — **highest-value follow-up** |
| `host/src/acp/client.ts` | Agent stdio client |
| `host/src/acp/runners/context.ts` | Types only (RFC-052) |
| `host/src/acp/session-manager.ts` | Partial: `session-manager.approvals.test.ts` covers resume-after-restart + opening prompt |
| `host/src/bot/index.ts` | Barrel |
| `host/src/bot/protocol.ts` | Types / constants |
| `host/src/bot/seed.ts` | One-shot hunter seed |
| `host/src/bot/store.ts` | JSON store; add tests with a temp dir |
| `host/src/bot/tools/index.ts` | Barrel |
| `host/src/bot/tools/paths.ts` | Path helpers |
| `host/src/bot/providers/index.ts` | Barrel |
| `host/src/bot/providers/anthropic.ts` | Live provider |
| `host/src/bot/providers/gemini.ts` | Live provider |
| `host/src/bot/providers/openai-compat.ts` | Live provider |
