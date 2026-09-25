# RFC-041 — Mac toolbar buttons have names

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc041-toolbar-labels
**Severity:** P3

## Problem

Toolbar buttons were bare `Image(systemName:)`s: VoiceOver read SF Symbol
names ("checklist", "server.rack", "Move", "Search Document"), and the
toolbar's overflow menu (narrow window) listed icons with no text.

## Fix

`Label("Projects" / "Tasks" / "Terminal" / "Host" / "Settings" / "Refresh
sessions" / "Show file viewer", systemImage:)` — icon-only in the toolbar,
named for accessibility and the overflow menu. Decorative icons hidden from
accessibility.

## Testing

- [x] Accessibility tree: "Refresh sessions", "Show file viewer" (was
      "Search Document", …).
