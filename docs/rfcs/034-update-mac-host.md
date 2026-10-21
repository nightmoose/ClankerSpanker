# RFC-034 — One command to update a Mac host

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** main
**Severity:** P2

Document restored 2026-10-21. This number already belonged to the merged note below.
The design note was not in the tree. The number was not reassigned.

---

## Problem

Updating the gateway on a Mac was a sequence of git, npm, and launchctl commands.
The change that took this number documented one script and did not add the script.

## What shipped

`scripts/update-mac-host.sh`, restored from the command the original change
described and never committed.

```bash
./scripts/update-mac-host.sh
./scripts/update-mac-host.sh --bind-auto --rotate-token
```

- The checkout must track `origin/main`. Any other upstream, including a missing
  one, exits before fetch. This is the RFC-059 rule: a feature branch is not a
  host update.
- A dirty tree exits before fetch.
- Otherwise: `git fetch`, `git pull --ff-only`, `npm ci`, `npm run build` in `host/`.
- `--bind-auto` sets `bindHost` to `auto` in the gateway config. `--rotate-token`
  deletes `hostToken`. The file stays mode `0600`.
- A loaded LaunchAgent (`com.nightmoose.clankerspanker-host` or
  `com.nightmoose.grok-dispatch-host`) is kickstarted. Otherwise a running
  systemd user unit is restarted. If neither is loaded, `host/scripts/install-service.sh`
  installs one.

`--plan` prints those steps and does not touch the checkout. Clients re-pair
from `/setup` after a rotation.

## Testing

- `python3 scripts/update-mac-host_test.py`
- Not run on a Mac: LaunchAgent kickstart. The Linux path is the install-service
  fallback, and the tests stop at `--plan` so they do not install a service.
