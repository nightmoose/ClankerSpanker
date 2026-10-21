# RFC index

Design notes for non-trivial changes. **Shipped** = on `main`; **Accepted** = signed off;
**Draft** = under review; **Superseded** = the number is kept and the work lives in another RFC.

066 stays Accepted because its Linux desktop soak is still open. 006 and 017 stay Draft.

Start a new RFC with `make rfc SLUG=short-kebab` (template: [`_template.md`](_template.md)) and add a row below.
That command fetches `origin`, takes the next integer above every number already used in this
checkout, on any branch, in any branch name, in this index, or in an "RFC-NNN will…" promise,
and **refuses** to write the file if that number is taken. It does not fill gaps.

## Renumbering

One number, one RFC. Where a number was used twice, the later work moved. Where a merged
change had no file, the file was restored on 2026-10-21 and the number stayed.

| Was | What it referred to | Is now | Why |
|---|---|---|---|
| 058, inline shell | Inline shell execution (`nightly-maintenance-2026-10-02-rfc058-inline-exec`) | [060](060-inline-exec.md) | 058 is the hosted product site, which merged first |
| 058, project SQL | Per-project SQL (`nightly-maintenance-2026-10-13-rfc058-project-sql`). That branch also claimed 059 | [061](061-project-sql.md) | 059 stayed host self-update. SQL moved to 061 |
| 059, host update | Host self-update | [059](059-host-self-update.md) | Unchanged. The SQL branch's claim was dropped |
| 062, sql tool | A follow-on that would have carried `sql_execute` alone | [061](061-project-sql.md) | Absorbed. [062](062-absorbed-by-project-sql.md) holds the number |

Restored in place, not renumbered: 000, 011, 016, 024, 026, 028, 029, 030, 031, 034, 036, 037, 043, 045, 049, 057.
Each of those already had one meaning in a merged commit and in the code. The design note was missing.
034's script was missing when the note was restored and is in the tree now.

