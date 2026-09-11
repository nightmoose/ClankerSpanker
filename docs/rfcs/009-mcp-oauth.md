# RFC-009 — Remote MCP OAuth (PKCE)

**Status:** Accepted
**Date:** 2026-08-30
**Branch:** nightly-maintenance-2026-08-30-rfc009-mcp-oauth
**Severity:** P1 — RFC-008 HTTP MCP servers still need a static bearer in
`headers`; Gmail / Office / other OAuth MCP connectors cannot sign in per
profile

---

## Problem

RFC-008 attached per-profile MCP servers (stdio or HTTP/SSE) and passed
them to Claude (`--mcp-config`) and Grok ACP (`session/new`). Remote
servers that speak MCP OAuth (Gmail, Outlook, many SaaS MCPs) still have
no way to obtain a token: the only hook is a static `Authorization`
header in the JSON textarea.

NightMoose / Personal / FullScore must each run their own OAuth dance.
Tokens must not live in `config.json` (admin GET would leak them) and
must not ride the public profile API.

## Non-goals

- Hosted claude.ai OAuth connectors (`mcp__claude_ai_Gmail__*`). Those
  are not CLI MCP.
- Client ID Metadata Documents (needs a public HTTPS metadata URL).
  DCR or a pasted `oauthClientId` is enough.
- Mac/iOS visual Sign in (host `/app/` Profiles is the v1 surface).
- Antigravity `--mcp-config` (still no flag).
- Device-code / client-credentials grants.

## Fix

1. **`host/src/mcp-oauth.ts`** — MCP Authorization (2025-11-25):
   protected-resource metadata (RFC 9728), authorization-server metadata
   (RFC 8414 / OIDC), PKCE S256, optional RFC 7591 DCR, RFC 8707
   `resource` on authorize + token. Refresh with rotation.
2. **Storage** — `{dataDir}/mcp-oauth/{profileId}/{serverName}.json`
   mode `0600`. Never in `config.json`. Never on the wire.
3. **Inject** — `toMcpJson` / `toAcpMcpServers` add
   `Authorization: Bearer …` when a fresh token exists and the server
   JSON did not already set that header. Refresh immediately before
   Claude spawn / Grok `session/new` / `session/load`.
4. **Three local-only endpoints**
   - `POST /profiles/:id/mcp/:name/oauth/start` — host token + this
     machine. Returns `{ authorizeUrl, state }`.
   - `GET /mcp/oauth/callback` — loopback browser redirect, **no** host
     token. Exchanges `code`, stores tokens, HTML “you can close this”.
     Redirect URI is `http://127.0.0.1:{bindPort}/mcp/oauth/callback`.
   - `POST /profiles/:id/mcp/:name/oauth/logout` — host token + this
     machine. Deletes the token file.
5. **Profile editor** — per HTTP/SSE server, Sign in / Sign out. Admin
   GET adds `mcpOAuth` status (connected / expiry) beside the profile,
   not inside the JSON textarea.
6. Optional server fields (textarea JSON): `oauthClientId`,
   `oauthClientSecret`, `oauthScope`. Pre-registered client skips DCR.

## Testing

- [x] PKCE S256 challenge is base64url(sha256(verifier))
- [x] start → authorize URL has `code_challenge`, `resource`, `state`
- [x] callback exchange stores tokens; logout deletes them
- [x] refresh rotates tokens; expired access token is omitted
- [x] `toMcpJson` / `toAcpMcpServers` inject Bearer and do not overwrite
      an existing Authorization header
- [x] public profile JSON still lists names only (no tokens)
- [x] `make check`

## Rollout

1. `make check`
2. Kick LaunchAgent so `host/dist` loads
3. On the Mac, `/app/` → Profiles (this machine) → HTTP MCP server →
   **Sign in** → finish the browser window
4. `docs/STATUS.md` → Shipped on merge
5. Append `MAINTENANCE_LOG.md`

## Follow-ups

- Client ID Metadata Documents once we have a stable HTTPS origin.
- Mac/iOS Sign in buttons.
- Antigravity `--mcp-config` when `agy` grows one.
