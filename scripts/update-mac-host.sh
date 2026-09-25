#!/usr/bin/env bash
# Update the ClankerSpanker host on a Mac from this checkout (RFC-034).
#
#   ./scripts/update-mac-host.sh                 # pull, build, deploy, restart
#   ./scripts/update-mac-host.sh --bind-auto     # also listen on loopback + Tailscale only (RFC-028)
#   ./scripts/update-mac-host.sh --rotate-token  # also mint a new host token (re-pair clients after)
#
# Works for both install styles:
#   - Mac app install:   ~/Library/Application Support/ClankerSpanker/host, com.nightmoose.clankerspanker-host
#   - Standalone install: runs host/dist from this checkout, com.nightmoose.grok-dispatch-host
#
# Use this instead of the Mac app's "Install / update host" when the app is older
# than RFC-027 — that build can delete its own install (it installed from itself).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="${GROK_DISPATCH_CONFIG:-$HOME/.grok-dispatch/config.json}"
APP_ROOT="$HOME/Library/Application Support/ClankerSpanker/host"
APP_LABEL="com.nightmoose.clankerspanker-host"
STANDALONE_LABEL="com.nightmoose.grok-dispatch-host"
BIND_AUTO=0
ROTATE=0
PULL=1

for arg in "$@"; do
  case "$arg" in
    --bind-auto) BIND_AUTO=1 ;;
    --rotate-token) ROTATE=1 ;;
    --no-pull) PULL=0 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

[[ "$(uname)" == "Darwin" ]] || { echo "macOS only (Linux: desktop/ installer or host/scripts/install-systemd-user.sh)" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found on PATH" >&2; exit 1; }

loaded() { launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1; }

if loaded "$APP_LABEL" || [[ -f "$APP_ROOT/dist/index.js" ]]; then
  MODE=app; LABEL="$APP_LABEL"
elif loaded "$STANDALONE_LABEL"; then
  MODE=standalone; LABEL="$STANDALONE_LABEL"
else
  echo "No host LaunchAgent found. Install once: host/scripts/install-service.sh" >&2
  exit 1
fi
echo "==> Install style: $MODE ($LABEL)"

if (( PULL )); then
  echo "==> git pull --ff-only"
  git -C "$ROOT" pull --ff-only
fi

echo "==> Build host"
(cd "$ROOT/host" && npm install --no-audit --no-fund && npm run build)

if [[ "$MODE" == app ]]; then
  echo "==> Deploy to $APP_ROOT"
  mkdir -p "$APP_ROOT"
  # No --delete: the install root also holds node_modules we do not rebuild here.
  rsync -a "$ROOT/host/dist" "$ROOT/host/web" "$ROOT/host/package.json" "$ROOT/host/package-lock.json" "$APP_ROOT/"
  (cd "$APP_ROOT" && npm install --omit=dev --no-audit --no-fund)
fi

if [[ -f "$CONFIG" ]] && (( BIND_AUTO || ROTATE )); then
  echo "==> Update $CONFIG"
  BACKUP="$CONFIG.bak-$(date +%Y%m%d-%H%M%S)"
  cp -p "$CONFIG" "$BACKUP"
  chmod 600 "$BACKUP"
  BIND_AUTO=$BIND_AUTO ROTATE=$ROTATE node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const c = JSON.parse(fs.readFileSync(p, "utf8"));
    if (process.env.BIND_AUTO === "1") { console.log(`    bindHost: ${c.bindHost ?? "(unset)"} -> auto`); c.bindHost = "auto"; }
    if (process.env.ROTATE === "1") { delete c.hostToken; console.log("    hostToken removed; the host mints a new one on start"); }
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, p);
    fs.chmodSync(p, 0o600);
  ' "$CONFIG"
  echo "    backup: $BACKUP"
fi

echo "==> Restart $LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
for _ in $(seq 1 30); do
  curl -sf http://127.0.0.1:8787/health >/dev/null && break
  sleep 1
done
curl -sf http://127.0.0.1:8787/health >/dev/null || { echo "Host did not come back — check ~/Library/Logs/*host*.log" >&2; exit 1; }

echo "==> Host is up"
[[ -f "$CONFIG" ]] && chmod 600 "$CONFIG"
echo "    Listening:"
lsof -nP -iTCP:8787 -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print "      " $9}' | sort -u
if (( ROTATE )); then
  echo "    Token rotated. Re-pair: Mac app → Host → Connect app to this host;"
  echo "    phone → scan the QR at http://localhost:8787/setup on this Mac."
fi
echo "    Pair a phone: open http://localhost:8787/setup on this Mac and scan the QR code."
