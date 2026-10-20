# RFC-058 — Host the product at clankerspanker.tech

**Status:** Accepted (phases 1 and 2 in production since 2026-10-19; phases 3 and 4 open)
**Date:** 2026-10-19
**Branch:** cursor/rfc-058-hosted-web-61b2
**Severity:** P1 — the public product has to live on this origin before the company submits to the .tech No Excuses Fund (internal target 2026-12-09, submissions close 2026-12-15)

---

## Problem

The browser control plane (`host/web/`, served at `/app/` by `host/src/server.ts`) is only reachable on the gateway's own listener, default port 8787, bound to loopback plus Tailscale addresses (`host/src/bind-addresses.ts`, `bindHost: "auto"`). A visitor to a public URL cannot use the product. The README's quickstart points at `http://localhost:8787/setup` and `http://localhost:8787/app/`.

The company is entering ClankerSpanker in the [.tech No Excuses Fund](https://noexcuses.tech). The fund site's own FAQ, retrieved 2026-10-19, says:

- FAQ 03: the product must run on `.tech`, with its primary website on that domain. A redirect or a standalone landing page does not qualify. A product that already lives elsewhere has to meet this before submission.
- FAQ 04: the product must be live by the time of submission, and no later than 15 December 2026.

The separate "official rules" linked from that page were not a distinct URL this pass (`https://noexcuses.tech/terms` returned the same landing page). The owner reads the rules document the fund site links as "terms & conditions" before submitting. This RFC follows FAQ 03 and 04 only.

`clankerspanker.tech` did not resolve on 2026-10-19 (`getaddrinfo` returned name-not-known). A public RDAP lookup of the name returned 404. Registration is an owner task until a registrar receipt says otherwise.

Local-first stays the product promise, quoted from the README: nothing leaves the user's machines except what the agents themselves send to their providers. Loading the static page will contact the static host (normal web hosting). Prompts, transcripts, files, tool output, profile secrets, and the host token do not.

## Non-goals

- A second gateway, a hosted agent, or a public demo gateway with a shared token.
- Tailscale Funnel, or any relay or tunnel the company operates (Cloudflare Tunnel, ngrok, or a websocket splice). Those are rejected in §1 with the reason.
- Company accounts, and any Supabase project, in the slices that have to be live for the fund. The smallest future backend is described in §2 so a later RFC does not start from scratch.
- Replacing the Mac app, the Electron client, or the phone app. They keep talking to the gateway directly.
- Per-device host tokens, CORS origin lock-down, and revoking one browser without rotating the phone. Follow-ups.
- Serving `/setup` or `/connect.json` to any browser that is not on the host machine. RFC-026 stands.

## Fix

Five decisions. Implementation is later phases; this document changes no runtime code.

### 1. How an HTTPS page reaches the user's gateway

**Decision.** Two paths, both direct from the browser to the user's gateway. No company hop in the middle.

1. **Same machine (first slice).** `https://clankerspanker.tech` calls `http://127.0.0.1:<bindPort>` on the machine where the gateway is already running. Chrome's Local Network Access permission is what makes that legal. This is the path that can ship before any host change, and it is the path a reviewer uses to try the product on their own laptop.
2. **Other devices on the user's tailnet (second slice).** The user runs `tailscale serve` against a new loopback-only listener. The page stores `https://<node>.<tailnet>.ts.net` and calls that. Tailscale terminates TLS on the user's node. The tailnet ACL still applies.

The host token and WebSocket tickets stay as they are. `host/src/auth.ts` requires `Authorization: Bearer` (or the legacy token headers). `host/src/ws-tickets.ts` trades that bearer, via `POST /ws/ticket`, for a single-use ~30s ticket. `host/web/app.js` `connectWs()` already opens `wss:` when `baseURL` is `https:` and `ws:` otherwise, with `?ticket=`, never `?token=` off the machine (`wsUpgradeAuthorized` in `host/src/server.ts`).

#### Why a public HTTPS page cannot call `:8787` unchanged

MDN's [mixed content](https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content) definition: `fetch()` and WebSocket from an HTTPS document to `http:` / `ws:` are blockable mixed content. Browsers block them. `https://clankerspanker.tech` → `http://127.0.0.1:8787` and `ws://127.0.0.1:8787/ws` are in that class. A localhost page is itself a secure context; that does not make it a legal subresource of a public HTTPS page.

Chrome's exception is Local Network Access, documented in the [Chrome developer blog, 2025-06-09, updated 2025-09-29](https://developer.chrome.com/blog/local-network-access): the permission prompt ships in Chrome 142. A public site may request loopback or local after the user grants `loopback-network` or `local-network`, and Chrome then skips mixed-content blocking when it knows the target is local before DNS:

- a private IP literal, or
- a `.local` name, or
- `fetch(..., { targetAddressSpace: "loopback" | "local" })`.

The [Local Network Access spec](https://wicg.github.io/local-network-access/) classifies `100.64.0.0/10` (carrier-grade NAT, which is Tailscale's IPv4 range) as **local**, and `127.0.0.0/8` as **loopback**. So a public page calling a `*.ts.net` name that resolves to `100.64/10` still raises Chrome's local-network prompt even when both sides are HTTPS. MDN's [local network access](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access) page is the cross-browser statement: the permission exists in browsers that implement the spec. Firefox and Safari are not claimed here. Phase 1's supported browser is Chrome; phase 2's ts.net path is plain HTTPS and is meant to work in any browser. The gateway's own `http://127.0.0.1:8787/app/` remains the same-origin page for other browsers. The `.tech` site does not redirect to it (FAQ 03).

WebSocket needs its own option. [Chrome 154 release notes](https://chromestatus.com/release-notes/154) (scheduled stable 2026-09-22) add `new WebSocket(url, { targetAddressSpace: "loopback" | "local" })`, with the same permission and the same "name must actually resolve there" rule. The tester records the Chrome version. Live updates on the loopback path are not done until that option connects.

CORS is already the right shape for a foreign origin that presents the token. `corsAllowedFor` (`host/src/trusted-local.ts`) leaves `Access-Control-Allow-Origin: *` on token routes, including `POST /ws/ticket`, and sets no CORS headers on `/`, `/setup`, `/connect.json`, or `/mcp/oauth/callback`. `OPTIONS` is answered before the auth check (`host/src/server.ts`), so the preflight from `https://clankerspanker.tech` succeeds. `*` does not put the token on the request; `host/web/app.js` attaches `Authorization` itself. Tightening `*` to an allow-list is a follow-up because the Electron renderer still relies on the wildcard (the comment in `trusted-local.ts`).

#### Loopback call shape (phase 1, client only)

In `host/web/app.js`, when `baseURL`'s host is `localhost`, `127.0.0.1`, or `[::1]`:

- `fetch` from `api()` and from the `/connect.json` refresh passes `{ targetAddressSpace: "loopback", mode: "cors" }`.
- `connectWs()` passes `{ targetAddressSpace: "loopback" }` as the WebSocket options bag.

`targetAddressSpace` is set only for those hosts. The Chrome 154 note says a hostname that does not resolve into the declared space is blocked. An `https://…ts.net` URL must not send `targetAddressSpace: "loopback"`.

`/connect.json` token refresh stays same-origin only (`refreshTokenFromHost` already bails when `baseURL` is not `window.location.origin`). The hosted page never reads it. The user pastes the token from `/setup` on the host machine. The token lives in `localStorage` on the `clankerspanker.tech` origin, as it does today on the gateway origin.

#### Tailscale Serve (phase 2, host change required first)

`tailscale serve <port>` proxies `http://127.0.0.1:<port>` and prints an `https://<node>.<tailnet>.ts.net` URL that is available inside the tailnet. Documented on [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) (last validated 2026-01-20). HTTPS certificates have to be enabled for the tailnet; Serve prompts for that. Certificate issuance publishes the machine name on the Certificate Transparency log ([Enabling HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates)). The operator picks a non-sensitive machine name before enabling it.

Serve adds `Tailscale-User-Login`, `Tailscale-User-Name`, and `Tailscale-User-Profile-Pic` on the request to the backend, and strips those headers if the client sent them. Funnel traffic does not get the headers. Tagged nodes do not get them either. Tailscale's own guidance: a backend that trusts the headers listens on localhost only, otherwise anyone who can reach the port can forge them.

That collides with `isLocalMachineReq` (`host/src/server.ts`), which treats a loopback TCP peer as "this machine" and therefore allows profile create/delete, `GET /profiles?admin=1` (full records, including `env`), MCP catalog apply, and MCP OAuth. Pointing today's `:8787` at `tailscale serve` would make every tailnet caller look local, because the peer is tailscaled on loopback.

Phase 2 adds a **serve listener**, default off:

- Config `serveBindPort` (number, unset = off). When set, listen on `127.0.0.1` only, on that port, and run the same HTTP handler.
- On that listener, a request without a non-empty `Tailscale-User-Login` is `403` for every path, including `/health`. Funnel adds no identity header, so Funnel pointed at this port fails closed. Tagged nodes fail closed too; they are unsupported on this listener (Serve docs: headers are not populated for tagged devices).
- `isLocalMachineReq` is false when `Tailscale-User-Login` is present, on either listener. Direct loopback to `:8787` with no such header stays local, which is the Mac app, Electron, and `/setup`.
- The serve listener does not mount `/`, `/setup`, `/connect.json`, or `/mcp/oauth/callback`.
- Profile secret routes stay on the local-machine gate. A tailnet browser, even with the host token, gets the public profile list and `?usage=1`, not `adminProfiles`.
- The operator runs `tailscale serve` against `serveBindPort`, not against `8787`. The page's Host URL is the printed `https://…ts.net` origin.

**As implemented** (`host/src/tailscale-serve.ts`, wired in `host/src/server.ts`):

- `serveBindPort` must be an integer port different from `bindPort`. Anything else logs a warning and leaves the listener off. The listener binds `127.0.0.1` only, never `::1` or a Tailscale address.
- The gate runs before routing. No non-empty `Tailscale-User-Login` → `403` JSON, every method and path, `OPTIONS` preflights included. The same check runs on WebSocket upgrades, which get a raw `403` and a closed socket before `ws` sees them. With the header, `/`, `/setup`, `/connect.json`, and `/mcp/oauth/callback` (trailing slash folded) are `404`. Everything else goes to the normal handler, so the token is still required and `/app/` is served (a tailnet browser can also use `https://…ts.net/app/` same-origin).
- "Header present" for the local-machine rule means the header exists at all, empty value included. One helper, `isLocalMachineRequest`, backs `isLocalMachineReq`, the legacy `?token=` WebSocket check, and the "local client present" set that suppresses desktop notifications. `isTrustedLocalPageRequest` (`/setup`, `/connect.json` on `:8787`) also refuses a request that carries the header.
- CORS is unchanged: the serve listener runs the same `corsHeadersFor`, so `https://clankerspanker.tech` is reflected there too. The `Access-Control-Allow-Private-Network` opt-in from phase 1 is sent but not needed for a `https:` ts.net target; Chrome's Local Network Access prompt decides that case, not a PNA preflight.
- Client (`host/web/gateway-client.js`): the Host URL field accepts `https://<node>.<tailnet>.ts.net` (a bare `node.tailnet.ts.net` gets `https://`). A ts.net gateway is sent **no** `targetAddressSpace`, not even `local`. The option only exists so Chrome can skip mixed-content blocking for an `http:` target known to be local before DNS. An `https:` target is not mixed content; Chrome resolves the name into `100.64/10` and raises the local-network prompt by itself. Declaring `local` would only add a failure mode for a name that resolves elsewhere. The non-Chrome notice is not shown when the stored Host URL is a ts.net name, and a failed fetch to one gets a tailnet-specific message.

`8787` itself stays `bindHost: "auto"` (loopback + Tailscale IPs) for native clients. Those clients are unchanged.

#### Rejected options

**Tailscale Funnel.** [Funnel](https://tailscale.com/docs/features/tailscale-funnel) publishes a local service to the internet on `443`, `8443`, or `10000`, TLS only, under the tailnet's `ts.net` name. The relay description says the relay cannot decrypt the TCP proxy; termination of the HTTPS reverse proxy is still on the node's tailscaled, and the backend peer is loopback with **no** identity headers. Combined with `isLocalMachineReq`, Funnel aimed at `:8787` would treat the internet as the host machine. A host token copied out of `localStorage` would then be usable from any network, and the token is enough to dispatch an agent that can edit files and run commands. That also contradicts `SECURITY.md` and `docs/STANDALONE-INSTALLS.md` ("do not expose `:8787` to the public internet"). The Serve page and the Funnel page disagree on whether Funnel is on by default in a tailnet; the supported command is `tailscale serve`, and the operator turns Funnel off for the device. The tester checks the serve status output and confirms the port is not public.

**A relay or tunnel the company runs.** Any design where the browser's API calls go to a host we operate, and that host forwards them to the gateway, puts prompts and the bearer token on infrastructure that is not the user's. Even a byte-splice relay sees the token if the inner hop is not a separate TLS session terminated only on the gateway, and it makes the gateway reachable through a public address. That is a stated change to the local-first promise, and this RFC does not make that change.

**Gateway TLS with a certificate the company obtains for `127.0.0.1`.** Public CAs do not issue a useful certificate for a loopback literal the way Tailscale issues one for `*.ts.net` (Tailscale's HTTPS doc is the mechanism we actually have). A private CA would be a new trust install on every machine. Not the first slice.

### 2. What the admin console is

**Decision.** A client-only view on the same origin, at `/admin`, in the same static bundle as the control plane. No company account, no database.

It is the place a person manages the gateways this browser already knows. The source of truth stays `~/.grok-dispatch/config.json` on each machine, read and written through the gateway API the clients already use.

| Surface | What the console does | API already in the gateway | Remote browser |
|---|---|---|---|
| Paired hosts | A list stored in this browser, keyed by `hostId`. Add by pasting base URL + token. | `GET /host/self` (`hostId`, `name`, `version`, `bindPort`) | Yes, with the token |
| Tokens | Store, replace, clear the host token for that `hostId`. The console does not mint or rotate tokens. Rotation copy stays the one in `app.js`: open `/setup` on the host machine. | `POST /auth/validate` | The token is typed by the user. It is not fetched from `/connect.json` on the hosted origin |
| Devices | Show whether push is configured, the device count, and the bundle id. No device token, no `.p8`. The phone keeps registering itself. | `GET /push/status` returns `{ configured, deviceCount, bundleId }` | Yes. `POST /push/register` is not a button in this console |
| Profiles and MCP | List profiles, show usage, show the checked-in catalog. Create, delete, `env`, config dirs, catalog apply, and MCP OAuth stay on the host machine. The Profiles tab already says so when `admin` is false. | `GET /profiles`, `GET /profiles?usage=1`, `GET /mcp/catalog`. `?admin=1` and the mutating routes are `isLocalMachineReq` | Read-only for secrets. On loopback (phase 1, user granted permission, peer really is loopback) the existing admin editor still works, because the TCP peer is this machine |
| Usage and credit meters | Profile utilization from `?usage=1`. Per-session Grok credit badge already rendered by `creditBadge()` in `app.js` (RFC-021). | Those fields | Yes |
| Health | Gateway up, version, and whether the ticketed WebSocket is open. | `GET /health` (no token: `ok`, `service`, `version`, `name`, `time`) plus the WS pill | Yes |

The paired-host record in `localStorage` is `{ hostId, label, baseURL, token }`, one entry per `hostId`. Replacing today's single `clankerspanker.token` / `clankerspanker.hostURL` pair is the whole "accounts" model: this browser, this profile. Two browsers do not sync. That is acceptable. The fund slice has one operator per machine, and the native apps keep their own stores.

**Why there is no backend.** A Supabase project would exist to identify a person and to store something about their gateways. Storing the host token there copies the credential that can run code on the user's machine onto company infrastructure. That breaks the promise in §Problem. Syncing only labels and URLs, with the token staying in `localStorage`, is a convenience and is not required for the site to be the product.

If a later RFC wants that sync, the smallest backend is one Supabase project: [Supabase Auth](https://supabase.com/docs/guides/auth) (email magic link is enough; no social providers), one table of non-secret bookmarks (`user_id`, `host_id`, `label`, `base_url`), and row level security so a user can read only their rows (the Auth guide's RLS section). The token column does not exist. No such project is created by this RFC. Supabase is available to the company; it is not part of the fund slice.

### 3. Hosting and deploy

**Decision.** Static files on Vercel, custom domain `clankerspanker.tech`, TLS by Vercel's automatic Let's Encrypt certificate. The GitHub integration deploys; this repo's existing `ci.yml` stays the test gate.

Vercel documents the pieces we depend on:

- [Vercel for GitHub](https://vercel.com/docs/git/vercel-for-github): pushes to the production branch (this repo uses `main`) update the custom domain. Preview deployments get their own URLs. Reverting a commit returns the previous production deployment to the domain.
- [Custom domain setup](https://vercel.com/docs/domains/set-up-custom-domain): the project shows the DNS records to add. This RFC does not invent an A record or a CNAME target. The owner copies the values Vercel displays.
- [Working with SSL certificates](https://vercel.com/docs/domains/working-with-ssl): Vercel requests a Let's Encrypt certificate after DNS validation succeeds, and renews it. Wildcard certificates need Vercel nameservers; we do not need a wildcard. HTTP is redirected to HTTPS with `308` ([CDN security](https://vercel.com/docs/cdn-security)). HSTS is on for custom domains.
- Security headers on that same CDN page: CSP, `X-Frame-Options`, `X-Content-Type-Options`. Phase 4 sets them in the project. CSP for this app: `script-src 'self'` ( `host/web/index.html` loads `app.js` as an external module, no inline script), `frame-ancestors 'none'`, `base-uri 'self'`, `object-src 'none'`. `connect-src` has to allow `https:` (tailnet names are `node.tailnet.ts.net`, and a CSP `*.ts.net` pattern matches one label only) plus `http://127.0.0.1:*`, `http://localhost:*`, `ws://127.0.0.1:*`, `ws://localhost:*`, and `wss:`. That `connect-src` is broad on purpose; the host token is what authorizes the gateway, not the CSP.

**Layout on the origin.** All of these are `200` responses on `clankerspanker.tech`. None is a redirect to GitHub, to localhost, or to another domain.

| Path | Body |
|---|---|
| `/` | The control plane. Same UI as `host/web/index.html`. This is the product, which is what FAQ 03 requires in place of a brochure. |
| `/app/` | The same UI, so existing `/app/` links keep working once they point at this origin. |
| `/admin` | The console in §2. Phase 3. Until then `/admin` can be the Profiles + Settings views of the same bundle. |
| `/docs/` | Install, threat model (one page: loopback, Tailscale, token, what never gets uploaded), and links to the in-repo docs. Written for this origin. |
| `/download/` | How to run the gateway (`host/` quickstart and `scripts/install-service.sh`) and how to connect this page to it. Mac and Linux client pointers stay as secondary links. The fallback sentence for Firefox and Safari is on this page: open `http://127.0.0.1:8787/app/` on the host machine. |

Deploy root is a new `site/` directory. Its build copies `host/web/` into the output (both `/` and `/app/`) so `app.js` is not forked. `site/docs/` and `site/download/` are authored pages. Vercel's build command runs that copy. Generated copies are not committed.

**CI.** `.github/workflows/ci.yml` already runs house-style and the host build on pull requests. It does not deploy. Production deploy is the Vercel GitHub integration on `main`, after that workflow is green (the owner sets the integration to wait, or merges only when CI is green — branch protection is an owner setting). Preview URLs are a different origin, so they do not see the production `localStorage` token. The docs page tells the operator not to paste a host token into a `*.vercel.app` preview.

A GitHub Actions deploy that stores `VERCEL_TOKEN` is the alternative if the owner rejects the GitHub app. The integration is the one this RFC picks, because it avoids a long-lived deploy token in the repo's secrets. The owner can switch later without an RFC change to the site layout.

**DNS and TLS.** Apex `clankerspanker.tech` is the canonical origin. The owner also adds `www.clankerspanker.tech` on the same project and, in that project's domain settings, redirects it to the apex so `www` is this same site. Certificate and DNS steps use the records and the Let's Encrypt flow in the Vercel documents above; the record values come from the project, not from this RFC.

**Links.** When phase 1 is in production, the README quickstart and the other public docs gain `https://clankerspanker.tech` as the primary website, and keep the localhost URL as the on-machine page. FAQ 03's "primary website" includes where the project's own links point. That doc edit is part of phase 1's exit, not part of this design PR.

### 4. Security review

Exposing a browser origin the user does not control (we publish the JavaScript; the gateway stays theirs) to a gateway that can run tools on their machine.

**What the hosted origin gets.** The static bundle. Vercel sees request metadata for page loads (IP, user agent, URL). It does not see gateway payloads, because those requests go to loopback or to the tailnet name. The host token, once pasted, is in `localStorage` on `https://clankerspanker.tech`. Any script that runs on that origin can read it and can call the gateway while the user's browser still has network access to it (loopback, or the tailnet). That is remote code execution on the gateway, via the victim's browser, for as long as the page is open. With Funnel it would also be exploitable later from the attacker's own network; Funnel is rejected, so a copied token is usable only from a network that can already reach the gateway.

**Controls, in the order they ship.**

1. Phase 1 does not put Serve or Funnel in front of `:8787`. The loopback path's TCP peer really is the host machine, so `isLocalMachineReq` and RFC-026 keep their current meaning. A malicious page still needs the token, and Chrome's permission prompt is the other gate (the [LNA blog](https://developer.chrome.com/blog/local-network-access) is explicitly about public sites driving local devices).
2. The bundle stays first-party. `script-src 'self'`, no inline script, no third-party script host. `host/web/vendor/xterm.min.js` is already vendored; it stays in the copy. Production deploys come from `main` only. A preview deployment cannot read production `localStorage`.
3. Phase 2's serve listener fails closed without `Tailscale-User-Login`, and that header forces `isLocalMachineReq` false. Profile `env`, MCP client secrets, `/setup`, and `/connect.json` are not reachable through the tailnet URL. The bearer token is still required on top of the Tailscale identity (a tailnet peer is not authorized to dispatch).
4. WebSocket tickets stay single-use and short-lived. The long-lived token is not placed in the WebSocket URL for the hosted origin (RFC-029). `?token=` remains local-peer only.
5. `/health` on `:8787` stays unauthenticated and CORS-visible. It returns version and name, not the token, not paths, not profiles. The serve listener does not offer it without the identity header.
6. Certificate Transparency will list the tailnet machine name once HTTPS is enabled. The operator renames the machine first if the current name is sensitive (Tailscale HTTPS doc).
7. DNS rebinding against `/setup` is unchanged: `isTrustedLocalPageRequest` requires a loopback peer, a Host header that names this machine, and no foreign `Origin`. The hosted origin fails that check. Phase 2 does not mount those routes on the serve listener anyway.
8. XSS residual risk is accepted for the fund slice and written down on `/docs/`: a person who can change the production bundle, or inject script into it, can drive the gateway of anyone who has pasted a token and granted local-network access. Mitigation is review before merge to `main`, CSP, and the operator clearing the token (the Settings control already exists) on a machine they no longer trust. Per-device tokens, so one browser can be revoked without rotating the phone, are a follow-up.

**Promise.** Recommended paths do not change it. Agent traffic stays on loopback or on the user's tailnet, TLS for the tailnet path terminated on their node. The rejected relay and Funnel options would change who can reach the gateway; they are not in the plan.

### 5. Phases

Smallest production slice first. Effort is change size (which files, how easy to get wrong), not a calendar. A separate tester, not the implementer, runs the checklist in Testing before a phase is accepted. The tester uses a fresh browser profile so they are not sharing the implementer's `localStorage`.

| Phase | Ships | Change size | Depends on |
|---|---|---|---|
| 0 | Nothing in the repo. Domain registered, DNS able to point at Vercel, Vercel project connected to this GitHub repo, a test tailnet with HTTPS available for phase 2. | Owner actions only | — |
| 1 | `https://clankerspanker.tech/` is the control plane, talking to a gateway on that same machine over loopback, in Chrome. `/download/` and `/docs/` exist on the origin. README primary link updated. | Small. `site/` build copy, `targetAddressSpace` in `host/web/app.js`, two static pages, README links. No host auth change. | Phase 0 |
| 2 | Tailnet HTTPS. `serveBindPort`, identity-header gate, admin forced off when the header is present. | Medium, and the risky one. `host/src/server.ts`, `host/src/trusted-local.ts`, config load, vitest. Easy to get wrong in the direction that grants admin to the tailnet. | Phase 1 in production. A tailnet the tester can join from a second device. |
| 3 | `/admin` multi-host list, health, push status, usage, credit badges, profile lock copy. Still client-only. | Medium UI, no new routes. `host/web/app.js` and the static shell. | Phase 1. Phase 2 only for the "second device" half of the test. |
| 4 | CSP and the other headers from §3. Confirm previews are not on the production domain. | Small, configuration. Easy to break the loopback `connect-src` and ship a silent failure. | Phase 1 |

Phase 1 is the fund slice. Phases 2–4 can follow it; phase 2 should land before the company describes off-machine browser use as supported. The internal target (2026-12-09) applies to phase 1 in production, with the tester's sign-off, so submission on or before 2026-12-15 is not the first day the site exists.

## Testing

The tester is a different person from the implementer. Each phase is accepted only after that tester checks the boxes. Host phases also need `make check` from the implementer; the tester does not take that as a substitute for the manual pass.

### Phase 1

- [ ] Fresh Chrome profile, version recorded (need the WebSocket `targetAddressSpace` behavior from the Chrome 154 notes). Open `https://clankerspanker.tech/`. The document URL stays on that origin (no redirect to localhost, GitHub, or a `vercel.app` host).
- [ ] Gateway running on the same machine with `bindHost: "auto"`. Paste `http://127.0.0.1:8787` and the token from `http://127.0.0.1:8787/setup`. Chrome's loopback permission is granted. Session list loads. Compose a no-op task. The live pill turns live (WebSocket ticket). Deny the permission in a second profile and confirm the page cannot read the gateway.
- [ ] DevTools: API and WebSocket targets are `127.0.0.1`, not `clankerspanker.tech`. No request URL contains the host token (`?ticket=` is fine).
- [ ] `/download/` and `/docs/` return 200 on the production origin. Firefox or Safari, if tried, is recorded. Failure there to reach loopback is expected until that browser documents an equivalent; the fallback sentence on `/download/` is what the tester follows, and it must be a navigation the user chooses, not a redirect.
- [ ] README and the site's own nav point at `https://clankerspanker.tech` as the primary site.
- [ ] `make check` green. No new host route, so `shared/openapi.yaml` is unchanged.

### Phase 2

- [x] Vitest (`host/src/tailscale-serve.test.ts`, `host/web/gateway-client.test.js`): serve listener without `Tailscale-User-Login` is 403 on `/health`, `/profiles?admin=1`, `/setup`, `/connect.json`. With the header, `/profiles?admin=1` returns `admin: false` and no `env`. Direct loopback to `8787` without the header still gets admin and still serves `/setup`. A forged `Tailscale-User-Login` on a direct `:8787` request does not grant admin (header present means not local).
- [ ] Tester, second device on the tailnet: `tailscale serve` aimed at `serveBindPort`. Host URL in the page is `https://<node>.<tailnet>.ts.net`. Sessions load after the Chrome local-network prompt. Profiles admin is locked. `/setup` on that `ts.net` origin is 403.
- [ ] Tester confirms Funnel is not serving that port (serve status shows tailnet-only). A request to the serve port with the header removed is 403.
- [ ] Mac app or Electron against `http://127.0.0.1:8787` still lists sessions and still opens local profile admin. Phone over the Tailscale IP (not the serve URL) still works with its existing token.
- [ ] `make check` green. OpenAPI updated only if a route was added; a new listen port is config, documented in `host/README.md`.

### Phase 3

- [ ] Two gateways, two tokens, both saved. Switching hosts does not bleed sessions. Reload keeps the list. Clear token on one host leaves the other.
- [ ] Health shows version from `/health`. Push row matches `GET /push/status` (count only, no device token). Usage row matches `?usage=1`. A Grok session with a credit delta shows the existing badge.
- [ ] From the tailnet URL (phase 2), profile create is refused. From loopback, profile create still works.
- [ ] No new network calls to any host other than the selected gateway and the static origin.

### Phase 4

- [ ] Response headers on `/` include the CSP from §3, `X-Content-Type-Options: nosniff`, and a frame ancestor restriction. The session list still loads in Chrome (CSP did not block loopback or `wss:`).
- [ ] A preview deployment URL is not the production domain. Pasting a token there is documented as unsupported; the tester does not need to complete a session on the preview.
- [ ] `http://clankerspanker.tech` ends on `https://clankerspanker.tech` (Vercel `308`). `www` ends on the apex.

## Rollout

1. Owner completes phase 0 (blockers below). No merge required for that.
2. Implement phase 1 on its own branch. Tester signs the phase 1 list. Merge. Production deploy via the Vercel integration. Leave it up through the submission window.
3. Phase 2, then 3, then 4, each with its own tester pass. Phase 2 merges only after the vitest in Testing is in the same change.
4. `make check` on every implementation branch.
5. This RFC stays Draft until phase 1 is in production, then the status line moves to Accepted with the phase 1 tester's result noted. Shipped waits until phase 4.

## Follow-ups

- Per-device tokens, so the hosted origin can be revoked without rotating the phone and the native apps.
- Replace `Access-Control-Allow-Origin: *` with an allow-list once the Electron origin is explicit. Doing it in phase 1 would break the file-origin renderer.
- Supabase bookmark sync of `{ hostId, label, baseURL }` only, as sketched in §2, if the owner wants the same host list on two browsers.
- Revisit Firefox and Safari for the loopback path when their docs describe a local-network permission and a mixed-content exemption. Until then they use the ts.net path (phase 2) or the gateway's own page.
- A tailnet-status check that refuses to start the serve listener if Funnel is configured for that port, once the tester has confirmed which local Tailscale API reports it. Not guessed in this RFC.
