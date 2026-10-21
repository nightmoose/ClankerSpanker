#!/usr/bin/env bash
# Build + launch the *native* Mac app (never the iPhone "Designed for iPad" wrapper).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Kill the wrong app if Xcode left Designed-for-iPad running
pkill -9 -f 'Wrapper/ClankerSpanker' 2>/dev/null || true
pkill -9 -f 'ClankerSpankerPhone' 2>/dev/null || true

if command -v xcodegen >/dev/null 2>&1; then
  xcodegen generate
fi

DD="${TMPDIR:-/tmp}/ClankerSpankerMac-build"
echo "Building Mac app (scheme ClankerSpanker → target ClankerSpankerMac)…"
echo "derivedData: $DD"
xcodebuild \
  -project ClankerSpanker.xcodeproj \
  -scheme ClankerSpanker \
  -destination 'platform=macOS' \
  -configuration Debug \
  -derivedDataPath "$DD" \
  build \
  -quiet

# The project sets CONFIGURATION_BUILD_DIR (today ~/Applications), so ask
# Xcode where the app went instead of assuming the derived-data folder.
PRODUCTS="$(xcodebuild -project ClankerSpanker.xcodeproj -scheme ClankerSpanker \
  -destination 'platform=macOS' -configuration Debug -derivedDataPath "$DD" \
  -showBuildSettings 2>/dev/null | awk -F' = ' '/^ *BUILT_PRODUCTS_DIR = /{print $2; exit}')"
APP="${PRODUCTS:-$DD/Build/Products/Debug}/ClankerSpankerMac.app"
if [[ ! -x "$APP/Contents/MacOS/ClankerSpankerMac" ]]; then
  echo "Build succeeded but executable missing at $APP" >&2
  exit 1
fi

echo "Launching: $APP"
open "$APP"
echo "Mac command center: sidebar sessions + toolbar. Not phone tabs."
