# RFC-013 — Profile MCP catalog (who gets which connector)

**Status:** Accepted
**Date:** 2026-09-03
**Branch:** nightly-maintenance-2026-09-09-rfc013-profile-mcp-catalog
**Severity:** P1 — RFC-008/009 shipped the *mechanism*; every profile still
has `mcpServers: null`. Grok then inherits `~/.grok` marketplace MCP
(Vercel `AuthRequired` killed NightMoose turns — RFC-012). We need a
**named catalog** and a **payer map**, not another textarea full of
guessed URLs.

---

## Problem

Operators cannot answer “what MCP should NightMoose vs FullScore run?”
without hunting vendor docs. Today:

- Host profiles NightMoose / Personal / FullScore / Gemini all have
  `mcpServers: null` (`~/.grok-dispatch/config.json`).
- RFC-008 said Databricks vs Gmail vs QuickBooks must not leak across
  who is paying. Nothing in-repo lists the actual servers.
- Grok still loads MCP from `~/.grok` (marketplace GitHub + whatever
  `grok mcp add` left behind). That is how `mcp.vercel.com` appeared on
  a NightMoose session with no profile JSON.
- Claude already used hosted connectors (Vercel, Supabase, Gmail,
  Slack, Databricks Genie, Notion) — those are **not** CLI MCP and do
  not flow through RFC-008.

Asked for this pass: **Vercel, Fly.io, Supabase, GitHub, Databricks,
Azure data ops, Notion**, plus anything else this estate actually uses.

## Non-goals

- Replacing RFC-008/009 (shape, OAuth PKCE, token store stay).
- Hosted `mcp__claude_ai_*` connectors.
- Antigravity `--mcp-config` (still no flag).
- Bot in-process MCP.
- Auto-signing-in every catalog row on first launch.
- Putting tokens or org names that are secrets into git. Catalog JSON
  uses placeholders (`YOUR_ADO_ORG`, `${GITHUB_TOKEN}`).

## Fix

A **checked-in catalog** + **default assignment by profile**. Operator
pastes (v1) or later taps “Add from catalog” on `/app/` Profiles.

Authoritative copy-paste: [`docs/MCP-CATALOG.md`](../MCP-CATALOG.md).

### Catalog (v1)

Official / vendor-hosted preferred. Stdio only when there is no stable
remote.

| Id | Vendor | Transport | Auth | Why we have it |
|---|---|---|---|---|
| `github` | GitHub | HTTP `https://api.githubcopilot.com/mcp/` | OAuth (RFC-009 Sign in) | All Nightmoose GitHub work |
| `vercel` | Vercel | HTTP `https://mcp.vercel.com` | OAuth | Smolder, Drea, ContractGate, Mercenary, Dirt Work, BlessingBox |
| `fly` | Fly.io | stdio `flyctl mcp server` | flyctl already logged in | Machines / apps if we run anything on Fly |
| `supabase` | Supabase | HTTP `https://mcp.supabase.com/mcp` (fallback stdio `@supabase/mcp-server-supabase`) | OAuth or access token in profile env | BlessingBox, Smolder, Dirt Work, Mercenary |
| `databricks` | Databricks | stdio or workspace HTTP (URL is per-workspace) | PAT in `profile.env` | FullScore client data |
| `azure-devops` | Azure DevOps | HTTP `https://mcp.dev.azure.com/{organization}` | Entra (RFC-009 may need a pre-registered client — Entra often rejects DCR). Fallback stdio `@azure-devops/mcp` | Shore / consulting; Azure DevOps repos stay off GitHub |
| `azure` | Microsoft Azure MCP | stdio / remote `https://mcp.management.azure.com` | Entra | Data Factory / storage / Fabric-adjacent “data ops” |
| `notion` | Notion | HTTP `https://mcp.notion.com/mcp` | OAuth | Ops notes / product docs |

**“Azure data ops” is two servers:** Azure DevOps (boards/repos/pipelines)
and Azure MCP (cloud data plane). Do not collapse them.

### Also worth it (v1.1, not blocking)

These already show up in this machine’s Claude/Grok plugin caches or
estate apps. Add when the matching profile is doing that work.

