# RFC-067 — The hosted site explains itself and has a read-only demo

**Status:** Draft
**Date:** 2026-10-20
**Branch:** rfc-067-hosted-demo-explainer
**Severity:** P1 — .tech No Excuses Fund judges visit https://clankerspanker.tech without a gateway (submissions close 2026-12-15, internal target 2026-12-09)

---

## Problem

RFC-058 put the control plane at `/` on `clankerspanker.tech`. A visitor with no gateway saw an `OFFLINE` pill and the Connection form (Host URL + token) from `renderSettings()` in `host/web/app.js`, with no word on what the product is. `host/web/index.html` had a bare `<title>`, no meta description, no Open Graph or Twitter tags, and no icons (`/favicon.ico` was a 404).

The fund's judges assess "the problem you're solving, what you've built". The fund also says a "standalone landing page doesn't qualify" and requires a working build on `.tech` (RFC-058 FAQ 03 and 04). So the explainer cannot be a brochure in front of the app, and a judge has to be able to see the product working without installing a gateway.

## Non-goals

- A hosted gateway, a shared demo token, or any server the demo talks to (RFC-058 non-goals stand).
- A light theme. The control plane and `site/site.css` are dark-only (`color-scheme: dark`); this RFC keeps that.
- A web profile picker. The Active tab filters to the first profile's chats with no way to change it (`refresh()` sets `state.profileId`). The demo skips that filter; fixing it for real is a follow-up.
- Changes to `host/src/auth.ts`, CORS, tokens, or `vercel.json`.

## Fix

### Explainer inside the app shell

`host/web/landing.js` decides what shows first: `landingView({ token, demo })` is `demo` when chosen, `explainer` when no host token is saved, else `app`. In the `explainer` case `renderSettings()` puts one card above the Connection card: what the product does (dispatch, watch, approve Grok Build and Claude Code agents on your own machine from phone, laptop, or browser), the local-first promise, the two ways to connect (loopback in Chrome; `tailscale serve` from any browser), and two buttons, **Try the demo** and **Connect your gateway** (scrolls to and focuses the form). `/` stays the app: the tab bar and header are there, and the tabs' empty states offer the same two buttons. Once a token is saved the explainer is gone.

### Read-only demo

`host/web/demo.js` holds canned data in the gateway's shapes (`types.ts`): four active chats across Grok and Claude (one awaiting approval with a diff, one awaiting answers to two questions, one running with a credit badge, one idle), one archived, Grok and Claude sessions on disk, three projects, four profiles. `demoApi(path, opts)` answers the read routes the UI uses (`GET /sessions`, `/sessions/:id`, `/projects`, `/profiles`, `/mcp/catalog`, `/bots`) with copies, and rejects every other request, including every non-GET and `/ws/ticket`, `/auth/validate`, `/host/update`, with `DemoReadOnlyError`, whose message says what the gateway would have done.

`app.js`:

- `state.demo` comes from `?demo=1` only (`demoRequested`). It is never a default, on the hosted site or on a gateway.
- `api()` returns `demoApi()` first when `state.demo`, so no request leaves the page. `connectWs()` returns. With `?demo=1`, `state.token` starts empty and boot skips `?token=`, `localStorage`, and `/connect.json`.
- The pill reads `DEMO`; a strip under the header says it is canned data, with **Connect your gateway** and **Exit demo** (both reload without `?demo`). The terminal link, the Update button, and the non-Chrome notice are hidden. A demo notice in the banner is not styled as an error.
- Saving the Connection form while in the demo leaves the demo first.
- Back/forward across `?demo=1` reloads, so a page never mixes demo and gateway state.

### Metadata and icons

`index.html` gets a descriptive `<title>`, `meta description`, `color-scheme`, `theme-color`, Open Graph and `summary_large_image` Twitter tags with `https://clankerspanker.tech/og.png`, `favicon.ico` (16/32/48 from the iOS `AppIcon-1024.png`), `icons/icon-192.png`, and `icons/apple-touch-icon.png`. `og.png` is a 1200×630 headless-Chrome capture of the demo. Icon links are relative, so `/`, `/app/`, and the gateway's `/app/` all resolve them.

### CSP

Everything added is same-origin script modules and CSS. No inline `<script>`, no inline handlers, no new hosts: the `vercel.json` CSP (`script-src 'self'`) is unchanged and was served by a local static server during testing with no violations.

## Testing

- [x] `host/web/demo.test.js`: list and detail shapes, an approval with a diff, tool rows with output, profiles without secrets, copies not shared state, every write refused with a notice, token/ticket/host routes refused, unknown session errors, no `fetch` or `WebSocket` call.
- [x] `host/web/landing.test.js`: no token → explainer, token → app, demo only when chosen, `?demo` parsing, `demoHref`.
- [x] `host/web/hosted-headers.test.js`: title, description, OG/Twitter tags, icon files exist.
- [x] Manual at 375×812 in OS light and dark: explainer, demo list, detail with approval, Approve notice, Profiles, Compose, Connect scroll.
- [ ] Vercel preview screenshots in the PR.

## Rollout

1. Merge; Vercel deploys `main` to `clankerspanker.tech`.
2. `make check`
3. Row in `docs/rfcs/README.md`

## Follow-ups

- Web profile picker for the Active tab (see Non-goals).
- A light theme for the control plane and `/docs/`, `/download/`.
