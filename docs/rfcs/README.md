# RFC index

Design notes for non-trivial changes. **Shipped** = on `main`; **Accepted** = signed off;
**Draft** = under review.

Some early RFCs (process, security-hardening and device-specific notes) are kept in a private
repository, so numbering has gaps; numbers 000-057 are reserved. Start a new RFC with `make rfc SLUG=short-kebab`
(template: [`_template.md`](_template.md)) and add a row below.

| RFC | Title | Status |
|---|---|---|
| 001 | [Markdown tables + todo jump to source](001-md-tables-todo-jump.md) | Shipped |
| 002 | [Transcript chat-only, session Files, extra folders](002-session-chat-files-folders.md) | Accepted |
| 003 | [Create and run bots from the iPhone app](003-phone-bots.md) | Accepted |
| 004 | [Host terminal from the phone](004-host-terminal.md) | Accepted |
| 005 | [Attach Antigravity / Gemini CLI conversations](005-attach-agy.md) | Accepted |
| 006 | [Backend parity pass (Grok / Claude / Antigravity / Bot)](006-backend-parity.md) | Draft |
| 007 | [Phone copy/paste: Term paste + session message selection](007-ios-term-copy-paste.md) | Accepted |
| 008 | [Per-profile MCP servers (payer isolation)](008-profile-mcp.md) | Accepted |
| 009 | [Remote MCP OAuth (PKCE)](009-mcp-oauth.md) | Accepted |
| 010 | [iOS app icon badge](010-ios-app-icon-badge.md) | Accepted |
| 012 | [Stop NightMoose login modal on MCP AuthRequired](012-login-modal-mcp-false-positive.md) | Accepted |
| 013 | [Profile MCP catalog](013-profile-mcp-catalog.md) | Accepted |
| 014 | [Close as done sticks; hide Grok helper sessions](014-close-done-hide-helpers.md) | Accepted |
| 015 | [Detach the Mac app from the host process](015-host-detach.md) | Accepted |
| 017 | [Duplicate Grok assistant messages](017-grok-dupe.md) | Draft |
| 018 | [Markdown link resolver with cwd context](018-mdlink.md) | Accepted |
| 019 | [Stuck "Running" + phantom pending questions](019-stuck-running.md) | Accepted |
| 020 | [Apply the MCP catalog per profile](020-mcp-catalog-apply.md) | Shipped |
| 021 | [Per-session Grok credit meter](021-session-credit-meter.md) | Shipped |
| 022 | [Reset-time tooltip on profile usage chip](022-usage-reset-times.md) | Shipped |
| 023 | [In-app PDF preview + share on the session file viewer](023-file-viewer-pdf.md) | Accepted |
| 025 | [Electron desktop multi-host: WS pool, per-host fan-out, hostId end-to-end](025-desktop-multi-host.md) | Shipped |
| 027 | [Mac host installer: never install from itself, always rebuild](027-installer-self-source.md) | Shipped |
| 032 | [Projects follow the folder: ~ expansion, inference, overlap warnings](032-project-resolution.md) | Shipped |
| 033 | [Approval cards show the diff or command; Diff tab shows new files](033-approval-preview.md) | Shipped |
| 035 | [iPhone opens sessions on their own host](035-phone-cross-host-open.md) | Shipped |
| 038 | [Session list status follows live events](038-live-list-status.md) | Shipped |
| 039 | [Mac composer + project form fixes](039-mac-composer-fixes.md) | Shipped |
| 040 | [Tool rows show command output and exit code](040-tool-output.md) | Shipped |
| 041 | [Mac toolbar buttons have names](041-toolbar-labels.md) | Shipped |
| 042 | [File viewer reads only what it shows](042-file-viewer-bounded-read.md) | Shipped |
| 044 | [OpenAPI contract test](044-openapi-contract.md) | Shipped |
| 046 | [First Swift unit tests](046-swift-tests.md) | Shipped |
| 047 | [Finish the ClankerSpanker rename (in-repo parts only)](047-rename-safe-parts.md) | Shipped |
| 048 | [Read every Grok home; resume sessions where they live](048-grok-homes.md) | Shipped |
| 050 | [Browser + Electron parity with today's Swift features](050-web-electron-parity.md) | Shipped |
| 051 | [Split session-manager.ts, phase A](051-split-session-manager-a.md) | Shipped |
| 052 | [Split session-manager.ts, phase B: CLI backends become runners](052-split-session-manager-b.md) | Shipped |
| 053 | [Claude failures say why](053-claude-error-detail.md) | Shipped |
| 054 | [Claude MCP config uses `type`](054-claude-mcp-type.md) | Shipped |
| 055 | [Split Grok ACP inbound handling](055-grok-events-split.md) | Shipped |
| 056 | [Claude tool rows finish and show output](056-claude-tool-results.md) | Shipped |
