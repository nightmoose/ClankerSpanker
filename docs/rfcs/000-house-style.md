# RFC-000 — House style for the gateway repo

**Status:** Shipped
**Date:** 2026-08-23
**Branch:** main
**Severity:** P1

Document restored 2026-10-21. This number already belonged to the merged work below.
The design note was not in the tree. The number was not reassigned.

---

## Problem

Changes were landing without a design note, without a test-count floor, and without CI.
A working tree could grow unreviewed, and a deleted test still left the build green.

## What shipped

- `make check` runs the house-style gate, the host typecheck, and the host build.
- `scripts/house-style-check.py` checks RFC filenames, unique numbers, the RFC index,
  a sibling test (or a `docs/TEST-EXCEPTIONS.md` row) for every host module, and the
  test-count ratchet in `host/test-baseline.txt`.
- `.github/workflows/ci.yml` runs that gate on pull requests and on `main`.
- `scripts/new-rfc.sh` (`make rfc SLUG=…`) copies `docs/rfcs/_template.md`.

## Gap

The original rollout also named `docs/STATUS.md` and `MAINTENANCE_LOG.md`. Neither file
was ever committed. The RFC index in `docs/rfcs/README.md` is the status record. Do not
invent a maintenance log to fill the name.

## Testing

- `python3 scripts/house-style-check.py`
- `python3 scripts/rfc_alloc_test.py`
