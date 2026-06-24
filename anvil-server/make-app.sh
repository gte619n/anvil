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

# App icon: render a 1024px master, fan out to an .iconset via sips, compile with iconutil.
echo "generating app icon…"
ICON_TMP="$(mktemp -d)"
if swift tools/gen-icon.swift "$ICON_TMP/icon.png" >/dev/null 2>&1; then
  ISET="$ICON_TMP/AppIcon.iconset"; mkdir -p "$ISET"
  for sz in 16 32 128 256 512; do
    sips -z $sz $sz "$ICON_TMP/icon.png" --out "$ISET/icon_${sz}x${sz}.png" >/dev/null 2>&1
    sips -z $((sz*2)) $((sz*2)) "$ICON_TMP/icon.png" --out "$ISET/icon_${sz}x${sz}@2x.png" >/dev/null 2>&1
  done
  iconutil -c icns "$ISET" -o "$APP/Contents/Resources/AppIcon.icns" 2>/dev/null && echo "  → AppIcon.icns"
fi
rm -rf "$ICON_TMP"

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
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <!-- Menu-bar agent: no Dock icon, no main window. -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# Bundle the daemon SOURCE into Resources/anvild (no node_modules — the app's Provision step fetches
# those with `bun install --frozen-lockfile` on first run, version-locked by the shipped bun.lock —
# anvil-server-app.md §3.1). Keeps the shipped app ~18 MB instead of ~520 MB. web/dist is shipped
# prebuilt. Opt in with BUNDLE_ANVILD=../anvild; in dev the app finds a checkout via the picker.
if [ -n "${BUNDLE_ANVILD:-}" ] && [ -d "$BUNDLE_ANVILD" ]; then
  echo "bundling anvild source from $BUNDLE_ANVILD (excluding node_modules)…"
  # -L (copy-links) MATERIALIZES symlinks into real files. anvild/protocol.ts is a symlink to
  # ../docs/plans/anvil-protocol.ts — OUTSIDE the bundled tree — so a plain copy ships a DANGLING
  # link, and both `build:web` and the daemon's `@protocol` import then fail in the install root.
  # Dereferencing makes the bundle self-contained. (protocol.ts is the only out-of-tree symlink.)
  rsync -aL --exclude node_modules --exclude .git "$BUNDLE_ANVILD/" "$APP/Contents/Resources/anvild/"
fi

echo "ad-hoc signing…"
codesign --force --deep --sign - "$APP"
echo "built: $PWD/$APP"
echo "run:   open \"$APP\"   (first run: set the anvild checkout via ANVILD_DIR or Settings)"
