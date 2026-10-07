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

## 4. Keeping a host updated (RFC-059)

Each machine still needs one checkout (`~/Projects/GrokDispatch`, or
`repoDir` in `~/.grok-dispatch/config.json`). After this build is installed
once:

- On that machine, open `http://localhost:8787/setup` and press
  **Update from repo**. The same button is in the host’s browser UI
  (header **Update**). No ClankerSpanker app required.
- The Mac app and iPhone have the same button under Settings → Hosts,
  when those apps are installed.
- Or set `"autoUpdate": true` in that machine's `config.json`. The host
  then fast-forwards itself when no session is running.

It only fast-forwards the branch the checkout is already on. That branch
needs an upstream, and `git fetch` has to work without a password prompt
(a LaunchAgent has no terminal). Uncommitted files, a missing upstream, or
a diverged branch are left alone. If the build fails, run it again; the
log is `~/.grok-dispatch/self-update.log`.

`scripts/update-mac-host.sh` is still the way to install this the first
time on a Mac you can sit at.

## 5. Security

- Host token stays in `~/.grok-dispatch/config.json` (user-only permissions).  
- Desktop apps may store a copy for API calls; host config remains source of truth.  
- Do not expose `:8787` to the public internet.
