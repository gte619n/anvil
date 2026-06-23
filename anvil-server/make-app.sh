#!/usr/bin/env bash
# Assemble "Anvil Server.app" from the SwiftPM build (no Xcode needed) and ad-hoc sign it.
#   ./make-app.sh            # release build → ./Anvil Server.app
#   open "Anvil Server.app"
#
# This produces a LOCAL-DEV bundle (ad-hoc signature). A distributable, Gatekeeper-clean app needs a
# Developer ID + notarization (anvil-server-app.md §8) — out of scope here.
set -euo pipefail
cd "$(dirname "$0")"

CONFIG="${1:-release}"
APP="Anvil Server.app"
BIN_NAME="AnvilServer"

echo "building ($CONFIG)…"
swift build -c "$CONFIG"
BIN="$(swift build -c "$CONFIG" --show-bin-path)/$BIN_NAME"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/$BIN_NAME"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Anvil Server</string>
  <key>CFBundleDisplayName</key><string>Anvil Server</string>
  <key>CFBundleIdentifier</key><string>com.anvil.server</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>$BIN_NAME</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <!-- Menu-bar agent: no Dock icon, no main window. -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# Bundle the daemon checkout into Resources/anvild so the app is self-contained (anvil-server-app.md
# §3.1: Bun + source + node_modules). Opt in with BUNDLE_ANVILD=../anvild (skipped by default — the
# 200MB+ node_modules makes for a slow copy; in dev the app finds the checkout via ANVILD_DIR).
if [ -n "${BUNDLE_ANVILD:-}" ] && [ -d "$BUNDLE_ANVILD" ]; then
  echo "bundling anvild from $BUNDLE_ANVILD…"
  rsync -a --exclude .git "$BUNDLE_ANVILD/" "$APP/Contents/Resources/anvild/"
fi

echo "ad-hoc signing…"
codesign --force --deep --sign - "$APP"
echo "built: $PWD/$APP"
echo "run:   open \"$APP\"   (first run: set the anvild checkout via ANVILD_DIR or Settings)"
