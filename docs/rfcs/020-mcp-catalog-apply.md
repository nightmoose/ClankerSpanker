# RFC-020 — Apply the MCP catalog per profile

**Status:** Accepted
**Date:** 2026-09-16
**Branch:** nightly-maintenance-2026-09-16-rfc020-mcp-catalog-apply
**Severity:** P1 — RFC-008/009/013 shipped the mechanism and paste map;
every live profile still has `mcpServers: null`, the `/app/` editor
has no catalog chips, and NightMoose Grok ACP still inherits the
unsigned Claude **Vercel plugin MCP** that kills workers

---

## Problem

Operators still cannot finish “who pays for which connector”:

- Host config NightMoose / Personal / FullScore / Gemini all have
  `mcpServers: null`. RFC-013 left assignment as a manual paste.
- `/app/` Profiles is a JSON textarea. No `GET /mcp/catalog`, no
  “+ Vercel” chips, no “apply this profile’s defaults”.
- `grokHome` is accepted on POST/PATCH but **not shown** in the editor.
  NightMoose has none set.
- Isolation is worse than RFC-013 assumed. `grok mcp list` is empty,
  yet `grok inspect` loads `plugin: vercel` from
  `~/.claude/plugins` (`enabledPlugins` in `~/.claude/settings.json`).
  `GROK_CLAUDE_MCPS_ENABLED=false` does **not** drop plugin MCP.
  Unsigned `https://mcp.vercel.com` still AuthRequired-kills NightMoose
  turns (RFC-012 papered the login modal; the worker still dies).

Until spawn isolation is real, pasting NightMoose’s catalog (which
*includes* Vercel, with our OAuth) races the Claude plugin’s unsigned
copy.

## Non-goals

- Mac/iOS visual MCP editor (RFC-008: `/app/` is enough).
- Auto Sign in / completing vendor OAuth for the operator.
- Antigravity `--mcp-config`.
- Bot in-process MCP.
- Mutating `~/.grok/config.toml` or uninstalling the Claude Vercel
  plugin (RFC-012 non-goal). Isolation is a per-profile `GROK_HOME`.
- Entra DCR for Azure DevOps (stdio fallback stays in the catalog).

## Fix

1. **Canonical catalog** in `host/src/mcp-catalog.ts` (ids, urls,
   commands, default assignment). `docs/MCP-CATALOG.md` stays the
   operator-readable copy; vitest keeps the fenced JSON in sync with
   the module.
2. **`GET /mcp/catalog`** — host token, no secrets. Returns servers +
   `assignments` by profile id (`nightmoose`, `personal`, `fullscore`,
   `gemini`).
3. **`POST /profiles/:id/mcp/apply-catalog`** — this machine only.
   Merges that profile’s default servers by `name` (existing rows win
   unless `replace: true`). Writes `config.json`.
4. **`/app/` Profiles editor**
   - Grok home field (same idea as Claude config dir).
   - Catalog chips that append one `ProfileMcpServer` into the JSON.
   - “Apply catalog defaults” (POST, then reload).
   - HTTP Sign in / Sign out unchanged (RFC-009).
5. **Grok ACP spawn isolation** — when `profile.grokHome` is unset,
   set `GROK_HOME` to `{dataDir}/grok-homes/{profileId}` and seed:
   - `config.toml` that sets `[compat.claude] mcps = false`,
     `[compat.cursor] mcps = false`, and `[plugins] disabled` for
     catalog/plugin ids (at least `vercel`) so Claude plugin MCP is
     not inherited.
   - `auth.json` symlink (copy fallback) to `~/.grok/auth.json` so
     NightMoose keeps this Mac’s Grok login.
   Do not overwrite an existing `config.toml`. Explicit `grokHome`
   pointing at `~/.grok` is the operator’s choice and is **not**
   rewritten.

ACP `session/new` `mcpServers` is then the profile list (RFC-008),
not the Claude Vercel plugin.

## Testing

- [x] Catalog module ids match `docs/MCP-CATALOG.md` fences
- [x] `applyCatalogDefaults` NightMoose vs FullScore vs Personal
      (no Vercel on FullScore, no Databricks on NightMoose)
- [x] Merge keeps an existing same-name row; `replace: true` does not
- [x] Isolated grok home writes `config.toml` + auth symlink; does not
      clobber an existing config
- [x] `profileProcessEnv` / session env: unset `grokHome` still sets
      `GROK_HOME` to the dataDir path when `dataDir` is passed
- [x] `make check`

## Rollout

1. `make check`
2. Kick LaunchAgent so `host/dist` loads
3. `/app/` → Profiles (this Mac) → **Apply catalog defaults** on
   NightMoose / Personal / FullScore → **Sign in** HTTP rows
4. `docs/STATUS.md` → Shipped on merge
5. Append `MAINTENANCE_LOG.md`

## Follow-ups

- Mac Host panel MCP chips (parity with `/app/`).
- Entra DCR vs pre-registered client for Azure DevOps remote.
- Disable unsigned HTTP MCP inside Grok so a leftover plugin cannot
  kill the worker even if isolation is bypassed.