| RFC | Title | Status |
|---|---|---|
| 000 | [House style for the gateway repo](000-house-style.md) | Shipped |
| 001 | [Markdown tables + todo jump to source](001-md-tables-todo-jump.md) | Shipped |
| 002 | [Transcript chat-only, session Files, extra folders](002-session-chat-files-folders.md) | Shipped |
| 003 | [Create and run bots from the iPhone app](003-phone-bots.md) | Shipped |
| 004 | [Host terminal from the phone](004-host-terminal.md) | Shipped |
| 005 | [Attach Antigravity / Gemini CLI conversations](005-attach-agy.md) | Shipped |
| 006 | [Backend parity pass (Grok / Claude / Antigravity / Bot)](006-backend-parity.md) | Draft |
| 007 | [Phone copy/paste: Term paste + session message selection](007-ios-term-copy-paste.md) | Shipped |
| 008 | [Per-profile MCP servers (payer isolation)](008-profile-mcp.md) | Shipped |
| 009 | [Remote MCP OAuth (PKCE)](009-mcp-oauth.md) | Shipped |
| 010 | [iOS app icon badge](010-ios-app-icon-badge.md) | Shipped |
| 011 | [Push to a phone that is not running](011-apns.md) | Shipped |
| 012 | [Stop NightMoose login modal on MCP AuthRequired](012-login-modal-mcp-false-positive.md) | Shipped |
| 013 | [Profile MCP catalog](013-profile-mcp-catalog.md) | Shipped |
| 014 | [Close as done sticks; hide Grok helper sessions](014-close-done-hide-helpers.md) | Shipped |
| 015 | [Detach the Mac app from the host process](015-host-detach.md) | Shipped |
| 016 | [Menu-bar host tray](016-mac-host-tray.md) | Shipped |
| 017 | [Duplicate Grok assistant messages](017-grok-dupe.md) | Draft |
| 018 | [Markdown link resolver with cwd context](018-mdlink.md) | Shipped |
| 019 | [Stuck "Running" + phantom pending questions](019-stuck-running.md) | Shipped |
| 020 | [Apply the MCP catalog per profile](020-mcp-catalog-apply.md) | Shipped |
| 021 | [Per-session Grok credit meter](021-session-credit-meter.md) | Shipped |
| 022 | [Reset-time tooltip on profile usage chip](022-usage-reset-times.md) | Shipped |
| 023 | [In-app PDF preview + share on the session file viewer](023-file-viewer-pdf.md) | Shipped |
| 024 | [One phone, more than one host](024-ios-multi-host.md) | Shipped |
| 025 | [Electron desktop multi-host: WS pool, per-host fan-out, hostId end-to-end](025-desktop-multi-host.md) | Shipped |
| 026 | [The host token stays on the host machine](026-host-token-local-only.md) | Shipped |
| 027 | [Mac host installer: never install from itself, always rebuild](027-installer-self-source.md) | Shipped |
| 028 | [Listen on loopback and Tailscale](028-loopback-tailscale-bind.md) | Shipped |
| 029 | [WebSocket tickets](029-websocket-tickets.md) | Shipped |
| 030 | [Say when Gemini auto-approves](030-gemini-auto-approve.md) | Shipped |
| 031 | [Keep push payloads under the APNs limit](031-apns-payload-size.md) | Shipped |
| 032 | [Projects follow the folder: ~ expansion, inference, overlap warnings](032-project-resolution.md) | Shipped |
| 033 | [Approval cards show the diff or command; Diff tab shows new files](033-approval-preview.md) | Shipped |
| 034 | [One command to update a Mac host](034-update-mac-host.md) | Shipped |
| 035 | [iPhone opens sessions on their own host](035-phone-cross-host-open.md) | Shipped |
| 036 | [A host with no projects can import from disk](036-import-from-disk.md) | Shipped |
| 037 | [Discover roots, including GitHub Desktop clones](037-discover-roots.md) | Shipped |
| 038 | [Session list status follows live events](038-live-list-status.md) | Shipped |
| 039 | [Mac composer + project form fixes](039-mac-composer-fixes.md) | Shipped |
| 040 | [Tool rows show command output and exit code](040-tool-output.md) | Shipped |
| 041 | [Mac toolbar buttons have names](041-toolbar-labels.md) | Shipped |
| 042 | [File viewer reads only what it shows](042-file-viewer-bounded-read.md) | Shipped |
| 043 | [Onboarding does not embed a LAN address](043-remove-lan-ip.md) | Shipped |
| 044 | [OpenAPI contract test](044-openapi-contract.md) | Shipped |
| 045 | [Host dev-dependency advisories](045-dev-deps-audit.md) | Shipped |
| 046 | [First Swift unit tests](046-swift-tests.md) | Shipped |
| 047 | [Finish the ClankerSpanker rename (in-repo parts only)](047-rename-safe-parts.md) | Shipped |
| 048 | [Read every Grok home; resume sessions where they live](048-grok-homes.md) | Shipped |
| 049 | [The on-host page recovers a rotated token](049-web-token-recovery.md) | Shipped |
| 050 | [Browser + Electron parity with today's Swift features](050-web-electron-parity.md) | Shipped |
| 051 | [Split session-manager.ts, phase A](051-split-session-manager-a.md) | Shipped |
| 052 | [Split session-manager.ts, phase B: CLI backends become runners](052-split-session-manager-b.md) | Shipped |
| 053 | [Claude failures say why](053-claude-error-detail.md) | Shipped |
| 054 | [Claude MCP config uses `type`](054-claude-mcp-type.md) | Shipped |
| 055 | [Split Grok ACP inbound handling](055-grok-events-split.md) | Shipped |
| 056 | [Claude tool rows finish and show output](056-claude-tool-results.md) | Shipped |
| 057 | [Log what a remote client actually did](057-remote-request-log.md) | Shipped |
| 058 | [Host the product at clankerspanker.tech](058-hosted-product-site.md) | Accepted |
| 059 | [Host updates itself from the git checkout](059-host-self-update.md) | Shipped |
| 060 | [Inline shell execution from chat code blocks](060-inline-exec.md) | Shipped |
| 061 | [Project database binding, sealed-input secrets, `sql_execute` (absorbs 062)](061-project-sql.md) | Shipped |
| 062 | [Absorbed by RFC-061](062-absorbed-by-project-sql.md) | Superseded |
| 063 | [Mac host installer stages, then swaps](063-installer-staged-swap.md) | Shipped |
| 064 | [Mac Host panel: no subprocess on the main thread; recover an interrupted LaunchAgent load](064-mac-host-panel-async-status.md) | Shipped |
| 065 | [The hosted site gets no shell and no profile secrets](065-browser-origin-hardening.md) | Shipped |
| 066 | [Linux desktop on Electron 44](066-electron-44.md) | Accepted |
| 067 | [The hosted site explains itself and has a read-only demo](067-hosted-demo-explainer.md) | Shipped |
| 068 | [The gateway keeps its own log files bounded](068-gateway-log-rotation.md) | Shipped |
| 069 | [Cheap session-list: slim shape, ETag, paging](069-sessions-list-summary.md) | Shipped |
| 070 | [Opt-in per-job sandbox](070-per-job-sandbox.md) | Shipped |
| 071 | [Phone approval inside a per-job sandbox](071-sandbox-approval-channel.md) | Shipped |
