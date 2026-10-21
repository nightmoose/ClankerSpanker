# RFC-036 — A host with no projects can import from disk

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** main
**Severity:** P1

Document restored 2026-10-21. This number already belonged to the merged work below.
The design note was not in the tree. The number was not reassigned.

---

## Problem

A new host opened the composer onto an empty project list and a hardcoded set of
one machine's folders. There was no way to point at the git repos already on disk.

## What shipped

`POST /projects/discover` lists git repositories under the home directory and the
usual project folders (`host/src/discover-repos.ts`). The composer shares
`EmptyHostProjectsView` with the Mac app so a host with zero projects can import
one. Typed `~/…` paths resolve (`host/src/config.ts`).

RFC-037 adds GitHub Desktop's layout and `discoverRoots`. This RFC is the scan
and the empty-host composer.

## Testing

- `host/src/discover-repos.test.ts`
- `host/src/project-resolve.test.ts`
