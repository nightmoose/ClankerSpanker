# RFC-006 — Backend parity pass (Grok / Claude / Antigravity / Bot)

**Status:** Draft
**Date:** 2026-08-28
**Branch:** nightly-maintenance-2026-08-28-rfc006-backend-parity
**Severity:** P1 — profile fields silently no-op on some backends; Grok
profiles trip over a shared `~/.grok/auth.json`

---

## Problem

Each backend runner interprets `AgentProfile` differently. Gap matrix
from `host/src/{acp/session-manager.ts, claude/runner.ts, antigravity/runner.ts, bot/runner.ts, profiles.ts}`:

| Axis | Grok | Claude | Antigravity | Bot |
|---|---|---|---|---|
| Per-profile home dir | ❌ shared `~/.grok` | ✅ `claudeConfigDir` | ✅ `antigravityConfigDir` | ❌ in-process |
| `systemPrompt` threaded | ❌ (no ACP field) | ✅ `--append-system-prompt` | ❌ flag never set | ✅ (`buildMessages`) |
| `toolAllowlist` threaded | post-hoc approval only | post-hoc approval only | ❌ ignored | ✅ pre-flight |
| Model sentinel | ❌ always `--model` | ✅ `isClaudeModelSentinel` | ⚠️ hardcoded 3-string exclusion | N/A (provider select) |
| `profile.env` reaches provider | ✅ spawn | ✅ spawn | ✅ spawn | ❌ bot loop skips it |

Consequences today:

- Every Grok profile (nightmoose, any future work profile) shares one
  `~/.grok/auth.json`, one `~/.grok/mcp_credentials.json`, one session
  history. Signing a second profile in signs the first one out.
- Setting `profile.systemPrompt` on an Antigravity profile silently
  does nothing — the runner never reads the field.
- `toolAllowlist` reads like a pre-flight gate but is post-hoc approval
  matching on 3 of 4 backends. Names lie.
- Stale model slugs on Grok/Antigravity profiles pin the CLI to that
  string instead of letting the CLI pick its account default the way
  Claude does.
- Setting an API key on a Bot profile's `env` map doesn't reach the
  provider client because Bot never merges `profile.env` into runtime.

Also blocks per-profile MCP work: Grok has no per-profile config path
to write MCP server config into.

## Non-goals

- Per-profile MCP servers — separate RFC on top of Phase A.
- Rewriting `profileHasCredentials` into one function — cosmetic.
- Extending the ACP protocol upstream for a real `systemPrompt` field.
  Phase B uses first-message injection as the workaround.
- Making Bot spawn a subprocess — it stays in-process; only its env
  handling changes.

## Fix

Three phases in this branch, landed as separate commits. Each is
independently useful; land in order.

### Phase A — Grok home isolation

1. Add `grokHome?: string` to `AgentProfile` (`host/src/types.ts`).
2. `profileProcessEnv` sets `GROK_HOME` when `profile.grokHome` is set
   (`host/src/profiles.ts:167`).
3. `profileHasCredentials` for `grok` / `bot` probes
   `<grokHome>/auth.json` before falling back to the shared paths.
4. `normalizeProfiles` accepts and trims `grokHome`.
5. Profile editor payloads (Mac / iOS / Electron) get a "Grok home"
   field paralleling the existing Claude / Antigravity dir fields.
   Backend accepts it; clients wire the input in a follow-up commit
   if the visual work is big.

### Phase B — Prompt + model sentinel parity

1. Antigravity runner threads `profile.systemPrompt` via the CLI's
   system-instruction flag. If `agy` has no flag, prepend the prompt
   to the first user turn (Grok ACP idea, reused).
2. Grok ACP: inject `profile.systemPrompt` as a synthetic first user
   preamble on session start. Skip if the session was resumed with
   prior turns.
3. Promote `isClaudeModelSentinel` → generic `isModelSentinel(backend,
   model)` in `profiles.ts`, with per-backend allow-lists:
   - Claude: `claude`, `default`, `""`
   - Antigravity: `antigravity`, `agy`, `gemini`, `default`, `""`
   - Grok: `grok`, `grok-build`, `default`, `""`
   Delete the hardcoded exclusion at
   `host/src/antigravity/runner.ts:59` and any Grok equivalents.

### Phase C — toolAllowlist semantics + Bot env

1. Decide semantics: `toolAllowlist` is **pre-flight**, matching Bot.
   Post-hoc auto-approval keeps working under a renamed field
   `autoApprovalSignatures` (`AgentProfile`), backfilled from
   `toolAllowlist` on load for one release.
2. Claude runner: pass `--allowedTools` from the list.
3. Antigravity runner: pass the equivalent (verify flag).
4. Grok ACP: translate the list to auto-approve rules server-side and
   reject tool calls whose name isn't on the list.
5. Bot runner: merge `profile.env` into runtime env before
   `pickProvider(profile)` reads keys, mirroring the spawn backends
   (`host/src/bot/runner.ts:40`).

## Testing

Per phase:

**Phase A**
- [x] `profileProcessEnv` unit test: `grokHome` present → `GROK_HOME`
      set; absent → not set.
- [x] `profileHasCredentials` vitest: profile with `grokHome` and no
      shared auth returns true when `<grokHome>/auth.json` exists.
- [x] `normalizeProfiles` accepts `grokHome`, trims whitespace,
      surfaces it in the normalized shape.

**Phase B**
- [x] Antigravity runner spawn test: args include system-prompt when
      `profile.systemPrompt` set.
- [x] Grok ACP session-manager test asserts synthetic preamble
      emitted once per fresh session; not on resume.
- [x] `isModelSentinel` table-driven test covering all four backends
      and each sentinel string.

**Phase C**
- [ ] Claude runner: `--allowedTools` present when `toolAllowlist`
      set, absent when empty.
- [ ] Bot runner: `profile.env` values reach `pickProvider` (spy on
      env snapshot).
- [ ] Manual: profile with `toolAllowlist=[Read, Grep]` cannot fire
      `Write` on any backend.

## Rollout

Per phase (three separate commits, one merge):

1. `make check` + `cd host && npm test && npm run typecheck && npm run build`
2. Kick LaunchAgent, rebuild Mac / Nomad if UI wiring touched
3. `docs/STATUS.md` → Shipped on merge
4. Append `MAINTENANCE_LOG.md` per phase letter

## Follow-ups

- **Per-profile MCP servers RFC** — extend `AgentProfile` with
  `mcpServers[]`, materialize `.mcp.json` at spawn, use
  `--mcp-config` for Claude and Grok's compat loader for free.
  Depends on Phase A.
- ACP protocol PR upstream for a real `systemPrompt` field, replacing
  Phase B's first-message workaround.
- Collapse `profileHasCredentials`'s four branches into one table
  once all backends share the same env-var / config-dir contract.
- Client UI for `grokHome` if not wired in Phase A.
