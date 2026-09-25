# RFC-043 — Remove the hardcoded LAN IP; onboarding pairs by QR

**Status:** Shipped
**Date:** 2026-09-25
**Branch:** nightly-maintenance-2026-09-25-rfc043-remove-lan-ip
**Severity:** P3

## Problem

`ConnectionDefaults.lanHostURL = "http://192.168.50.9:8787"` pre-filled the
phone's Host URL, and onboarding's "Fetch token from Mac (same Wi-Fi)"
pulled `/connect.json` from it. After RFC-026 (token only served to the
host machine) and RFC-028 (no LAN listener) neither can work, and the IP
was one Mac's address on one network.

## Fix

- `ConnectionDefaults`: only loopback (simulator / Mac app) and a Tailscale
  placeholder; `setupPageURL` = `http://localhost:8787/setup` on the host.
- Phone onboarding: "open /setup on the Mac and scan the QR" instead of the
  fetch button (kept for Simulator and the Mac app, where it works).
- Docs (AGENTS, CLAUDE, HOUSE-STYLE, PROJECT_STATUS, NEXT-STEPS) updated;
  house-style IP allowlist shrinks to `host/src/platform.ts`.

## Testing

- [x] Phone (device SDK), Simulator and Mac builds; no `192.168` left in
      the app sources; `make check`.
