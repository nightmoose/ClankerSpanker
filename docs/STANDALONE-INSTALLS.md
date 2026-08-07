# Standalone installs — host gateway and agents

Goal: **same story on every OS** — install the gateway and the agent CLIs without depending on a random git checkout.

## 1. Host gateway (ClankerSpanker host)

| | |
|--|--|
| **What** | Node process on port **8787** that runs Grok/Claude and serves REST/WS + `/app/` |
| **Config** | `~/.grok-dispatch/config.json` (all OSes) |
| **Dev** | `cd host && npm i && npm run build && npm start` |

### Managed by desktop apps (preferred for laptops)

| App | Install location | User service |
|-----|------------------|--------------|
| **Mac native** | `~/Library/Application Support/ClankerSpanker/host` | LaunchAgent `com.nightmoose.clankerspanker-host` |
| **Linux Electron** | `~/.local/share/clankerspanker/host` | systemd user `clankerspanker-host.service` |

In both UIs: **Host → Install / update host** (copies built package out of the monorepo, `npm install --omit=dev`, enables the user service).

### Standalone (no desktop UI)

| OS | Command |
|----|---------|
| macOS / Linux | From a built `host/` tree: `./scripts/install-service.sh` |
| Linux only | `./scripts/install-systemd-user.sh` |
| macOS only | `./scripts/install-launchd.sh` |
| Any | `npm start` in foreground |

Uninstall service: disable the LaunchAgent / `systemctl --user disable --now clankerspanker-host`, remove the unit/plist. Optional: delete the install directory above.

---

## 2. Agent CLIs (standalone, all OSes)

These are **not** the host. The host shells out to them. Install once per machine (or per user).

### Grok Build CLI

| | |
|--|--|
| **Binary** | `grok` (or `GROK_BINARY`) |
| **Typical paths** | `~/.grok/bin/grok`, `~/.local/bin/grok`, Homebrew |
| **Auth** | `grok login` (or whatever the current Grok CLI documents) |

Install follows **xAI / Grok Build** current docs (CLI tarball or package). Pin the method you use in your own runbook; do not hardcode site-specific URLs in product code.

Host discovery already probes:

- `$GROK_BINARY`
- `~/.grok/bin/grok`
- `~/.local/bin/grok`
- `/opt/homebrew/bin/grok`, `/usr/local/bin/grok` (macOS)
- `/usr/local/bin/grok`, `/usr/bin/grok` (Linux)

### Claude Code CLI

| | |
|--|--|
| **Binary** | `claude` (or `CLAUDE_BINARY`) |
| **Typical paths** | `~/.local/bin/claude`, `~/.claude/bin/claude`, Homebrew |
| **Auth** | Claude CLI login / `ANTHROPIC_API_KEY` / profile `env` in host config |

Install follows **Anthropic Claude Code** current docs.

Host discovery probes:

- `$CLAUDE_BINARY`
- `~/.local/bin/claude`, `~/.claude/bin/claude`
- Homebrew / `/usr/local` / `/usr/bin` as above

### Multi-account Claude on one host

Use host config `profiles[]` with per-profile `env.ANTHROPIC_API_KEY` and/or `claudeConfigDir` — not separate host processes.

---

## 3. Product intent (checklist)

| Piece | Standalone install | Managed by Mac app | Managed by Linux Electron |
|-------|--------------------|--------------------|---------------------------|
| Host gateway | Yes (scripts) | Yes | Yes |
| Grok CLI | Yes (vendor) | Detect only | Detect only |
| Claude CLI | Yes (vendor) | Detect only | Detect only |
| Browser UI | Bundled with host `/app/` | Opens host URL | Opens host URL |

Future work (not required for host install parity):

- One-click “install Grok CLI” / “install Claude CLI” buttons that shell out to official installers  
- Signed AppImage/deb/pkg that **bundle** a host snapshot (still writes config under `~/.grok-dispatch`)

---

## 4. Security

- Host token stays in `~/.grok-dispatch/config.json` (user-only permissions).  
- Desktop apps may store a copy for API calls; host config remains source of truth.  
- Do not expose `:8787` to the public internet.
