# RFC-068 — The gateway keeps its own log files bounded

**Status:** Accepted
**Date:** 2026-10-20
**Branch:** rfc-068-gateway-log-rotation
**Severity:** P3

---

## Problem

On macOS the gateway runs as a LaunchAgent whose plist sends stdout and stderr to
`~/Library/Logs/clankerspanker-host.log` and `clankerspanker-host.err.log`. launchd opens
those files in append mode and never trims them. On the owner's Mac they reached 21 MB and
30 MB (2026-10-20). Most of the error log was an old `EADDRINUSE` crash loop that nobody
could read through. Nothing in the repo rotates them, and fixing it with `newsyslog`
would need root.

## Non-goals

- Linux. The systemd user unit writes to the journal, which journald already bounds.
- Structured logging, log levels, or shipping logs anywhere.
- Rotating files the gateway does not own.

## Fix

`host/src/log-rotate.ts`, started from `host/src/index.ts` at boot:

- Find this process's own log files: entries in `~/Library/Logs/*.log` whose device and inode
  match stdout (fd 1) or stderr (fd 2). A standalone `grok-dispatch-host` install, another
  gateway, or any other file is never touched. Under systemd nothing matches, so it does
  nothing.
- When a matching file passes `logMaxBytes` (default 10 MB), copy it to `.1` (older copies
  shift to `.2` and `.3`; the oldest is dropped), then truncate the live file in place.
  launchd's descriptor is append-only, so the gateway's next write lands at the start of
  the emptied file. That is the property that makes copy-then-truncate safe. A test pins it.
- Check at boot, then every 10 minutes (an unref'd timer). Stop on shutdown.
- `logMaxBytes` in `~/.grok-dispatch/config.json`: a number of bytes, or `0` to disable.
  Invalid values fall back to the default.

## Testing

- [x] `host/src/log-rotate.test.ts` (7): small files left alone; copy and truncate; `.N`
  shift and the keep limit; an append-mode writer continues at offset 0 after truncation;
  `0` disables it; only files matching stdout/stderr by inode are selected; nothing is
  selected when stdout isn't a file.
- [x] `host/src/config.test.ts` (+2): `logMaxBytes` is kept, `0` is kept, and invalid
  values are dropped.
- [ ] After install on the owner's Mac: both logs are rotated at the next boot (they are
  over 10 MB), `.1` copies exist, and the gateway keeps logging into the emptied files.

## Rollout

1. Merge, then Install / update host. The first boot rotates the two oversized logs.
