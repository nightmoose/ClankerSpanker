# RFC-026 — Stop handing out the host token: local-only setup, QR pairing, private config

**Status:** Accepted
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc026-host-token-exposure
**Severity:** P0

---

## Problem

The host token is the only credential guarding an API that can start
agents with shell access and open `/ws/terminal`. Today it is given away:

- `GET /setup` (and `GET /`) and `GET /connect.json` are served **before**
  the auth gate with no locality check (`host/src/server.ts` ~L257–271).
  `connect.json` returns `hostToken`, a `clankerspanker://configure` deep
  link containing it, and the full project list with paths.
- The host binds `0.0.0.0` (see RFC-027), so any device on the same Wi-Fi
  can `curl http://<mac>:8787/connect.json` and take over the host.
- Every response carries `Access-Control-Allow-Origin: *`. On the host
  machine itself, a web page in the browser can `fetch()` the token from
  `localhost:8787/connect.json` and read it. A locality check alone does
  not stop that (the browser's request *is* local), and neither does it
  stop DNS rebinding (`evil.example` resolving to `127.0.0.1`).
- `~/.grok-dispatch/config.json` (host token, per-profile `GITHUB_TOKEN`,
  `NPM_TOKEN`, …) is written `0644` — world-readable.
- The iOS onboarding "Get token from Mac" button depends on the open
  `connect.json` over the LAN (`OnboardingView.fetchTokenFromLocalSetup`).
- `AppState.handleDeepLink` adds a host from any `clankerspanker://configure`
  link with no confirmation, and always mints a new `HostEndpoint` id — so
  re-pairing after a token rotation adds a **duplicate** host instead of
  updating the existing one.

## Non-goals

- Changing the bind address (RFC-027).
- Taking the token out of WebSocket URLs (RFC-028).
- Rotating the token automatically. Rotation stays a manual step
  (documented below) after this ships.

## Fix

### Host

1. **`isTrustedLocalPageRequest(req)`** (new `host/src/trusted-local.ts`).
   True only when all hold:
   - the TCP peer is this machine (`isLocalMachineAddr`);
   - the `Host` header names this machine (loopback, one of our interface
     addresses, `os.hostname()` / `<hostname>.local`) — defeats DNS
     rebinding;
   - `Sec-Fetch-Site` is absent, `same-origin` or `none`;
   - `Origin` is absent or equals `http://<Host header>`.
2. Gate `GET /setup`, `GET /` and `GET /connect.json` on it. Refusals:
   HTML 403 ("Open this page on the host machine") / JSON 403.
3. **No CORS on token-less routes.** `/setup`, `/`, `/connect.json` and
   `/mcp/oauth/callback` never send `Access-Control-Allow-Origin`.
   Token-authenticated routes keep `*`: the bearer token is never attached
   by a browser automatically, so cross-origin reads still need the token,
   and the Electron renderer (loaded from `file://`) needs CORS.
4. **`connect.json` drops `projects`.** Pairing needs URL + token only.
5. **QR pairing on `/setup`.** The page renders an inline SVG QR code of
   the deep link (server-side, `qrcode` package, MIT). The deep link now
   carries `name=<hostname>`. The advertised URL prefers the Tailscale
   address (`100.64.0.0/10`) over LAN addresses.
6. **Private config.** `saveConfig` and every other `config.json` write
   use mode `0o600`; `loadConfig` tightens an existing looser file and any
   `config.json.bak*` next to it.

### iOS / Mac

7. **Deep link asks first.** `handleDeepLink` stores a pending link and the
   root view shows "Add host *name* at *url*?" (Add / Cancel). If a host
   with the same base URL already exists, the prompt says "Update token
   for *name*?" and updates that host in place (no duplicate).
8. **Onboarding copy.** The "Get token from Mac" button stays (it still
   works from the Simulator and the Mac itself); its failure text now
   says: on the Mac open `http://localhost:8787/setup` and scan the QR
   code with the iPhone camera.

## Testing

- [ ] `trusted-local.test.ts`: loopback + `Host: localhost` → true;
      remote peer → false; `Host: evil.example` (rebinding) → false;
      `Origin: http://evil.example` → false; `Sec-Fetch-Site: cross-site`
      → false; same-origin `Origin` → true.
- [ ] `server-cors.test.ts` (helper `corsAllowedFor(path)`): false for
      `/setup`, `/`, `/connect.json`, `/mcp/oauth/callback`; true for `/sessions`.
- [ ] `config.test.ts`: `saveConfig` writes `0600`; `loadConfig` chmods a
      `0644` file and its `.bak` siblings to `0600`.
- [ ] `connect-payload.test.ts`: no `projects`; deep link has `name=`.
- [x] Manual: from the phone (cellular + Tailscale) `GET /connect.json` →
      403; on the Mac `/setup` shows a QR; scanning it on Deez Nutz shows
      the confirm prompt and updates the existing host.

## Rollout

1. `make check`; deploy the host (Mac app → Install / update host) and
   kick the LaunchAgent.
2. Rebuild Mac + phone; install on Deez Nutz.
3. **Rotate the token** (it has been network-reachable): stop the host,
   delete `hostToken` from `~/.grok-dispatch/config.json`, start the host
   (a new one is minted), re-pair the phone by scanning the `/setup` QR.
4. `docs/STATUS.md` → Shipped; `MAINTENANCE_LOG.md`.

## Follow-ups

- A "Rotate token" button in the Mac Host panel.
- RFC-027 bind address; RFC-028 WebSocket tickets.
