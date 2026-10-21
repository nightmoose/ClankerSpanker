# RFC-045 — Host dev-dependency advisories

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** main
**Severity:** P3

Document restored 2026-10-21. This number already belonged to the merged work below.
The design note was not in the tree. The number was not reassigned.

---

## Problem

The host's development dependencies reported advisories. The lockfile was the
only place the fix could land, and without a design note the number looked free.

## What shipped

`host/package.json` depends on Vitest 5. The lockfile update that landed with
this number cleared the advisory set that included `nanoid`. No gateway route,
config field, or client behavior changed.

## Testing

`cd host && npm test` is the suite that Vitest 5 runs. There is no separate
behavioral test; the lockfile is the change.
