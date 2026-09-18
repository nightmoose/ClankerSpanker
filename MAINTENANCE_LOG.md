# ClankerSpanker — Maintenance Log

---

## Run: 2026-09-18 — RFC-022 reset-time tooltip on profile usage chip

`ProfileUsage` already carries `fiveHourResetsAt` and `sevenDayResetsAt`
for every quota backend, but the profile chip in Electron / Mac / iOS
only displayed used %. So "wk 40%" told you *where* you were, not
*when* the plan rolls over — no way to gauge how hard to push.

`host/src/reset-time.ts` is the shared pure formatter for the JS
clients (`formatRelativeReset`, `formatResetLine`) with bucketed
output: `<1m` / `Nm` / `Nh Nm` / `Nh` / `Nd Nh` / `Nd` / absolute
short date past 7 d or in the past. Grok collapses both windows to
one line since its billing period ends are identical; Claude gets
two windows joined by `·`.

`ResetTimeFormatter` in `ProfileSegmentBar.swift` mirrors that logic
for Mac + iOS and is wired via `.help(...)` on each pill (macOS shows
a hover tooltip; iOS silently drops it and keeps the existing
accessibility label). Electron adds a `title` attribute on the
`.profile-chip` button through `usageTooltip`.

Client-only change — no host code, no LaunchAgent bounce required.

**Soak:** hover the FullScore chip on the Mac Command Center and see
`5h resets in Xh Ym · weekly resets in Zd`; hover NightMoose and see
the single weekly line.

Tests baseline 247 → 262 (15 new cases in `reset-time.test.ts`).

---


## Run: 2026-09-17 — RFC-021 per-session Grok credit meter

Long-lived Grok sessions burn credits quadratically because each turn
re-sends the full transcript + tool outputs. 2026-09-17 spot-check on
NightMoose showed 40% of the weekly plan gone in <24h across two
sessions running 26–30h each. The profile-wide chip (RFC-013) never
tells the operator *which* chat is expensive.

`fetchGrokWeeklyCreditPct(profile, dataDir)` is a thin wrapper around
`/v1/billing?format=credits` that returns `number | null` (never
throws). `session-manager.ts` snapshots the profile's weekly
`creditUsagePercent` after `session/new` and after each `end_turn`
(30 s cool-down guards billing on tool-heavy bursts). `session-meter.ts`
owns the pure helpers: `applyOpenCreditSnapshot`,
`applyEndTurnCreditSnapshot`, `computeCreditDelta`,
`classifyCreditDelta`, `shouldSnapshotEndTurnCredits`.

`SessionStore.toSummary` publishes `creditsUsedDeltaPct` +
`creditsUsedAt` on every session row. `/app/`, Electron, Mac and iOS
each render a small `wk +N%` badge next to the status pill: green <5%,
amber ≥5%, red ≥10%, with a tooltip that nudges reincarnation on the
amber/red tiers. Grok-only — Claude/Antigravity/Bot rows carry `nil`.

**Soak:** open a NightMoose Grok chat, watch the badge appear at
`wk +0.0%`; run tool-heavy turns and confirm the delta climbs on the
same tile without paging any other session's usage.

Deviations from the RFC: `HostConfigFile.sessionMeter` was dropped as
dead code (no consumer today; clients use RFC defaults). `openapi.yaml`
has no schemas section — the `/sessions` summary got a note instead.

Tests baseline 228 → 247 (19 new cases in `session-meter.test.ts`).

---


## Run: 2026-09-16 — RFC-020 apply MCP catalog per profile

Mechanism (RFC-008/009) and paste map (RFC-013) were shipped; every live
profile still had `mcpServers: null`, and NightMoose Grok ACP inherited
Claude's unsigned **Vercel plugin MCP** (`~/.claude/plugins`, not
`grok mcp list`). That AuthRequired still killed workers.

Canonical catalog is now `host/src/mcp-catalog.ts`. `/app/` Profiles
gets chips + **Apply catalog defaults**. `GET /mcp/catalog` and
`POST /profiles/:id/mcp/apply-catalog` (this machine). Grok spawn with
a blank `grokHome` uses `{dataDir}/grok-homes/{profileId}` with
`[compat.claude] mcps = false` and `[plugins] disabled = ["vercel", …]`,
auth.json symlinked to `~/.grok/auth.json`.

