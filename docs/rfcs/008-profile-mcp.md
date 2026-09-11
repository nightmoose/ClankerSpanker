# RFC-008 — Per-profile MCP servers (payer isolation)

**Status:** Accepted
**Date:** 2026-08-29
**Branch:** nightly-maintenance-2026-08-29-rfc008-profile-mcp
**Severity:** P1 — NightMoose / Personal / FullScore currently share or
omit MCP connectors; Databricks vs Gmail vs QuickBooks must not leak
across who is paying

---

## Problem

MCP servers (Databricks, Gmail, Office, QuickBooks) belong to the
**account that pays for the profile**, not to the host or the git repo.
Today:

- Grok profiles share `~/.grok` MCP credentials unless `grokHome` is set
  (RFC-006 Phase A). Dispatch still passes `mcpServers: []` on ACP
  `session/new`.
- Claude Dispatch never passes `--mcp-config`, so headless turns only
  see whatever is in `CLAUDE_CONFIG_DIR` / project `.mcp.json`.
- There is no `AgentProfile` field the profile editor can manage.

Without a host-owned list, FullScore Gmail tools can appear on a
NightMoose turn (or the reverse).

## Non-goals

- Hosted claude.ai OAuth connectors (`mcp__claude_ai_Gmail__*`). Those
  are not CLI MCP. Follow-up: remote URL + our OAuth.
- Bot in-process loop — no MCP runtime.
- Overwriting user `~/.grok/config.toml` or `~/.claude.json`.
- Writing `.mcp.json` into the session cwd (pollutes the repo).
- Full Mac/iOS visual MCP editor (host web textarea is enough for v1).
- `--strict-mcp-config` (would drop project `.mcp.json`). Profile
  servers **merge** with project/user sources.

## Fix

1. `AgentProfile.mcpServers?: ProfileMcpServer[]` — stdio (`command`,
   `args`, `env`) or HTTP/SSE (`url`, `headers`, `transport`).
   `enabled: false` omits the server. `${VAR}` in env/headers expands
   from `profile.env` then `process.env`.
2. Materialize Claude-shaped JSON to
   `{dataDir}/mcp/{profileId}.mcp.json` at spawn (not in cwd).
3. **Claude:** `--mcp-config <that file>` on each turn.
4. **Grok ACP:** pass ACP `McpServer[]` on `session/new` and
   `session/load` (stdio / `type: http` / `type: sse`).
5. **Antigravity:** no CLI flag. Same JSON is written; agy keeps using
   its global config until a flag exists.
6. POST/PATCH `/profiles` accept `mcpServers` on this-machine requests.
   Public profile JSON lists **names** only (no env/headers).

## Testing

- [x] `toMcpJson` / `toAcpMcpServers` omit disabled, expand `${VAR}`,
      map stdio vs http
- [x] `claudeMcpConfigArgs` present only when enabled servers exist
- [x] `normalizeProfiles` keeps a named server
- [x] `make check`

## Rollout

1. `make check`
2. Kick LaunchAgent so `host/dist` loads
3. Add servers on the host Profiles editor (this machine)
4. `docs/STATUS.md` → Shipped on merge
5. Append `MAINTENANCE_LOG.md`

## Follow-ups

- Remote MCP OAuth (Gmail / Office) instead of static bearer headers.
- Antigravity `--mcp-config` when `agy` grows one.
- Mac/iOS profile editor fields.
- Bot MCP if the hunter loop ever spawns a CLI.
