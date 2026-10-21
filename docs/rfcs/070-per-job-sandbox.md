# RFC-070 — Opt-in per-job sandbox

**Status:** Shipped
**Date:** 2026-10-21
**Branch:** cursor/rfc-070-per-job-sandbox-ba0d
**Severity:** P1

`make rfc SLUG=per-job-sandbox` assigned 070 after `git fetch origin` on 2026-10-21.

---

## Problem

A dispatch, a worker run, and `POST /exec` all run on the host. The child gets the host environment. The Claude CLI child also receives `CLAUDE_DISPATCH_TOKEN`, which is the host token. File tools in the in-process worker already stay under the workspace; `web_fetch` and `web_search` do not, and a shell command can read any path the host user can read, including `~/.grok-dispatch`.

Cua (github.com/trycua/cua, README read 2026-10-21) is a computer-use framework. Its agent gets a computer. This gateway is a local-first control plane for jobs on the machine the operator already uses. The gap that matters here is isolation of one job, turned on by that job, with every other job left as it is today.

### Gaps compared with Cua

| Gap | Cua | This repo, before this RFC | This RFC |
|---|---|---|---|
| Per-job filesystem jail | `cua sb` gVisor container, or a Space | Host filesystem and host environment | Done, opt-in |
| Host token kept out of the job | Credentials enter a Space from the Keyvault after approval | `CLAUDE_DISPATCH_TOKEN` is injected into the Claude CLI child | Done for a sandboxed child |
| Network off by default | A sandbox is a computer; network is how it works | Network is the host network | Left on. A later switch can turn it off |
| Desktop driver (screenshot, click, type, background delivery) | Cua Driver | No screen or input control | Deferred |
| VM runtime | Lume, macOS / Linux / Omarchy Spaces, cloud account | None | Deferred |
| In-sandbox daemon for processes, files, screenshots | `cua-spacesd` on port 3211 | None | Deferred |
| Task, reward, trajectory export | Cua Bench | None | Deferred |
| Small UI-decision model | CUA-S1 | None | Deferred |
| Approved credential injection | Teleport and Keyvault | Profile env and home directories are ambient | Profile env and named config dirs only, inside a sandbox. Full keyvault deferred |

Cua's product is "the agent gets a computer." Here the sandbox is off unless the request or the saved worker sets boolean `sandbox: true`.

## Non-goals

- A desktop driver, a VM, a cloud sandbox, a benchmark, or a UI-decision model.
- Turning the network off. Model CLIs need it to reach their APIs. A network-off switch is a follow-up.
- Mounting the operator's home, or `~/.grok-dispatch`.
- Copying `process.env` into the child.
- Injecting the host token. Phone-approval hooks that need `CLAUDE_DISPATCH_TOKEN` do not fire inside the jail.
- A sandbox UI on iOS, Mac, or the desktop shell. Callers send the flag.
- Filling the sandbox with a container runtime. Linux uses `unshare`. macOS uses `sandbox-exec` when that binary exists.

## Fix

`sandbox: true` is the only value that opts in. `false`, a missing field, and the string `"true"` keep the existing spawn and the existing `runCommand` body.

- `POST /exec` (`host/src/exec.ts`, `host/src/server.ts`) runs the command in the jail when the flag is set.
- `POST /dispatch` stores `sandbox: true` on the session only when the request flag is set. `fireBot` copies `bot.sandbox` the same way.
- `normalizeBot` persists `sandbox: true` and drops every other value, so a patch of `false` turns it off.
- Claude, Antigravity, and Grok CLI spawns (`host/src/claude/runner.ts`, `host/src/antigravity/runner.ts`, `host/src/acp/client.ts`) use the jail only when `session.sandbox === true`. The other branch is the previous `spawn` call.
- The in-process worker refuses `web_fetch` and `web_search` when the session flag is set. File tools stay confined to the workspace, as they already were.
- Session summaries and the slim list include `sandbox: true` only when the job opted in.

Linux jail (`host/src/sandbox.ts`): `unshare --user --map-root-user --mount --pid --fork --kill-child --propagation private`, then a chroot. `/bin`, `/sbin`, `/usr`, `/lib`, `/lib64`, `/etc`, and `/opt` are bind-mounted read-only. The workspace and any extra dirs are bind-mounted read-write at the same absolute path. Named config dirs (`CLAUDE_CONFIG_DIR`, `GROK_HOME`, `ANTIGRAVITY_CONFIG_DIR`, and the directory of `NPM_CONFIG_USERCONFIG`) are mounted read-only when they are not the host config root. Home inside the jail is a private empty directory. `/tmp` is a private directory, not the host `/tmp`, so a workspace under `/tmp` is not covered up. The host config directory is never mounted. If `unshare` is missing, the call throws and `POST /exec` returns 400. It does not fall back to an unsandboxed run.

The child environment is an allow-list (API keys and the config-dir variables above) plus keys that differ from the host process. `CLAUDE_DISPATCH_TOKEN` and the rest of `CLAUDE_DISPATCH_*` are removed. `HOME` and `TMPDIR` point at the private directories.

macOS: the same checks, then `sandbox-exec` with a seatbelt profile that denies the host config directory. That path is in the tree and covered by a profile-string test. It was not run on a Mac.

Network stays on (no `--net`). That is deliberate for this version.

## Testing

- [x] `sandbox.test.ts`: the flag is boolean true only; explicit env drops the host token and ambient host variables; the linux argument list has no `--net`; the seatbelt profile denies the host config directory; bot persistence and session summaries omit the field unless it is true.
- [x] Linux jail: a command reads and writes its workspace, cannot read a sibling secret, cannot see `/home` beyond the private directory, cannot write `/usr`, and does not receive host API keys. The secret file on the host is unchanged.
- [x] The string `"true"` still reads a file outside the workspace.
- [x] A workspace inside the host config directory is refused.
- [x] A sandboxed `sleep` past the timeout returns exit code -1.
- [x] `exec.test.ts`: without the flag, `runCommand` still reads a file outside the workspace.
- [x] `tools.test.ts`: `web_fetch` and `web_search` throw when the tool context is sandboxed.
- [ ] macOS `sandbox-exec` on a Mac.
- [ ] iOS, the Mac app, and the Electron shell. No UI change.

## Rollout

1. Callers that want a jail send boolean `sandbox: true` on `POST /exec`, `POST /dispatch`, or the worker record.
2. `make check`
3. Record the status on the row in `docs/rfcs/README.md` (RFC-000).

## Follow-ups

- A network-off switch, still opt-in, defaulting to today's network.
- Phone approval inside a jail, which needs a scoped credential instead of the host token.
- Desktop driver: screenshot, click, type, background delivery.
- A VM or container runtime (Lume-style, gVisor, Spaces) for jobs that need a full computer.
- An in-sandbox daemon for processes, files, and screenshots.
- Task, reward, and trajectory export.
- A small UI-decision model.
- Approved injection of a credential into the jail (keyvault / teleport), instead of mounting a config directory.
