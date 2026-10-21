# Host modules without a sibling `*.test.ts`

The house-style check requires a sibling `*.test.ts` for every module under
`host/src`, or a row in this table. It skips `index.ts` and `types.ts` (barrels
and type-only modules). **Removing a line means you added tests.** Adding a
line requires an RFC.

Rows removed on 2026-10-21 because a sibling test now exists: `host/src/config.ts`,
`host/src/bot/seed.ts`, `host/src/acp/session-manager.ts`.

| Path | Why untested today |
|---|---|
| `host/src/platform.ts` | OS / NIC probing |
| `host/src/notify/local.ts` | Desktop notification shell-out |
| `host/src/server.ts` | HTTP+WS monolith. RFC-069's ETag 304 path lives here and has no route test |
| `host/src/acp/client.ts` | Agent stdio client |
| `host/src/acp/runners/context.ts` | Types only (RFC-052) |
| `host/src/bot/protocol.ts` | Types / constants |
| `host/src/bot/store.ts` | JSON store; add tests with a temp dir |
| `host/src/bot/tools/paths.ts` | Path helpers. Exercised from `bot/tools.test.ts`, which the checker does not count as a sibling |
| `host/src/bot/providers/anthropic.ts` | Live provider |
| `host/src/bot/providers/gemini.ts` | Live provider |
| `host/src/bot/providers/openai-compat.ts` | Live provider |
