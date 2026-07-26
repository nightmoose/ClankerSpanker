#!/usr/bin/env bash
# Install ClankerSpanker host as a systemd --user service (Linux).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="${HOME}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME_DIR/.config}/systemd/user"
UNIT_DST="$UNIT_DIR/clankerspanker-host.service"
NODE_BIN="$(command -v node)"
DIST_INDEX="$ROOT/dist/index.js"

if [[ ! -f "$DIST_INDEX" ]]; then
  echo "Building host first…"
  (cd "$ROOT" && npm install && npm run build)
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "node not found on PATH" >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"
mkdir -p "$HOME_DIR/.local/state/clankerspanker"

cat > "$UNIT_DST" <<EOF
[Unit]
Description=ClankerSpanker host gateway (Grok Build + Claude Code)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$NODE_BIN $DIST_INDEX
Restart=on-failure
RestartSec=3
Environment=HOME=$HOME_DIR
Environment=PATH=$HOME_DIR/.grok/bin:$HOME_DIR/.local/bin:/usr/local/bin:/usr/bin:/bin
# Optional: set GROK_DISPATCH_LAN_URL=http://your-tailscale-or-lan-host:8787 for setup page links

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now clankerspanker-host.service

echo "Installed and started clankerspanker-host.service (systemd --user)"
echo "Status:  systemctl --user status clankerspanker-host"
echo "Logs:    journalctl --user -u clankerspanker-host -f"
echo "Config:  $HOME_DIR/.grok-dispatch/config.json"
echo "Browser: http://127.0.0.1:8787/app/  (or your LAN/Tailscale IP)"
