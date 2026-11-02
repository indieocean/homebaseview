#!/usr/bin/env bash
# Builds HomeBaseView.app: the Swift menu bar shell + this Node server + a copy of Node.
# Usage: bash macos/build-app.sh [--install]   (--install copies it to /Applications)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
APP="$ROOT/macos/build/HomeBaseView.app"

echo "==> Installing server dependencies"
npm install --omit=dev --no-audit --no-fund --silent

echo "==> Compiling the menu bar app"
swift build -c release --package-path macos

echo "==> Assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"
cp "macos/.build/release/HomeBaseView" "$APP/Contents/MacOS/HomeBaseView"
cp macos/Info.plist "$APP/Contents/Info.plist"
[ -f macos/AppIcon.icns ] && cp macos/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

NODE_BIN="$(node -p 'process.execPath')"
cp "$NODE_BIN" "$APP/Contents/Resources/node"
rsync -a --delete \
  --exclude '.DS_Store' --exclude '*.md' --exclude '*.map' --exclude '*.ts' \
  server web package.json package-lock.json node_modules "$APP/Contents/Resources/app/"

echo "==> Signing (ad-hoc, for this Mac only)"
codesign --force --sign - "$APP/Contents/Resources/app/node_modules/ffmpeg-for-homebridge/ffmpeg"
codesign --force --sign - "$APP"

if [ "${1:-}" = "--install" ]; then
  echo "==> Installing to /Applications"
  pkill -x HomeBaseView 2>/dev/null && sleep 1 || true
  rm -rf /Applications/HomeBaseView.app
  ditto "$APP" /Applications/HomeBaseView.app
  echo "Done. Launch it with: open /Applications/HomeBaseView.app"
else
  echo "Done. Launch it with: open \"$APP\"  (or rerun with --install)"
fi
