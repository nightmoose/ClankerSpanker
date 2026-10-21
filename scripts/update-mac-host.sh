#!/usr/bin/env bash
# One-command update for a checkout you can sit at (RFC-034).
#
# Fast-forwards only a branch that tracks origin/main (RFC-059), builds the
# host, optionally switches the bind to loopback + Tailscale and drops the
# saved token, then restart the user service.
#
#   ./scripts/update-mac-host.sh
#   ./scripts/update-mac-host.sh --bind-auto --rotate-token
#
# --plan prints the steps and does not fetch, build, or restart.
# Tests may set UPDATE_MAC_HOST_ROOT and GROK_DISPATCH_CONFIG.
set -euo pipefail

ROOT="${UPDATE_MAC_HOST_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CONFIG="${GROK_DISPATCH_CONFIG:-${HOME}/.grok-dispatch/config.json}"
PLAN=0
CONFIG_ONLY=0
BIND_AUTO=0
ROTATE=0

usage() {
  echo "usage: scripts/update-mac-host.sh [--bind-auto] [--rotate-token] [--plan]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bind-auto) BIND_AUTO=1 ;;
    --rotate-token) ROTATE=1 ;;
    --plan) PLAN=1 ;;
    --config-only) CONFIG_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

apply_config() {
  if [[ "$BIND_AUTO" != 1 && "$ROTATE" != 1 ]]; then
    return 0
  fi
  python3 - "$CONFIG" "$BIND_AUTO" "$ROTATE" << 'PY'
import json, os, sys
path, bind, rotate = sys.argv[1], sys.argv[2] == "1", sys.argv[3] == "1"
parent = os.path.dirname(path)
if parent:
    os.makedirs(parent, exist_ok=True)
cfg = {}
if os.path.exists(path):
    with open(path, encoding="utf-8") as fh:
        cfg = json.load(fh)
    if not isinstance(cfg, dict):
        raise SystemExit(f"{path} is not a JSON object")
if bind:
    cfg["bindHost"] = "auto"
if rotate:
    cfg.pop("hostToken", None)
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    json.dump(cfg, fh, indent=2)
    fh.write("\n")
os.chmod(path, 0o600)
PY
}

if [[ "$CONFIG_ONLY" == 1 ]]; then
  apply_config
  exit 0
fi

cd "$ROOT"
branch="$(git rev-parse --abbrev-ref HEAD)"
if ! upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null)"; then
  echo "Branch ${branch} has no upstream. Hosts only update from origin/main." >&2
  exit 1
fi
if [[ "$upstream" != "origin/main" ]]; then
  echo "Branch ${branch} tracks ${upstream}, not origin/main. Hosts only update from origin/main. Nothing was changed." >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Checkout has uncommitted work. Commit or stash it before updating. Nothing was changed." >&2
  exit 1
fi

if [[ "$PLAN" == 1 ]]; then
  echo "fast-forward origin/main"
  echo "build host"
  if [[ "$BIND_AUTO" == 1 ]]; then echo "bindHost auto"; fi
  if [[ "$ROTATE" == 1 ]]; then echo "rotate token"; fi
  echo "restart service"
  exit 0
fi

git fetch --prune origin
git pull --ff-only
(cd "$ROOT/host" && npm ci && npm run build)
apply_config

uid="$(id -u)"
restarted=0
if command -v launchctl >/dev/null 2>&1; then
  if launchctl print "gui/${uid}/com.nightmoose.clankerspanker-host" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/${uid}/com.nightmoose.clankerspanker-host"
    restarted=1
  elif launchctl print "gui/${uid}/com.nightmoose.grok-dispatch-host" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/${uid}/com.nightmoose.grok-dispatch-host"
    restarted=1
  fi
fi
if [[ "$restarted" == 0 ]] && command -v systemctl >/dev/null 2>&1; then
  if systemctl --user is-active --quiet clankerspanker-host.service; then
    systemctl --user restart clankerspanker-host.service
    restarted=1
  fi
fi
if [[ "$restarted" == 0 ]]; then
  bash "$ROOT/host/scripts/install-service.sh"
fi

echo "Updated from origin/main."
if [[ "$ROTATE" == 1 ]]; then
  echo "Token cleared. Start once if the service was not already loaded, then re-pair clients from /setup."
fi
