# RFC-034 — One command to update a Mac host

**Status:** Accepted
**Date:** 2026-09-25
**Branch:** main
**Severity:** P2

Document restored 2026-10-21. This number already belonged to the merged note below.
The design note was not in the tree. The number was not reassigned.

---

## Problem

Updating the gateway on a Mac was a sequence of git, npm, and launchctl commands.
The change that took this number documented one script and did not add the script.

## What was specified

From a checkout on that Mac:

```bash
./scripts/update-mac-host.sh --bind-auto --rotate-token
```

The script pulls, builds, restarts the LaunchAgent, and with those flags switches
the bind to loopback + Tailscale and mints a new token. Drop the flags for a code
update only. Clients re-pair from `/setup` after a rotation.

## What is actually in the repo

`scripts/update-mac-host.sh` was never committed. The OSS cleanup replaced the
host README recipe with the manual commands. `docs/STANDALONE-INSTALLS.md` still
names the script, which is wrong until the file exists.

RFC-059 later added a gateway button that fast-forwards only a checkout whose
upstream is `origin/main`. A restored script has to follow that rule. It must
not fast-forward a feature branch.

## Testing

None until the script exists. Do not mark this Shipped on the strength of the
README paragraph.
