# RFC-065 — The hosted site gets no shell and no profile secrets

**Status:** Accepted
**Date:** 2026-10-20
**Branch:** rfc-065-browser-origin-hardening
**Severity:** P1

---

## Problem

Since RFC-058, the browser UI also runs from `https://clankerspanker.tech` and keeps the
host token in `localStorage` on that origin. It reaches the gateway at `http://127.0.0.1:8787`
(Chrome, Local Network Access) or through `tailscale serve` (RFC-058 phase 2). RFC-059/060 made
`POST /exec` and `/host/update` native-only (`nativeOnlyRefusal`, `host/src/trusted-local.ts`).
A live eval on 2026-10-20 found two paths those rules missed. Both were reproduced against the
gateway on `main` (7fca4b3):

1. **Host terminal.** `/ws/terminal` checked only `wsUpgradeAuthorized` (token or single-use
   ticket). A script sending `Origin: https://clankerspanker.tech` got a ticket from
   `POST /ws/ticket` (CORS allows that origin) and opened a login shell, over loopback and over
   the serve listener.
2. **Profile secrets.** `isLocalMachineRequest` looks only at the TCP peer and
   `Tailscale-User-Login`. A loopback call from the hosted origin counted as "this machine", so
   `GET /profiles?admin=1` returned every profile's `env` (provider API keys). CORS let the page
   read it, and profile create/edit/delete, MCP catalog apply and MCP sign-in were open the same
   way. `site/docs` described this as intended.

The site also sent no Content-Security-Policy. A single injected script on the hosted origin
therefore meant a shell on the user's machine and leaked API keys.

## Non-goals

- Changing who may use sessions, dispatch or approvals with the token. The hosted site keeps
  those; they are the product.
- Per-device tokens, or tightening the `*` CORS that native and Electron clients get. Those are
  follow-ups from RFC-058.
- Profile administration on the hosted site. It moves to the gateway's own `/app/` page and the
  Mac app.

## Fix

- `isForeignBrowserOrigin(req)` (`host/src/trusted-local.ts`): true when the request carries an
  `Origin` other than `null` and other than `http://<Host header>`. Native clients send no
  `Origin`, the Electron renderer sends `null` (it loads from `file://`), and the gateway's own
  page matches its Host.
- `isLocalMachineReq` in `host/src/server.ts` is now `isLocalMachineRequest(req) &&
  !isForeignBrowserOrigin(req)`. Every local-only route (admin profiles, profile edits, MCP
  catalog apply and OAuth) follows. The legacy `?token=` WebSocket path uses the same rule.
- `/ws/terminal` upgrades call `nativeOnlyRefusal`, the RFC-059/060 rule, and answer `403` before
  the upgrade. Every client opens the terminal from the gateway's own `/app/terminal.html` (the
  Mac and iOS apps in a web view, Electron in an iframe, the hosted site by linking there), so
  their `Origin` is the gateway and they are unaffected.
- `vercel.json` sends `Content-Security-Policy` (`script-src 'self'`, `object-src 'none'`,
  `base-uri 'self'`, `frame-ancestors 'none'`, `connect-src` with loopback, `https:` and
  `wss:`), plus `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
  `Permissions-Policy` and `Cross-Origin-Opener-Policy`. `style-src` keeps `'unsafe-inline'`
  because the UI sets `style=` attributes. This delivers RFC-058 phase 4's headers.
- `escapeHtml` in `host/web/app.js` also escapes `'`. No live bug: `escapeAttr` already did, and
  no template puts escaped text in a single-quoted attribute.
- `site/docs` "Loopback" and "A script on this origin" now say what the hosted site can and
  cannot do.

## Testing

- [x] `host/src/browser-origin-hardening.test.ts` (10): `isForeignBrowserOrigin` cases; the
  terminal is refused for the hosted origin, another website, a valid ticket from the hosted
  origin, and a serve-listener caller, while native and same-origin callers reach the token check;
  `?admin=1` returns secrets to native and `Origin: null` callers but not to the hosted origin;
  `DELETE /profiles/:id` from the hosted origin is `403`. Five of these fail on the code before
  this change.
- [x] `host/web/hosted-headers.test.js` (4): `vercel.json` headers, and no inline scripts or event
  handlers in the shipped pages.
- [x] Full host suite green; baseline ratcheted.
- [ ] Vercel preview: page loads, Settings connects to a gateway, no CSP violations in the console.
- [ ] Live gateway after install: the earlier probe (hosted-origin ticket → `/ws/terminal`) gets
  `403`; `?admin=1` from the hosted origin returns no `adminProfiles`.

## Rollout

1. Merge. Vercel deploys the headers with `main`.
2. Install / update host on each gateway machine to pick up the gateway change.
