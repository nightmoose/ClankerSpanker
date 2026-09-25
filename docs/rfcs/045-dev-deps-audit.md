# RFC-045 — Clear host dev-dependency advisories (vitest 5, nanoid)

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc045-dev-deps-audit
**Severity:** P3

## Problem

`npm audit` in `host/`: 3 findings (1 high) — `nanoid < 3.3.18` (infinite
loop with size 0) and `vitest ≤ 4.1.10` / `@vitest/mocker` (path traversal
via redirect mock). Dev-only; production deps were already clean.

## Fix

`npm audit fix` (nanoid) and `vitest` ^3.2.4 → ^5.0.2.

## Testing

- [x] 350/350 tests, typecheck, build, ratchet parse unchanged;
      `npm audit` → 0 vulnerabilities.
