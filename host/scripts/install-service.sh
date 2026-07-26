#!/usr/bin/env bash
# Install ClankerSpanker host as a user service on the current OS.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OS="$(uname -s 2>/dev/null || echo unknown)"

case "$OS" in
  Darwin)
    exec bash "$ROOT/scripts/install-launchd.sh"
    ;;
  Linux)
    exec bash "$ROOT/scripts/install-systemd-user.sh"
    ;;
  *)
    echo "No installable service unit for OS='$OS'."
    echo "Run the host manually:"
    echo "  cd \"$ROOT\" && npm install && npm run build && npm start"
    exit 1
    ;;
esac
