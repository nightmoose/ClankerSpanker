# RFC-062 — Absorbed by RFC-061

**Status:** Superseded
**Date:** 2026-10-19
**Branch:** main
**Severity:** P3

---

## Problem

A follow-on number was reserved so `sql_execute` could ship separately from the
project database binding. Two design notes for one change would leave a number
that looks free and a number that looks unfinished.

## What this number means

RFC-061 delivers the binding, the sealed secret, and the `sql_execute` tool.
This file holds the number so nothing else can take it. There is no second
implementation, no second route, and no second migration.

Do not reopen 062 for a new change. Run `make rfc` for a new number.

## Testing

Not applicable. `host/src/mcp/sql-execute.test.ts` covers the tool under RFC-061.