**Soak:** Mac Host panel **Install / update host** (Application Support +
`com.nightmoose.clankerspanker-host`). Do not kick the repo
`grok-dispatch-host` agent. `/app/` → Profiles → Apply catalog on
NightMoose / Personal / FullScore → Sign in HTTP rows. A NightMoose
turn must see Vercel only after Sign in; a FullScore turn must not.
HostInstaller now copies `host/web/` with `dist/` so `/app/` catalog
chips ship in the installed package.

---


## Run: 2026-09-11 — RFC-019 stuck "Running" + phantom pending questions

Confirmed sessions were stranded on `status: "running"` after Grok
had clearly ended the turn (`stopReason: "end_turn"`, transcript
final, `isLive: false`, persisted `pendingApproval` /
`pendingQuestion` both `null`). Root cause in
`host/src/acp/session-manager.ts`: the end-of-turn block gated
the flip to `idle` on the in-memory `live.pendingApprovals` /
`live.pendingQuestions` maps, and `maybeParkAskUserQuestionFromTool`
cleared the persisted `pendingQuestion` on tool completion without
draining the map. Phantom entry → the flip skipped forever.

Fix: extracted two pure helpers — `shouldFlipToIdleAfterTurn(session)`
reads the persisted `pendingApproval` / `pendingQuestion` only, and
`drainPendingQuestionsByToolCall(map, toolCallId)` clears matching
map entries when the underlying `AskUserQuestion` tool finishes.
`handlePrompt` calls the first, `maybeParkAskUserQuestionFromTool`
calls the second. 9 new vitest cases in
`session-manager.stuck-running.test.ts`; baseline 198 → 207.

Stuck session `a53072c3-ccae-4622-93e5-22d3107bd272` was hand-patched
to `status: "idle"` on disk after the host bounce so it renders
correctly without a follow-up turn.

**Soak:** kickstart `com.nightmoose.grok-dispatch-host`, send a
follow-up in any long-running Grok chat, verify the pill flips from
Running → Your turn once `session/prompt` returns.

---

## Run: 2026-09-11 — RFC-018 markdown link resolver with cwd context

Grok emits `[foo.pdf](foo.pdf)` — bare relative paths. Tapping the
Markdown link in the expanded-message view (via
`AttributedString(markdown:)`) forwarded that URL to
`NSWorkspace.shared.open`, which macOS rejected with
`-50 paramErr` and popped "The application can't be opened."

New helper `MarkdownLinkResolver` decides: system-scheme URLs pass to
the OS, iOS discards relative paths (no filesystem reach), and macOS
resolves them against the session's `cwd`. Threaded `cwd` +
`onOpenLocalFile` through `TranscriptView → ExpandedMessage →
ExpandedMessageView → MarkdownView`, then wrapped the Markdown
renderer's `.environment(\.openURL, OpenURLAction { … })` around the
resolver. `SessionDetailView` passes `detail.cwd` and routes the
callback through the existing `openFileInViewer(_:cwd:)` →
`AppState.openInViewer(_:)` chain.

**Soak:** in a Grok session with relative doc links, tap one in the
Expand view — Preview / Safari opens the correct file under
`detail.cwd`. Absolute `https://` links still open the browser. On
the phone (RFC-002-era session with `cwd`), the tap is a no-op — no
system alert. RFC-017 (dup response) is Draft, follow-up.

---

## Run: 2026-09-09 — RFC-016 standalone Mac host tray

New Xcode target `ClankerSpankerHostTray` (scheme + `.app`), a
`LSUIElement=true` menu-bar-only Swift app in
`ios/GrokDispatch/HostTray/`. Shows gateway status, opens `/app/` and
`/setup` in the default browser, kickstarts whichever LaunchAgent is
loaded (`clankerspanker-host` first, else `grok-dispatch-host`), and
reveals the host log + `~/.grok-dispatch/`. No session UI — this is
a **configurator**, not a client (see `docs/CLIENTS.md`).

To avoid two identical bolts in the menu bar, the ClankerSpanker Mac
command-center app drops its own `MenuBarExtra` and `MacMenuBarMenu`.
`applicationShouldTerminateAfterLastWindowClosed` flips to `true`
now that there's no menu-bar refuge — the tray is the always-on
surface, the command center quits when its window closes.

**Soak:** `xcodegen` in `ios/GrokDispatch`, then `xcodebuild -scheme
ClankerSpankerHostTray build`. Drop the built `.app` in `~/Applications`
and launch — a single bolt should appear. Launching `ClankerSpanker.app`
alongside should not add a second bolt.

