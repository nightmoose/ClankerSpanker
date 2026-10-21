# RFC-071 — Phone approval inside a per-job sandbox

**Status:** Shipped
**Date:** 2026-10-21
**Branch:** cursor/rfc-071-sandbox-approval-37e5
**Severity:** P1

`make rfc SLUG=sandbox-approval-channel` assigned 071 after `git fetch origin` on 2026-10-21.

---

## Problem

RFC-070 keeps the host token out of a sandboxed child. The phone-approval hook in `host/src/claude/runner.ts` reads `CLAUDE_DISPATCH_TOKEN` and posts to `/internal/claude-approval`. Without that token the hook denies the tool. A sandboxed job that needs a phone decision cannot get one.

The child must not receive the token, and it must not gain a way to call the rest of the gateway.

## Non-goals

- Putting `CLAUDE_DISPATCH_TOKEN`, `CLAUDE_DISPATCH_HOST`, or `CLAUDE_DISPATCH_SESSION_ID` into the jail.
- Mounting `~/.grok-dispatch` or the host config directory.
- A new public HTTP route. The socket speaks to the two internal approval routes that already exist.
- Letting the child approve, reject, or choose which session the request is for.
- Changing unsandboxed jobs. They still pass the host token to the hook and do not open a socket.
- Turning the network off. That stays a follow-up of RFC-070.
- A sandbox UI on iOS, Mac, or the desktop shell.

## Fix

When a turn is sandboxed and phone approval is on, the host process listens on a unix socket in a mode-0700 directory. The socket file is mode 0600. Linux bind-mounts that file at `/tmp/cs-approval.sock` inside the jail. The private `/tmp` is otherwise empty. macOS allows that one socket path in the seatbelt profile. That path was not run on a Mac.

The hook command is stored in a settings file outside the host config directory. The settings file and the hook script are bind-mounted read-only at the same absolute path. The node binary is mounted as a single file when it does not already sit under a system prefix. The socket path is an argument of that command, not an environment variable the job can retarget.

The socket accepts one JSON object per connection:

- `create` with `toolName`, `title`, and `toolInput`. The session id is the one the host bound when it opened the socket. A session id on the request is ignored.
- `poll` with an `approvalId` this socket created. Any other id is rejected.

Anything else, including an approve or reject operation, is rejected. The parent process calls the existing approval routes with the host token. The token is not written to the socket, the settings file, or the child environment. A handler error is returned as a fixed failure string.

The hook denies the tool when the socket is missing, the frame is refused, or the decision is reject or timeout. A missing token on the unsandboxed path still denies, as it did before.

## Testing

- [x] `approval-broker.test.ts`: create and poll stay on the bound session; a client-supplied session id and token are dropped; approve is rejected; a foreign id is not polled; an oversized frame is refused; the socket is not group-writable; handler errors do not echo the token; the parent sends the bearer token only to the two existing approval routes.
- [x] `runner.test.ts`: unsandboxed child env still has the host token and the hook command has no socket; the unsandboxed hook still sends the bearer token; a socket path is used instead of the token when it is set; a missing socket denies; a jailed child prints the token as unset, reaches the socket, and the parent is the only side that presents the bearer token.
- [x] `sandbox.test.ts`: the allow-list drops `CLAUDE_APPROVAL_SOCK`; the seatbelt profile names the socket and still denies the host config directory; a missing socket does not run the command; a file inside the host config directory is refused; on Linux the jail runs the hook, allows a phone approval, cannot read a sibling secret, and does not see the host token.
- [ ] macOS `sandbox-exec` on a Mac.
- [ ] iOS, the Mac app, and the desktop shell. No UI change.

The hosted runner sets `kernel.apparmor_restrict_unprivileged_userns` when that sysctl exists, so these Linux jail tests are allowed to run there.

## Rollout

1. A sandboxed turn with phone approval opens the socket for that turn and closes it when the child exits.
2. `make check`
3. The row in `docs/rfcs/README.md` is RFC-071.

## Follow-ups

- A network-off switch, still opt-in (RFC-070).
- Approved injection of a credential into the jail. This socket is not that channel.
