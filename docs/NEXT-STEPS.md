# Next steps

**Last updated:** 2026-09-09 (NightMoose)

Client ownership is locked in [CLIENTS.md](CLIENTS.md). One host gateway only.

This file is the in-repo status of play for ClankerSpanker. Snapshot:
[PROJECT_STATUS.md](../PROJECT_STATUS.md). Estate-wide notes:
`~/mercenary/STATUS-2026-08-23.md`.

---

## Done — 2026-09-09 (RFC-014 close as done + hide Grok helpers)

**Close as done** / Archive on an idle chat actually leaves Active
(hydrated overlay was stale). Grok subagent / helper worktree sessions
no longer flood Active, Archived, or disk-attach lists. Kick the host
after deploy.

---

## Done — 2026-08-30 (RFC-009 remote MCP OAuth)

HTTP MCP servers on a profile can **Sign in** from `/app/` Profiles (this
machine). PKCE + loopback callback; tokens in
`~/.grok-dispatch/mcp-oauth/`. Kick the host after deploy. See
[MCP.md](MCP.md).

---

## Done — 2026-08-29 (RFC-008 per-profile MCP)

Host Profiles (this machine) JSON `mcpServers` on each chip. Claude `--mcp-config`; Grok ACP `session/new`. Kick the host after deploy.

---

## Done — 2026-08-29 (RFC-007 phone copy/paste)

iPhone Term has a **Paste** key. Expanded session messages: **Copy**, **Read / Select** (select a span), code-block Copy, bubble long-press Copy. Rebuild the phone app.

---

## Done — 2026-08-24 (RFC-005 attach Gemini CLI)

agy TUI/CLI chats on the host can be attached like Claude/Grok disk sessions.
Gemini chip → **Gemini CLI on disk**. Resume uses `--conversation`. Consumer
Gemini app chats still cannot be imported.

---

## Done — 2026-08-24 (RFC-004 host terminal)

You no longer need to “get back to the Mac” for `launchctl`, `git`, `agy`, etc.
Open **Term** on the phone (or Mac ⌘⇧K / Linux Terminal). Same host token as
the app; login shell on the host. Kickstart the host once so `pty-bridge.py` is
on disk, then use Term for later kicks.

---

## Done — 2026-08-24 (RFC-003 phone bots)

iPhone can **create** hunters and **Run now**. New **Bots** tab (between Tasks and Dispatch). Mac ⌘2 Bots tab unchanged. Host APIs were already there.

---

## Done — 2026-08-24 (RFC-002 chat / files / extra folders)

| Ask | Where | Status |
|---|---|---|
| Chat-only Transcript (toggle, not a new tab) | Mac/iOS `TranscriptView`, Linux `mergedItems` | **Done.** Hides tools, thoughts, system. |
| Files under Notes + view | `GET /sessions/:id/files` + `/file`, Notes tab | **Done.** Mac FileViewerPane; Linux viewer; iPhone sheet. |
| Multi-folder picker at dispatch + add later | `extraDirs` on dispatch + `PATCH /sessions/:id/extra-dirs` | **Done.** Mac NSOpenPanel / Linux dialog; iPhone picks host project paths. Claude `--add-dir` on each turn. |

**Operator:** kickstart the LaunchAgent so `host/dist` loads, then rebuild the Mac app.

---

## Done — 2026-08-21 (approvals + original Mac/Linux UX)

Host tests: **103 passing**. Typecheck + `npm run build` clean. Xcode project regenerated from `project.yml`.

### Approvals (was stalling all other work)

| Item | Where | Status |
|------|--------|--------|
| Approve after host restart dismissed the agent | `host/src/acp/session-manager.ts` `resolveApproval` | **Fixed.** Approve on an orphaned pending tool now auto-resumes with a continuation prompt. Reject still dismisses. |
| Claude screenshot `Read` blocked (files outside cwd) | `claudeTurn` + `ClaudeRunner` | **Fixed.** Images are copied into `{cwd}/.clankerspanker-attachments/` (gitignored) and Claude is launched with `--add-dir` + a Read grant on host attachment dirs. |
| `git status` still pinged the phone | `isSafeBashCommand` | **Fixed.** `"git"` was missing from the safe-command set; read-only git subcommands now auto-approve. |

**Operator:** the running LaunchAgent still has to pick up `host/dist`:

```bash
launchctl kickstart -k "gui/$(id -u)/com.nightmoose.grok-dispatch-host"
```

Sessions that already received the old “agent has been dismissed” banner already had the pending tool cleared — those need one follow-up. After the kickstart, a later host bounce + Approve will resume instead of stalling.