---

## Run: 2026-09-09 — RFC-015 detach Mac app from host process

`LocalHostController.start()` on macOS used to spawn `node dist/index.js`
as a child of the Mac app via `Process()`. Quitting the app killed the
gateway. `start()` now `launchctl kickstart -k`s whichever LaunchAgent
is loaded — `com.nightmoose.clankerspanker-host` (app-managed) first,
then `com.nightmoose.grok-dispatch-host` (repo standalone). The Install
flow in `MacHostPanel` is preserved and now uses a takeover-confirm
alert when the repo agent is loaded, so it won't silently evict the
`~/Projects/GrokDispatch/host` daemon. Dead `process`/`pid`/`isRunning`
bookkeeping and the "Stop app-owned host" menu entries are gone.

**Soak:** Cmd-Q the Mac app while `lsof -nP -iTCP:8787 -sTCP:LISTEN`
watches — node stays alive. Menu → Host → "Kickstart local host"
brings it back if launchd's `KeepAlive` hasn't yet. Host panel install
button on a machine with the repo agent loaded shows the confirm
alert; only "Replace" swaps in the Application Support copy.

---

## Run: 2026-09-09 — RFC-010 iOS app icon badge

Home-screen / Dock badge is `attentionSessions.count` (awaiting approval
or a question). `NotificationService.setAppIconBadge` writes it after
session refresh; approval/question local notifications set
`content.badge` so SpringBoard updates before the list round-trip.
Approve/Reject from a banner always refreshes so the number drops.

**Soak:** iPhone — trip an approval, confirm the icon shows `1`, approve
in-app or from the banner, confirm the mark clears.

---

## Run: 2026-09-09 — RFC-011 APNs

Host sends Apple Push on `approval.needed` / `question.needed` (alert +
badge) and on resolve (badge only). iPhone registers its device token at
`POST /push/register`. Key lives in `~/.grok-dispatch/apns/` (not git).
`environment: auto` tries sandbox then production.

**Soak:** kill ClankerSpanker on Deez Nutz, trip an approval, confirm
banner + badge without opening the app. `POST /push/test` is the
shortcut. Bounce `com.nightmoose.clankerspanker-host` (Application
Support), not the repo `grok-dispatch-host` agent.

---

## Run: 2026-09-09 — RFC-012 login modal false positive

Vercel MCP `AuthRequired` / `oauth-protected-resource` was matching a
bare `oauth` substring, so Mac/iPhone popped “NightMoose needs to sign
in” on every follow-up. Profile CLI login detection no longer matches
MCP OAuth. The Sign in alert is banner-only (tap to open). Worker exit
maps to “MCP connector needs Sign in (mcp.vercel.com)”.

**Soak:** send a message in the looping NightMoose chat — no modal.
Sign in Vercel from Host → Profiles, not `grok login`.

---

## Run: 2026-09-09 — RFC-013 profile MCP catalog

Checked-in paste map for who gets which connector:
[docs/MCP-CATALOG.md](docs/MCP-CATALOG.md). NightMoose / Personal /
FullScore / Gemini assignment is the RFC. Do not put Gmail on
NightMoose. Do not paste NightMoose MCP until that profile has
`grokHome` (RFC-006). Vitest parses the fenced JSON.

**Soak:** `/app/` Profiles → paste Personal or FullScore → Sign in.
NightMoose waits on `grokHome`.

---

## Run: 2026-09-09 — RFC-014 close as done + hide Grok helpers

Idle Close as done / Archive wrote disk but left `hydrated` stale, so
`GET /sessions` kept the chat on Active. Those mutations now
`persist()` the in-memory object. Grok subagent worktree sessions
(`session_kind` subagent / `subagent_resume`, cwd `…/subagent-*`) are
no longer imported or listed — talk to the parent session.

**Soak:** Close as done on an idle Grok chat — it leaves Active. Helper
rows gone from Active / Archived / disk attach. Kick the host after
deploy.

---

## Run: 2026-08-30 — RFC-009 remote MCP OAuth

HTTP MCP servers on a profile can Sign in with OAuth 2.1 + PKCE
(`host/src/mcp-oauth.ts`). Tokens live in
`{dataDir}/mcp-oauth/{profileId}/{serverName}.json` (0600), not
`config.json`. `toMcpJson` / ACP `mcpServers` inject `Authorization:
Bearer` when fresh. Three local-only routes: start, loopback callback,
logout. Host Profiles editor has per-server Sign in/out.

