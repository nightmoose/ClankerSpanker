# RFC-054 — Claude MCP config uses `type`, not `transport`

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc054-claude-mcp-type
**Severity:** P1

## Problem

Every Claude turn on a profile with an authorised URL MCP server (Personal:
`github`) failed before replying: "Invalid MCP configuration:
mcpServers.github: Does not adhere to MCP server configuration schema"
(surfaced by RFC-053). `toMcpJson` wrote `transport: "http"`; Claude's
`--mcp-config` schema wants `type: "http" | "sse"`, and a URL entry with no
`type` is read as stdio.

## Fix

`toMcpJson` (used only by the Claude runner) always writes `type` for URL
servers — `"sse"` when the profile says so, else `"http"` — and never
`transport`. Grok ACP keeps its own format (`toAcpMcpServers`).

## Testing

- [x] `mcp.test.ts`: sse / http / unspecified all get `type`, none keep
      `transport`.
- [x] Live: Personal-profile Claude session in `cs-ux-sandbox` completes.
