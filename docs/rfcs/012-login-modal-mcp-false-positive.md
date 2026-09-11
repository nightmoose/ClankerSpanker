# RFC-012 — Stop the NightMoose login modal on every message

**Status:** Accepted
**Date:** 2026-09-02
**Branch:** nightly-maintenance-2026-09-02-rfc011-apns
**Severity:** P0 — Mac/iPhone pop a blocking “NightMoose needs to sign in”
alert on every follow-up. The profile is fine; a **Vercel MCP** connector
returned `AuthRequired`.

---

## Problem

Grok workers can die with:

```
AuthRequired(AuthRequiredError { www_authenticate_header:
  "Bearer error=\"invalid_token\", … resource_metadata=
  \"https://mcp.vercel.com/.well-known/oauth-protected-resource\"" })
```

That string is stored on `session.error`. Clients treat **any** substring
`oauth` as “this profile’s CLI login is dead”:

- iOS/Mac `containsAuthMarker`
- host `isAuthFailureMessage`
- Electron `AUTH_MARKERS` includes `"oauth"` and scans the **whole**
  transcript

Then `SessionDetailView` auto-presents `.alert("Sign in required")`
whenever `detail.error` changes. Sending a message sets status `running`,
which **clears** `suppressLoginModal`, so Cancel never sticks. “Open login
on this Mac” starts `grok login --oauth` — the wrong OAuth dance — and
the next turn dies the same MCP way.

NightMoose `mcpServers` in host config can be empty; Grok still loads
connectors from `~/.grok`.

## Non-goals

- Implementing Grok-side MCP OAuth inside ACP (Vercel Sign in stays on
  Host → Profiles / Grok’s own MCP login).
- Removing Vercel from `~/.grok`.
- APNs (RFC-011).

## Fix

1. **`isAuthFailureMessage`** — profile CLI login only (`please run
   /login`, `not logged in`, `failed to authenticate`, …). **Not** a
   bare `oauth` / `access token` match.
2. **`isMcpOAuthRequiredMessage`** — `oauth-protected-resource`,
   `resource_metadata`, `AuthRequired` + MCP URL. Those are **not**
   profile re-login.
3. **`mapAgentExitError`** — MCP AuthRequired becomes a plain error:
   “MCP connector needs Sign in (mcp.vercel.com)… This is not a
   NightMoose / Grok login.”
4. **iOS/Mac** — do not auto-present the Sign in alert. Banner only;
   the alert opens if the user taps Sign in. Do not re-enable the
   auto-alert when status goes `running`.
5. **Electron** — drop the `"oauth"` marker; only look at `detail.error`
   + last non-user transcript line (same as iOS).

## Testing

- [x] vitest: Vercel AuthRequired is MCP, not profile login
- [x] vitest: `please run /login` still is profile login
- [x] `make check`
- [ ] Mac: send a follow-up in the session that was looping — no modal

## Rollout

1. Kick LaunchAgent so `host/dist` loads.
2. Rebuild Mac (and Deez Nutz if the phone showed it).
3. `docs/STATUS.md` / `MAINTENANCE_LOG.md`

## Follow-ups

- Banner CTA that opens Host Profiles MCP Sign in for that server.
- Isolate Grok MCP per profile (RFC-006 grokHome) so NightMoose does
  not inherit `~/.grok` Vercel connectors.
