# RFC-000 — Adopt ContractGate house style in ClankerSpanker

**Status:** Shipped
**Date:** 2026-08-23
**Branch:** nightly-maintenance-2026-08-23-rfc000-house-style
**Severity:** P1 — process; stops the unreviewed-pile failure mode
**Addresses:** estate cleanup 2026-08-23; ContractGate CONTRIBUTING + CI + RFC-071

---

## Problem

ClankerSpanker accumulated a 10k+ line working tree with no RFC, no CI, no
merge gate, and no run log. ContractGate did not: RFC-first, one issue per
`nightly-maintenance-*` branch, tests that cannot be skipped to go green,
docs in the same change, `MAINTENANCE_LOG` + `docs/STATUS.md`, and CI that
fails the merge (fmt/clippy/test, coverage *ratchet*, migration contract).

Without that loop here, the next agent or human will recreate the pile.

## Non-goals

- Porting cargo-deny, sqlx, or compose smokes (this repo is Node + Swift).
- Writing the missing Swift client tests in this RFC.
- Fixing `ConnectionDefaults.lanHostURL` (`192.168.50.9`) — known defect,
  tracked in `docs/NEXT-STEPS.md`.
- Completing the GrokDispatch → ClankerSpanker rename.

## Fix

1. Canonical playbook: [`docs/HOUSE-STYLE.md`](../HOUSE-STYLE.md).
2. RFC template + numbered `docs/rfcs/` + [`docs/STATUS.md`](../STATUS.md).
3. `MAINTENANCE_LOG.md`, `CONTRIBUTING.md`, `scripts/new-rfc.sh`.
4. **Enforcement:** `scripts/house-style-check.py` + `make check`.
   - RFC files numbered, listed in STATUS.
   - Heavy diffs vs `origin/main` must include an RFC + a log entry.
   - Host test-count ratchet (`host/test-baseline.txt`) — fail on drop.
   - New `host/src/**/*.ts` modules need a sibling `.test.ts` or an entry in
     `docs/TEST-EXCEPTIONS.md`.
   - New hardcoded `192.168.*` literals outside the allowlist fail.
5. GitHub Actions CI on push/PR to `main` (docs-only skips the host matrix).

## Testing

- [x] `python3 scripts/house-style-check.py` passes on this branch
- [x] `cd host && npm test` — 106 tests (baseline seeded at 106)
- [x] `cd host && npm run typecheck && npm run build`

## Rollout

1. Land this RFC and the checker on `main`.
2. After merge, every subsequent heavy change is gated.
3. Next feature work starts with `scripts/new-rfc.sh`.

## Follow-ups

- Swift test target (iOS/Mac) — own RFC.
- OpenAPI drift check vs `host/src/server.ts` — own RFC.
- Fix hardcoded LAN default — own RFC.
- Install the same `make check` shape in other Nightmoose repos.
