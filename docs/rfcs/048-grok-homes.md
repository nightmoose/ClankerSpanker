# RFC-048 — Read every Grok home; resume sessions where they live

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc048-grok-homes
**Severity:** P2

## Problem

Since RFC-020 the NightMoose profile runs Grok with an isolated
`GROK_HOME` (`~/.grok-dispatch/grok-homes/nightmoose`), while the Grok TUI
keeps using `~/.grok`. The host imported disk sessions from `~/.grok` only,
attached every import to the default Grok profile, and resumed them with
that profile's isolated home — where the session doesn't exist. Sessions
started in the isolated home were never imported at all.

## Fix

- `knownGrokHomes(profiles, dataDir)`: machine home (`$GROK_HOME` or
  `~/.grok`) + each Grok/bot profile's home, de-duplicated.
- `listGrokHomeSessions(homes)`: scan every home's `sessions/`, tag hints with
  `grokHome`, label and owning `profileId`; newest wins on id collisions.
- Import: attach to the owning profile; store `grokHome` on the session;
  `grokHomeLabel` only when it's not a profile's own home (e.g. `~/.grok`).
  Existing imports are backfilled on the next sync.
- `profileEnvFor`: a Grok session with `grokHome` runs with that `GROK_HOME`.
- Clients (Mac, iPhone, browser, Electron): small label chip on the row.

## Testing

- [x] `grok-homes.test.ts` (2): home list/labels/dedupe; multi-home scan,
      tagging, newest-wins.
- [x] Live: 36 `~/.grok` sessions and 14 NightMoose-home sessions tagged;
      browser card shows the "~/.grok" chip.
- [ ] Resume of a `~/.grok` session not exercised live (would post into an
      old conversation).
