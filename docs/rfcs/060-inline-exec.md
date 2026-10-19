# RFC-060 — Inline shell execution from chat code blocks

**Status:** Accepted
**Date:** 2026-10-02
**Branch:** nightly-maintenance-2026-10-02-rfc058-inline-exec
**Severity:** P2
**Renumbered:** 2026-10-19, from RFC-058. Number 058 went to the hosted product site on `main`; the branch name keeps the old number.

---

## Problem

When an agent produces a `` ```bash `` code block, the user must manually copy it,
switch to a terminal, paste, run, then copy back the output to continue the
conversation. This 4-step detour is the main friction point for debugging cycles.

## Non-goals

- Inline terminal (PTY) in the chat bubble — follow-up RFC.
- Electron / browser client — follow-up; iOS/Mac scope here.
- Execution approval gate for native clients. The user chose to tap Run in the
  app. Browsers are refused instead (see "Who may call it").

## Fix

### Host — `POST /exec`

New endpoint in `host/src/exec.ts`:

```
POST /exec
Authorization: Bearer <token>

{ "command": string, "cwd"?: string, "timeoutMs"?: number }

→ 200 { "stdout": string, "stderr": string, "exitCode": number, "durationMs": number }
```

- `timeoutMs` defaults to 30 000, capped at 60 000.
- Output capped at 100 KB each stream.
- Uses the configured login shell (`$SHELL` → `/bin/bash`).
- `cwd`, if given, must be an existing directory (validated via `statSync`; returns 400 otherwise).
- Requires auth (same bearer gate as every other route), then the native-only
  rule below.

### Who may call it (2026-10-19)

Same rule as `/host/update` (RFC-059).
`POST /exec` and `GET`/`POST /host/update` are native-only routes
(`nativeOnlyRefusal` in `host/src/trusted-local.ts`). After the token check,
the gateway answers 403 when:

- the request has `Tailscale-User-Login`, on any listener. That header means it
  came through `tailscale serve`, which is how a browser on another device, or
  the hosted site, reaches the gateway (RFC-058 phase 2);
- it has an `Origin` other than `http://<its own Host header>`. That covers
  `https://clankerspanker.tech`, Vercel previews, any other website, and
  `Origin: null`;
- it has `Sec-Fetch-Site` other than `same-origin` or `none`.

Allowed: the iOS and Mac apps, which send no `Origin`, from any address. A
phone on a Tailscale IP still works, because the peer address is not checked.
The gateway's own pages on the direct listener (`/setup`, `/app/` on
`http://<host>:8787`) also work, since their `Origin` matches the Host header.

**Why.** Since RFC-058 phase 2 the host token works from the public page and
through the serve listener. A token sitting in any browser's `localStorage`
could then run shell commands or restart the host with no approval card. A
leaked or stolen token alone does not reach the gateway from the internet,
because it listens on loopback and the tailnet. So the browser is the path to
close, and `Origin` plus the serve header is the smallest rule that closes it
without breaking the phone. Gating on "this machine" was rejected because the
phone reaches 8787 over a Tailscale IP and is not local.

No web client calls `/exec` today. A browser Run button on the hosted site
would need an approval-style confirmation on the gateway first, which is a
new RFC.

### iOS/Mac — Run button in expanded code blocks

`MarkdownParser.Block.code` gains a `lang` field (was opaque `String`; now
`code(lang: String?, body: String)`). The fence opener `` ```bash `` is parsed
to extract the language specifier.

`MarkdownView` gains `onRunCode: ((String) -> Void)?`. When a code block's lang
is `bash`, `sh`, `zsh`, or `shell`, a "Run" button appears alongside the
existing "Copy" button. Tapping it fires `onRunCode(body)`.

The callback threads from `MarkdownView` → `ExpandedMessageView` →
`TranscriptView` → `SessionDetailView`, where `vm.runAndInject(command:api:)`
is called:

1. `POST /exec` with the command and the session `cwd`.
2. Formats output as a fenced code block: `` `$ cmd\nstdout+stderr` ``.
3. Appends an optimistic `user` entry to the transcript immediately.
4. `POST /sessions/:id/prompt` so the agent sees the output and continues.

## Testing

- [x] `exec.test.ts`: stdout, stderr, nonzero exit, timeout, cwd validation, max-timeout clamp (6 tests)
- [x] `openapi-contract.test.ts` passes (catches missing spec entry automatically)
- [x] `native-only-routes.test.ts`: a native client runs a command, the gateway's
      own origin runs one, and the hosted origin, foreign and `null` origins, and
      the serve listener get 403 without running it
- [ ] Manual: tap Run on a `bash` block in an expanded assistant message → output appears as a user bubble and the agent responds

## Rollout

1. `make check`
2. Build + install `ClankerSpankerPhone` on your iPhone
3. Update `docs/STATUS.md` → Shipped
4. Append `MAINTENANCE_LOG.md`

## Follow-ups

- Electron/browser Run button. Electron sends `Origin: null` and is refused
  today, so it needs its own rule. The hosted site needs a gateway-side approval
  card first.
- Approval gate option for untrusted commands.
- Shell block detection heuristic for unlabelled fences (trailing `$`-prompt lines, etc.).
