# Claude multi-account profiles on one host

ClankerSpanker does **not** install two `claude` binaries. One CLI binary; isolation is via **config directories** (`CLAUDE_CONFIG_DIR`).

## What we found on this Mac (2026-08-07)

| Identity | Email (from OAuth cache) | Where it lives |
|----------|--------------------------|----------------|
| **Personal** | `alex_suarez@hotmail.com` (claude_pro) | Default: `~/.claude/` + `~/.claude.json` |
| **FullScore** | `alex@fullscoredata.com` (claude_max) | CLI isolation dir: **`~/.claude-work/`** (contains `.claude.json`, projects, …) |
| FullScore **Desktop** app data | (Electron) | `~/.claude-instances/fullscore/` — **not** used by CLI headless; desktop-only |

`Astro` was only a second **profile slot** with the same empty keys as FullScore — both fell through to the **personal** ambient login. Removed from this machine’s host config.

## Host config shape

In `~/.grok-dispatch/config.json`:

```json
"profiles": [
  { "id": "nightmoose", "name": "NightMoose", "backend": "grok", "color": "#73B8FF", "model": "grok-build" },
  { "id": "personal", "name": "Personal", "backend": "claude", "color": "#A78BFA", "model": "claude", "env": {} },
  {
    "id": "fullscore",
    "name": "FullScore",
    "backend": "claude",
    "color": "#F97316",
    "model": "claude",
    "claudeConfigDir": "/Users/YOU/.claude-work",
    "env": {}
  }
]
```

The host sets `CLAUDE_CONFIG_DIR` from `claudeConfigDir` when spawning Claude (see `profileProcessEnv` in `host/src/profiles.ts`).

## After editing profiles

Restart the host process (or LaunchAgent/systemd) so it reloads config:

```bash
# if foreground
# Ctrl-C and npm start

# if launchd (Mac)
launchctl kickstart -k "gui/$(id -u)/com.nightmoose.clankerspanker-host"
# or stop/start from the Mac Host panel
```

Then refresh the Mac/Electron client — chips should show **NightMoose · Personal · FullScore**.

## Verify isolation (optional)

```bash
# Personal (default home)
claude -p "Who am I authenticated as?" --print

# FullScore
CLAUDE_CONFIG_DIR=~/.claude-work claude -p "Who am I authenticated as?" --print
```

## Adding Astro on another machine later

On that Mac/Linux box, create a dedicated config dir (or copy a logged-in one), then add a profile with its own `claudeConfigDir`. Do **not** re-add empty Astro on this machine until that dir exists.

## Keychain note

Claude Code may also store credentials in the macOS keychain (`Claude Code-credentials`). `CLAUDE_CONFIG_DIR` isolation is still the supported multi-account path for the CLI; if a profile mis-fires, check you are not accidentally unsetting the env.