| Id | Notes | Default profile |
|---|---|---|
| `linear` | `https://mcp.linear.app/mcp` — Grok marketplace already has it | NightMoose if we track Nightmoose work there |
| `stripe` | Dirt Work quoting / deposits | NightMoose |
| `sentry` | production errors | NightMoose |
| `context7` | `https://mcp.context7.com/mcp` — current library docs | NightMoose + Personal |
| `slack` | Claude.ai already connected; CLI MCP is a later OAuth row | Personal |
| `cloudflare` | only if a product actually sits on CF | NightMoose |
| `playwright` | stdio `@playwright/mcp` — browser soak, not a SaaS account | any, opt-in per session later |

**Not in the catalog:** Gmail / Google Drive / Microsoft 365 / QuickBooks
on NightMoose (RFC-008). Those go on **Personal** or **FullScore** when
we add them, never on NightMoose.

### Default assignment (payer isolation)

| Profile | Backend | Gets |
|---|---|---|
| **NightMoose** | Grok | `github`, `vercel`, `fly`, `supabase`, `notion`, later `stripe` / `sentry` / `context7` |
| **Personal** | Claude | `github` (personal account — **separate Sign in**), `notion` (personal workspace), later Gmail/Slack |
| **FullScore** | Claude | `databricks`, `azure-devops`, `azure`, `github` only if that chip needs GH |
| **Gemini** | Antigravity | none until `agy` grows `--mcp-config` |

Same server **name** on two profiles is fine: tokens live in
`~/.grok-dispatch/mcp-oauth/{profileId}/{name}.json`. NightMoose GitHub
OAuth must not be FullScore’s GitHub OAuth.

### Grok must not inherit `~/.grok` MCP

RFC-006 Phase A (`grokHome`) is a **prerequisite** for NightMoose MCP.
Until Grok ACP is isolated, even a perfect profile JSON still races the
CLI’s global marketplace (the Vercel crash). This RFC does not implement
`grokHome`; it **blocks NightMoose MCP soak** on that.

When `grokHome` exists, profile `mcpServers` is the only list ACP
`session/new` should see (RFC-008 already passes the array). Empty list
must mean empty, not “fall back to ~/.grok”.

### Operator v1 (no new UI)

1. Kick host.
2. `/app/` → Profiles (this Mac) → paste the profile’s array from
   [`MCP-CATALOG.md`](../MCP-CATALOG.md).
3. HTTP rows: **Sign in**. Stdio rows: token in that profile’s
   Environment (`DATABRICKS_TOKEN`, etc.).
4. Dispatch a throwaway turn; confirm tools appear **only** on that
   chip.

### Later (follow-up RFC, not this one)

Profiles editor: catalog chips (“+ Vercel”) that append one
`ProfileMcpServer` object. Optional `GET /mcp/catalog` serving the
checked-in JSON (names + urls, no secrets).

## Testing

- [x] Catalog JSON in `docs/MCP-CATALOG.md` parses (`host/src/mcp-catalog.test.ts`)
- [ ] Manual: NightMoose + Vercel Sign in; FullScore turn must **not**
      see Vercel tools (blocked on RFC-006 `grokHome` on the NightMoose
      profile — do not paste NightMoose MCP until that is set)
- [ ] Manual: MCP AuthRequired on an unsigned Vercel still does **not**
      open the NightMoose login modal (RFC-012)
- [x] `make check`

## Rollout

1. Land catalog + this RFC (Accepted).
2. Operator paste + Sign in per profile from [MCP-CATALOG.md](../MCP-CATALOG.md).
   Skip NightMoose until that profile has `grokHome`.
3. RFC-006 `grokHome` before trusting NightMoose isolation.
4. Follow-up RFC for catalog chips in `/app/`.

## Follow-ups

- Editor chips + `GET /mcp/catalog`.
- Entra DCR vs pre-registered client for Azure DevOps remote (may have
  to stay on local `@azure-devops/mcp` until Entra allows this loopback
  client).
- Disable unsigned HTTP MCP at Grok spawn so AuthRequired cannot kill
  the worker (hard-fail that one server, keep the session).