**Soak:** NightMoose HTTP MCP → Sign in on `/app/` (this Mac) → dispatch
→ tools appear; FullScore must not see that token.

---

## Run: 2026-08-29 — RFC-008 per-profile MCP servers

`AgentProfile.mcpServers` is the payer-owned connector list. Dispatch
writes `{dataDir}/mcp/{profileId}.mcp.json` and passes `--mcp-config` to
Claude; Grok ACP `session/new` / `session/load` get the ACP-shaped
array. Host Profiles editor (this machine) has a JSON textarea.
`${VAR}` expands from profile env. Public GET lists names only.

**Soak:** add a stdio server on NightMoose, dispatch, confirm the tools
show; FullScore turn must not see them.

---

## Run: 2026-08-29 — RFC-007 iPhone Term paste + session copy

Term accessory bar has **Paste** (clipboard → xterm `term.paste` → PTY).
Expanded message popup: **Copy** toolbar, **Read / Select** (Select is a
real `UITextView` so you can highlight a command), code-block Copy chip,
bubble long-press Copy. Path: session → copy → Term → Paste.

**Soak:** Expand an agent reply → Select → copy a `launchctl` line → Term
Paste → it runs.

---

## Run: 2026-08-29 — Claude approvals never reached the phone

Claude turns are not in the ACP `live` map, so `get()` loaded a fresh
disk copy per call. `createClaudeApproval` parked `pendingApproval` on
copy A; `claudeTurn`'s `runner.on("tool")` then persisted copy B and
wiped it. The hook waited 10 minutes, denied, and the user never saw
Approve. `get()` now returns one hydrated object per session.

**Soak:** FullScore session → Edit a new file → Approve bar on phone/Mac
before the tool runs.

---

## Run: 2026-08-29 — RFC-006 Phase C: toolAllowlist + Bot env

`toolAllowlist` is now a pre-flight tool-name list (Claude `--tools`,
Grok/Claude hook deny, Bot `toolsForAllowlist`). Signature-shaped
entries (`claude:bash:…`) migrate to `autoApprovalSignatures` on
load so existing auto-approve configs keep skipping the phone.
`agy` has no restrict flag — fresh turns get an advisory note.
Bot `pickProvider` uses `profileProcessEnv` so `profile.env` and
`grokHome` → `GROK_HOME` reach the HTTP clients.

**Soak:** profile with `toolAllowlist=["Read","Grep"]` cannot Write
on Claude/Grok; a leftover `toolAllowlist: ["claude:bash"]` still
auto-approves bash after reload.

---

## Run: 2026-08-29 — RFC-006 Phase B: prompt + model sentinel parity

`systemPrompt` now reaches Grok (first-turn preamble) and Antigravity
(prepended to a fresh `agy -p`; skipped on `--conversation` resume).
Claude still uses `--append-system-prompt`. `isModelSentinel(backend,
model)` replaces the Claude-only helper plus the hardcoded agy/Grok
`--model` exclusions so sentinel slugs (`claude`, `grok-build`,
`gemini`, `default`, empty) let each CLI pick its account default.

**Soak:** dispatch a Grok profile with a persona set; confirm the
opening ACP prompt carries `[Profile instructions]` and a follow-up
does not. Same for a fresh vs resumed agy conversation.

---

## Run: 2026-08-28 — RFC-006 Phase A: Grok home dir isolation

`AgentProfile.grokHome` is now honored by `profileProcessEnv` (sets
`GROK_HOME`) and by `profileHasCredentials` for grok/bot backends. Two
Grok profiles can point at distinct `~/.grok`-style dirs and sign in
independently instead of trampling one `auth.json`. POST/PATCH
`/profiles` accept the field on this-machine requests.

**Soak:** create a second grok profile with `grokHome=/tmp/nightmoose-2`,
`grok mcp login` inside it, confirm the shared `~/.grok/auth.json` is
untouched.

---

## Run: 2026-08-24 — RFC-005 attach Gemini CLI conversations

`GET /sessions` now returns `agySessions` from
`~/.gemini/antigravity-cli`. `POST /sessions/attach-agy` wraps them as
Antigravity Dispatch sessions (`agy --conversation`). Mac/iPhone disk lists
and Linux Gemini disk nav. Not the consumer Gemini app.

**Soak:** Gemini chip → on-disk row → attach → follow-up.

---

## Run: 2026-08-24 — Host status pill flashing (RFC-004 follow-up)

