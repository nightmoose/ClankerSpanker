# RFC-037 — Discover roots, including GitHub Desktop clones

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** main
**Severity:** P2

Document restored 2026-10-21. This number already belonged to the merged work below.
The design note was not in the tree. The number was not reassigned.

---

## Problem

RFC-036's scan missed GitHub Desktop, which clones to `~/Documents/GitHub/<org>/<repo>`,
and it had no place for a machine-specific folder that is not in the built-in list.

## What shipped

The scan walks `~/Documents/GitHub` even when `~/Documents` itself is a stop.
`discoverRoots` in `config.json` (for example `["~/work"]`) adds more folders,
two levels down. The field is on the host config type and is not returned as a secret.

## Testing

- `host/src/discover-repos.test.ts` (`discover roots`)
