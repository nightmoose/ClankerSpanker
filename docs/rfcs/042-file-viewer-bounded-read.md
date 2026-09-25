# RFC-042 — File viewer reads only what it shows

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc042-file-viewer-realpath
**Severity:** P3

## Problem

`readSessionFile` did `readFileSync(abs).subarray(0, cap)`: the whole file
(e.g. a multi-GB log) was loaded into memory before truncating. (The review
also suspected a symlink escape; `isPathAllowed` already uses `realpath`,
so that was wrong — now covered by a regression test.)

## Fix

Read only the capped prefix (`openSync` + `readSync`).

## Testing

- [x] `files.test.ts`: a symlink inside the workspace pointing outside is
      refused; a sparse 64 MB file returns `truncated` without a full read.
