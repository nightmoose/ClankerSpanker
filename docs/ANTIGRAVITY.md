# Antigravity CLI profiles

ClankerSpanker can dispatch tasks to **Google Antigravity CLI** (`agy`) the same way it does Claude Code: headless turns with streaming transcript, multi-turn via conversation resume, and a colored profile chip on clients.

## Prerequisites on the host machine

```bash
# Install
curl -fsSL https://antigravity.google/cli/install.sh | bash

# Authenticate once (interactive — stores credentials in the OS keyring)
agy
# or just open the TUI once and sign in
```

Confirm headless works:

```bash
agy -p "Say hello in one sentence" --output-format json
```

Docs: [Installation](https://antigravity.google/docs/cli/install) · [Headless mode](https://antigravity.google/docs/cli/headless)

## Host config

Add a profile to `~/.grok-dispatch/config.json`:

```json
{
  "profiles": [
    {
      "id": "nightmoose",
      "name": "NightMoose",
      "backend": "grok",
      "color": "#73B8FF",
      "model": "grok-build"
    },
    {
      "id": "agy",
      "name": "Antigravity",
      "backend": "antigravity",
      "color": "#34A853",
      "model": "antigravity"
    }
  ]
}
```

Aliases accepted for `backend`: `antigravity`, `agy`, `gemini` (all normalize to `antigravity`).

### Optional model pin

```json
"model": "gemini-3.5-flash-medium"
```

List slugs on the host with `agy models`. The host passes `--model` unless the value is the generic `antigravity` / `agy` / `gemini`.

### Optional API key (instead of keyring login)

```json
"env": {
  "GEMINI_API_KEY": "…"
}
```

Also accepted: `GOOGLE_API_KEY`, `GOOGLE_GENAI_API_KEY`.

### Permissions

Headless `agy` **soft-denies** shell commands by default (workspace file reads/writes are auto-allowed). Dispatch defaults to **`--dangerously-skip-permissions`** so agent tasks can run tools — same practical outcome as Claude `acceptEdits`.

To force policy-only mode (safer, more soft-denies):

```json
"env": {
  "ANTIGRAVITY_REQUIRE_PERMISSIONS": "1"
}
```

Or pre-allow tools in `~/.gemini/antigravity-cli/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "command(git)",
      "command(npm)",
      "write_file(src/)"
    ]
  }
}
```

## After editing config

Restart the host so it reloads profiles:

```bash
# launchd (Mac)
launchctl kickstart -k "gui/$(id -u)/com.nightmoose.clankerspanker-host"

# or foreground
cd host && npm start
```

Refresh the Mac/phone client — you should see an **Antigravity** chip.

## How it works

| Piece | Behavior |
|--------|----------|
| Spawn | `agy -p <prompt> --output-format stream-json --print-timeout 30m` |
| Resume | `--conversation <conversation_id>` from the previous turn |
| Streaming | NDJSON `step_update` / `result` events → transcript + tool rows |
| Cancel | SIGTERM on the child process |
| Transfer | Fresh conversation + transcript handoff (like Claude account switch) |

No ACP stdio mode yet (Antigravity does not expose it). Phone PreToolUse hooks are Claude-only; Antigravity uses CLI permission policy instead.

## Binary discovery

Search order: `AGY_BINARY` / `ANTIGRAVITY_BINARY` env → `~/.local/bin/agy` → Homebrew → `agy` on `PATH`.
