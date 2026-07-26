#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="${HOME}"
USER_NAME="$(whoami)"
PLIST_SRC="$ROOT/scripts/com.nightmoose.grok-dispatch-host.plist"
PLIST_DST="$HOME_DIR/Library/LaunchAgents/com.nightmoose.grok-dispatch-host.plist"
NODE_BIN="$(command -v node)"
DIST_INDEX="$ROOT/dist/index.js"

if [[ ! -f "$DIST_INDEX" ]]; then
  echo "Building host first…"
  (cd "$ROOT" && npm install && npm run build)
fi

mkdir -p "$HOME_DIR/Library/LaunchAgents"
mkdir -p "$HOME_DIR/Library/Logs"

sed \
  -e "s|HOST_DIST_INDEX|$DIST_INDEX|g" \
  -e "s|HOST_DIR|$ROOT|g" \
  -e "s|HOME_DIR|$HOME_DIR|g" \
  -e "s|USER|$USER_NAME|g" \
  -e "s|/opt/homebrew/bin/node|$NODE_BIN|g" \
  "$PLIST_SRC" > "$PLIST_DST"

launchctl bootout "gui/$(id -u)/com.nightmoose.grok-dispatch-host" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl enable "gui/$(id -u)/com.nightmoose.grok-dispatch-host"
launchctl kickstart -k "gui/$(id -u)/com.nightmoose.grok-dispatch-host"

echo "Installed and started com.nightmoose.grok-dispatch-host (macOS launchd)"
echo "Logs: $HOME_DIR/Library/Logs/grok-dispatch-host.log"
echo "Config/token: $HOME_DIR/.grok-dispatch/config.json"
echo "Browser UI: http://127.0.0.1:8787/app/"
echo "Setup page: http://127.0.0.1:8787/setup"
echo "(Prefer ./scripts/install-service.sh — auto-picks launchd vs systemd.)"
