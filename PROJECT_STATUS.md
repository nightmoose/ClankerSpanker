# Project Status — ClankerSpanker

**As of:** 2026-08-24  
**GitHub:** https://github.com/nightmoose/ClankerSpanker (private)  
**Local directory (name is stale):** `~/Projects/GrokDispatch`  
**Branch:** `main`

Day-to-day play-by-play: [`docs/NEXT-STEPS.md`](docs/NEXT-STEPS.md).  
How we work: [`docs/HOUSE-STYLE.md`](docs/HOUSE-STYLE.md) (ContractGate loop, RFC-000, `make check`).  
Estate map: `~/mercenary/STATUS-2026-08-23.md`.

## What this is

Local-first control plane for **Grok Build** and **Claude Code** (plus Gemini /
Antigravity profiles). One host gateway (`:8787`); Mac native, Linux Electron,
browser `/app/`, and iOS/iPad clients drive it over LAN or Tailscale.

## Naming trap (read before grepping)

| Thing | Actual name |
|---|---|
| GitHub repo | `ClankerSpanker` |
| Folder on disk | `GrokDispatch` |
| Swift sources | `ios/GrokDispatch/GrokDispatch/` |
| Xcode project | `ClankerSpanker.xcodeproj` |
| Bundle id | `com.nightmoose.clankerspanker` |
| Auth header | `x-grok-dispatch-token` — **do not rename casually** |

## Current state (this commit)

Large Aug 21–23 arc that previously lived only on disk, now in git:

- Host: bots/hunter loop + provider auth (Grok/Gemini/Anthropic), Antigravity
  (`agy`) runner, usage metering, local-machine detection, login helper,
  approval resume-after-restart, Grok ACP extensions, more tests
- Mac command center: file viewer, profiles manager, session notes, projects /
  tasks tabs, splash, search
- iOS/iPad: bots UI, onboarding/composer/dashboard/transcript overhaul
- Docs: `docs/ANTIGRAVITY.md`

Host tests were **103 passing** as of 2026-08-21; re-run after this commit
(`cd host && npm test`). Typecheck + `npm run build` should stay clean.

## Open / next

1. **Operator:** kickstart once so `host/dist` includes the terminal helper, then
   use the in-app **Term** tab (`ws/terminal`) for later host-shell jobs.
2. Browser `/app/` still has no first-turn screenshot picker, chat-only, or Files.
3. Linux AppImage/deb must be built **on Linux**.
4. Phone Run scheme is not the daily driver.
5. ~~`ConnectionDefaults` hardcoded `http://192.168.50.9:8787`~~ — removed (RFC-043).
6. Swift clients have **no automated tests**.
7. `event-horizon/` is gitignored on purpose (separate mini-game).

## Notes for humans and AIs

- Repo root is **here**, not `ios/`. Opening only the Xcode folder hides `host/`
  and `.git`.
- `host/src/auth.ts` is the security boundary. Empty token ⇒ nobody.
- Do not commit host tokens, `.env`, or the 2026-08-23 desktop screenshot.
