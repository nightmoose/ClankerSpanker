# RFC-016 — Menu-bar host tray

**Status:** Shipped
**Date:** 2026-09-09
**Branch:** main
**Severity:** P2

Document restored 2026-10-21. This number already belonged to the merged work below.
The design note was not in the tree. The number was not reassigned.

---

## Problem

Menu-bar status lived inside the command-center app. A Mac that only runs the
gateway had to keep that app open, and quitting it was tangled up with the host
process (see RFC-015).

## What shipped

`ClankerSpankerHostTray` is a separate macOS target: a menu-bar app with no
session UI. It shows gateway status, opens the local `/app/` and `/setup` pages,
kickstarts whichever LaunchAgent is loaded, and reveals the log and config folders.

- `ios/ClankerSpanker/HostTray/`
- Scheme `ClankerSpankerHostTray`
- The command-center app no longer installs its own menu-bar extra
  (`ios/ClankerSpanker/ClankerSpanker/GrokDispatchApp.swift`).

This is a configurator, not a client. It does not render sessions.

## Testing

Build the `ClankerSpankerHostTray` scheme on a Mac. Linux CI does not compile Swift.
