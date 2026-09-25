# RFC Status Index

All RFCs in `docs/rfcs/`. **Shipped** = on `main`; **Accepted** = signed off;
**Draft** = under review; **Superseded** = replaced.

| RFC | Title | Status | Shipped in branch |
|---|---|---|---|
| 000 | [Adopt ContractGate house style](rfcs/000-house-style.md) | Shipped | `nightly-maintenance-2026-08-23-rfc000-house-style` |
| 001 | [Markdown tables + todo jump to source](rfcs/001-md-tables-todo-jump.md) | Shipped | `nightly-maintenance-2026-08-23-rfc001-md-tables-todo-jump` |
| 002 | [Transcript chat-only, session Files, extra folders](rfcs/002-session-chat-files-folders.md) | Accepted | `nightly-maintenance-2026-08-24-rfc002-session-chat-files-folders` |
| 003 | [Create and run bots from the iPhone app](rfcs/003-phone-bots.md) | Accepted | `nightly-maintenance-2026-08-24-rfc002-session-chat-files-folders` |
| 004 | [Host terminal from the phone](rfcs/004-host-terminal.md) | Accepted | `nightly-maintenance-2026-08-24-rfc002-session-chat-files-folders` |
| 005 | [Attach Antigravity / Gemini CLI conversations](rfcs/005-attach-agy.md) | Accepted | `nightly-maintenance-2026-08-24-rfc005-attach-agy` |
| 006 | [Backend parity pass (Grok / Claude / Antigravity / Bot)](rfcs/006-backend-parity.md) | Draft | `nightly-maintenance-2026-08-28-rfc006-backend-parity` |
| 007 | [Phone copy/paste: Term paste + session message selection](rfcs/007-ios-term-copy-paste.md) | Accepted | `nightly-maintenance-2026-08-29-rfc007-ios-term-copy-paste` |
| 008 | [Per-profile MCP servers (payer isolation)](rfcs/008-profile-mcp.md) | Accepted | `nightly-maintenance-2026-08-29-rfc008-profile-mcp` |
| 009 | [Remote MCP OAuth (PKCE)](rfcs/009-mcp-oauth.md) | Accepted | `nightly-maintenance-2026-08-30-rfc009-mcp-oauth` |
| 010 | [iOS app icon badge](rfcs/010-ios-app-icon-badge.md) | Accepted | `nightly-maintenance-2026-09-09-rfc011-apns` |
| 011 | [APNs so a killed iPhone still badges](rfcs/011-apns.md) | Accepted | `nightly-maintenance-2026-09-09-rfc011-apns` |
| 012 | [Stop NightMoose login modal on MCP AuthRequired](rfcs/012-login-modal-mcp-false-positive.md) | Accepted | `nightly-maintenance-2026-09-09-rfc012-login-modal-mcp-false-positive` |
| 013 | [Profile MCP catalog](rfcs/013-profile-mcp-catalog.md) | Accepted | `nightly-maintenance-2026-09-09-rfc013-profile-mcp-catalog` |
| 014 | [Close as done sticks; hide Grok helper sessions](rfcs/014-close-done-hide-helpers.md) | Accepted | `nightly-maintenance-2026-09-09-rfc014-close-done-hide-helpers` |
| 015 | [Detach the Mac app from the host process](rfcs/015-host-detach.md) | Accepted | `nightly-maintenance-2026-09-09-rfc015-host-detach` |
| 016 | [Standalone Mac host tray](rfcs/016-host-tray.md) | Accepted | `nightly-maintenance-2026-09-09-rfc016-host-tray` |
| 017 | [Duplicate Grok assistant messages](rfcs/017-grok-dupe.md) | Draft | `nightly-maintenance-2026-09-11-rfc017-grok-dupe` |
| 018 | [Markdown link resolver with cwd context](rfcs/018-mdlink.md) | Accepted | `nightly-maintenance-2026-09-11-rfc018-mdlink` |
| 019 | [Stuck "Running" + phantom pending questions](rfcs/019-stuck-running.md) | Accepted | `nightly-maintenance-2026-09-11-rfc019-stuck-running` |
| 020 | [Apply the MCP catalog per profile](rfcs/020-mcp-catalog-apply.md) | Shipped | `nightly-maintenance-2026-09-16-rfc020-mcp-catalog-apply` |
| 021 | [Per-session Grok credit meter](rfcs/021-session-credit-meter.md) | Shipped | `nightly-maintenance-2026-09-17-rfc021-session-credit-meter` |
| 022 | [Reset-time tooltip on profile usage chip](rfcs/022-usage-reset-times.md) | Shipped | `nightly-maintenance-2026-09-18-rfc022-usage-reset-times` |
| 023 | [In-app PDF preview + share on the session file viewer](rfcs/023-file-viewer-pdf.md) | Accepted | `nightly-maintenance-2026-09-21-rfc023-file-viewer-pdf` |
| 024 | [iOS multi-host: WS pool, per-host fan-out, hostId end-to-end](rfcs/024-ios-multi-host.md) | Shipped | `nightly-maintenance-2026-09-21-rfc024-ios-multi-host` |
| 025 | [Electron desktop multi-host: WS pool, per-host fan-out, hostId end-to-end](rfcs/025-desktop-multi-host.md) | Shipped | `nightly-maintenance-2026-09-22-rfc025-desktop-multi-host` |
| 026 | [Stop handing out the host token: local-only setup, QR pairing, private config](rfcs/026-host-token-exposure.md) | Shipped | `nightly-maintenance-2026-09-25-rfc026-host-token-exposure` |
| 027 | [Mac host installer: never install from itself, always rebuild](rfcs/027-installer-self-source.md) | Shipped | `nightly-maintenance-2026-09-25-rfc027-installer-self-source` |
| 028 | [Listen on loopback + Tailscale, not every network](rfcs/028-bind-loopback-tailscale.md) | Shipped | `nightly-maintenance-2026-09-25-rfc028-bind-loopback-tailscale` |
| 029 | [WebSocket tickets: the host token leaves the URL](rfcs/029-ws-tickets.md) | Shipped | `nightly-maintenance-2026-09-25-rfc029-ws-tickets` |
| 030 | [Say plainly that Gemini sessions auto-approve](rfcs/030-gemini-auto-approve-honesty.md) | Shipped | `nightly-maintenance-2026-09-25-rfc030-gemini-auto-approve-honesty` |
| 031 | [Keep push notifications under the APNs size limit](rfcs/031-apns-payload-size.md) | Shipped | `nightly-maintenance-2026-09-25-rfc031-apns-payload-size` |
| 032 | [Projects follow the folder: ~ expansion, inference, overlap warnings](rfcs/032-project-resolution.md) | Shipped | `nightly-maintenance-2026-09-25-rfc032-project-resolution` |
| 033 | [Approval cards show the diff or command; Diff tab shows new files](rfcs/033-approval-preview.md) | Shipped | `nightly-maintenance-2026-09-25-rfc033-approval-preview` |
| 034 | [One-command host update for a Mac](rfcs/034-update-mac-host-script.md) | Shipped | `nightly-maintenance-2026-09-25-rfc034-update-mac-host-script` |
| 035 | [iPhone opens sessions on their own host](rfcs/035-phone-cross-host-open.md) | Shipped | `nightly-maintenance-2026-09-25-rfc035-phone-cross-host-open` |
| 036 | [A host with no projects is usable from the composer](rfcs/036-composer-empty-host.md) | Shipped | `nightly-maintenance-2026-09-25-rfc036-composer-empty-host` |
| 037 | [Import from disk finds GitHub Desktop clones; configurable roots](rfcs/037-discover-roots.md) | Accepted | `nightly-maintenance-2026-09-25-rfc037-discover-roots` |
| 038 | [Session list status follows live events](rfcs/038-live-list-status.md) | Shipped | `nightly-maintenance-2026-09-25-rfc038-live-list-status` |
| 039 | [Mac composer + project form fixes](rfcs/039-mac-composer-fixes.md) | Shipped | `nightly-maintenance-2026-09-25-rfc039-mac-composer-fixes` |
| 040 | [Tool rows show command output and exit code](rfcs/040-tool-output.md) | Shipped | `nightly-maintenance-2026-09-25-rfc040-tool-output` |
| 041 | [Mac toolbar buttons have names](rfcs/041-toolbar-labels.md) | Shipped | `nightly-maintenance-2026-09-25-rfc041-toolbar-labels` |
| 042 | [File viewer reads only what it shows](rfcs/042-file-viewer-bounded-read.md) | Shipped | `nightly-maintenance-2026-09-25-rfc042-file-viewer-realpath` |
| 043 | [Remove the hardcoded LAN IP; onboarding pairs by QR](rfcs/043-remove-lan-ip.md) | Shipped | `nightly-maintenance-2026-09-25-rfc043-remove-lan-ip` |
| 044 | [OpenAPI contract test](rfcs/044-openapi-contract.md) | Shipped | `nightly-maintenance-2026-09-25-rfc044-openapi-contract` |
| 045 | [Clear host dev-dependency advisories](rfcs/045-dev-deps-audit.md) | Shipped | `nightly-maintenance-2026-09-25-rfc045-dev-deps-audit` |
| 046 | [First Swift unit tests](rfcs/046-swift-tests.md) | Shipped | `nightly-maintenance-2026-09-25-rfc046-swift-tests` |
| 047 | [Finish the ClankerSpanker rename (in-repo parts only)](rfcs/047-rename-safe-parts.md) | Shipped | `nightly-maintenance-2026-09-25-rfc047-rename-safe-parts` |
| 048 | [Read every Grok home; resume sessions where they live](rfcs/048-grok-homes.md) | Shipped | `nightly-maintenance-2026-09-25-rfc048-grok-homes` |
| 049 | [Browser client recovers from a rotated token](rfcs/049-web-token-recovery.md) | Shipped | `nightly-maintenance-2026-09-25-rfc049-web-token-recovery` |
| 050 | [Browser + Electron parity with today's Swift features](rfcs/050-web-electron-parity.md) | Shipped | `nightly-maintenance-2026-09-25-rfc050-web-electron-parity` |
| 051 | [Split session-manager.ts, phase A](rfcs/051-split-session-manager-a.md) | Shipped | `nightly-maintenance-2026-09-25-rfc051-split-session-manager-a` |
| 052 | [Split session-manager.ts, phase B: CLI backends become runners](rfcs/052-split-session-manager-b.md) | Shipped | `nightly-maintenance-2026-09-25-rfc052-split-session-manager-b` |