### Original three UX asks (Mac, then Linux)

| # | Ask | Mac native | Linux Electron | Browser `/app/` |
|---|-----|------------|----------------|-----------------|
| 1 | Tool-call ellipsis → real input (command / path / payload) | **Done** — `⋯` on transcript + Tools tab, sheet via `GET /sessions/:id/tool-calls/:toolCallId` | **Done** — same `⋯` + modal | Not in the browser session UI (no tool rows) |
| 2 | Image upload on New Session | **Done** — Mac compose pane + phone `TaskComposerView` | **Done** — compose “Attach images…” | Still follow-up only |
| 3 | Hard-delete closing the main window | **Done** — macOS clears `macSelectedSessionId` instead of `dismiss()` | Already correct (clears `detail` / `selectedId`) | n/a |

Host plumbing for 1–2: `DispatchRequest.images`, capped `rawInput`/`content` kept on disk (`slimSession`, 4 KB cap), list/detail responses still strip the blobs so the phone payload stays small.

---

### Profiles manager (2026-08-21 follow-up)

The Mac **Host** toolbar panel had install/projects/logs and **no profiles UI**. The website Profiles tab existed but `?admin=1` only unlocked on `127.0.0.1`, so opening `/app/` via LAN or Tailscale on the *same Mac* was read-only.

| Surface | Now |
|---------|-----|
| Mac Host panel | **Add profile** (backend picker includes Gemini) + Edit/Delete. Calls the local gateway at `http://127.0.0.1:8787`. |
| Website `/app/` → Profiles | Same **Add profile** editor when the browser is on this machine (loopback **or** this Mac's own LAN/Tailscale address). |
| Linux Electron → Profiles | Same **Add profile** editor once the host treats this machine as local. |

`POST /profiles` is live in-process — no host restart required for the new chip to dispatch.

---

## Still open

| Item | Status | Notes |
|------|--------|--------|
| **Host process restart** | Operator | Kickstart LaunchAgent (command above) so the new `host/dist` is live. |
| **Browser `/app/` first-turn images** | Gap | Compose in `host/web` still has no screenshot picker. Follow-up images already work on Mac/Linux. |
| **Linux AppImage/deb** | Not built | Must run `cd desktop && npm run dist:linux` **on Linux** / CI — not from this Mac. |
| **Phone Run scheme** | Deferred | iOS target exists; New Session screenshots are in `TaskComposerView` but the phone scheme is not the daily driver. |
| **Host install from Mac** | Needs soak | “Install / update host” + LaunchAgent not fully field-tested after Application Support copy. Running agent today is `com.nightmoose.grok-dispatch-host` → repo `host/dist`. |
| **Electron host install** | Soak | Linux install to `~/.local/share/clankerspanker/host` + systemd exists in product code; soak-test on a real box still open. |
| **ConnectionDefaults hardcode** | Known defect | Still may ship `http://192.168.50.9:8787` — AGENTS.md; fix when touching iOS networking. |
| **Rename leftovers** | Hygiene | `GrokDispatch` directory names, `x-grok-dispatch-token` on the wire (do not rename casually). |
| **event-horizon/** | Untracked on purpose | Separate mini-game; `.gitignore`d. |
| **iOS tests** | None | Swift clients have no automated tests. `xcodegen` via `ios/GrokDispatch/project.yml`. Own RFC — do not silently add untested Swift surface. |
| **House style** | **Shipped RFC-000** | RFC + `make check` + CI. Next feature starts with `make rfc SLUG=…`. |
| **Markdown tables + todo jump** | **RFC-001** | Expanded-message GFM tables; Tasks open the source message (not just the session). |

---

## Recommended next steps

1. **Kickstart the host** (above) and soak: Approve a Write on a live Claude session; attach a screenshot on New Session; click `⋯` on a Bash row; hard-delete a session on Mac and confirm the window stays open.
2. On Linux, `cd desktop && npm start` and repeat 1 / 2 (delete already fine).
3. This arc was committed and pushed 2026-08-23 (status inventory). Kickstart the host before assuming production picked it up.
4. Browser compose screenshots only if you actually use `/app/` for dispatch.

---

## Operator notes (for *you*, not the agent)

When using the products day-to-day:

- **Mac laptop:** Xcode scheme **ClankerSpanker** → destination **My Mac** (never “Designed for iPad”).
- **Linux laptop:** Electron app in `desktop/`.
- **One gateway:** `host/` + config in `~/.grok-dispatch/`.

Agents reading the repo should follow [CLIENTS.md](CLIENTS.md) and [AGENTS.md](../AGENTS.md).