Two `WebSocketServer({ server, path })` instances both subscribed to HTTP
`upgrade`. `ws` abortHandshake()s path mismatches, so `/ws/terminal` killed
every `/ws` client. Status flipped Live ↔ Offline. Route upgrades by pathname
with `noServer: true`.

---

## Run: 2026-08-24 — RFC-004 host terminal

Authenticated PTY over `ws://host:8787/ws/terminal?token=` (same host token,
`tokensMatch`). Login shell via Python `pty.fork` (no node-pty). Phone **Term**
tab, Mac toolbar ⌘⇧K sheet, Linux nav Terminal, `/app/terminal.html`.

**Soak:** phone Term → `hostname` / `launchctl`; Mac sheet; idle close.

---

## Run: 2026-08-24 — RFC-003 phone bots (create + run)

iPhone chrome had no Bots tab (`AppTab` was Sessions/Projects/Tasks/Dispatch/Settings). Mac already had hunters (⌘2). Host `POST /bots` and `POST /bots/:id/run` were live; the phone never called them.

Added **Bots** to the top strip. List + New bot sheet + Run now / last session / job / outbox. Same host APIs as Mac.

**Soak:** iPhone Bots → New bot → Create; Run now opens the hunter session.

---

## Run: 2026-08-24 — RFC-002 session chat-only, Files, extra folders

Transcript now has a **Chat only** toggle (Mac/iOS + Linux) that hides
tool rows, thoughts, and system lines. Notes gained a **Files** section
(cwd, extra dirs, tool locations, attachments) with view: Mac pane,
Linux viewer (local disk, host API fallback), iPhone sheet via
`GET /sessions/:id/file`. Dispatch accepts `extraDirs`; Mac/Linux use a
real multi-folder picker (first = cwd, rest extra). iPhone picks extra
folders from registered host projects. Mid-session `PATCH …/extra-dirs`
merges more folders; Claude gets `--add-dir` on the next turn.

**Soak:** Chat only on a noisy Claude session; Notes Files open a tool
path; pick two folders on New Session; add a third from Notes.

---

## Run: 2026-08-23 — RFC-001 markdown tables + todo jump to source

Expanded-message `MarkdownParser` had no table block — GFM `| col |` rows
rendered as pipe soup. Added table parse + `Grid` render.

Tasks tab built `SessionRoute` with session id only, so the user landed at
the bottom of the transcript. Route now carries `sourceMessageId`; detail
scrolls (retries; pin-to-bottom skipped while jumping) and opens the
expand sheet on that message. Save-as-todo footer no longer tells you to
throw the body away. Linux Tasks list used `t.sessionId` (wrong) and
ellipsis-truncated the card; both fixed, plus `openSession(id, messageId)`.

**Soak:** expand a table-heavy assistant message; tap a todo that was saved
from a message.

---

## Run: 2026-08-23 — RFC-000 CI: parse vitest summary without ANSI

Second CI fail: tests were green but the ratchet regex missed `Tests 106 passed`
because Actions emits ANSI. Strip CSI sequences and set `NO_COLOR=1`.

---

## Run: 2026-08-23 — RFC-000 CI: hermetic Grok CLI credential test

GitHub Actions failed `profileHasCredentials bot > accepts Grok CLI login`
because it asserted `true` against **this Mac’s** `~/.grok/auth.json`. CI has
no login file. Fixture now uses `GROK_HOME` + a temp `auth.json` (same injection
`profiles.ts` already honors). 106 tests pass with empty home.

---

## Run: 2026-08-23 — RFC-000 house style + CI gate

Adopted ContractGate’s loop in this repo so the next session cannot recreate
the unreviewed 10k-line pile.

**Shipped:** `docs/HOUSE-STYLE.md`; RFC template + `000-house-style`;
`docs/STATUS.md`; `scripts/house-style-check.py` (RFC index, TEST-EXCEPTIONS,
heavy-diff requires RFC+log, LAN-IP allowlist, vitest count ratchet);
`scripts/new-rfc.sh`; `Makefile` `check`; `.github/workflows/ci.yml`;
`CONTRIBUTING.md`; `host/test-baseline.txt` seeded at **106**.

**Verify:** `python3 scripts/house-style-check.py`; `cd host && npm test`
(106 passed); `npm run typecheck`; `npm run build`.

**Not in this RFC:** Swift tests, OpenAPI drift check, `192.168.50.9` default,
GrokDispatch path rename.
