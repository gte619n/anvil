#!/usr/bin/env bash
# Assemble "Anvil Server.app" from the SwiftPM build (no Xcode needed).
#   ./make-app.sh            # release build → ./Anvil Server.app  (ad-hoc; local dev)
#   open "Anvil Server.app"
#
# Local default is an ad-hoc signature (SIGN_ID unset). For a distributable, Gatekeeper-clean,
# auto-updating build (the full-release workflow), set:
#   SIGN_ID="Developer ID Application: … (TEAMID)"   real Developer ID identity
#   APPLE_API_KEY_PATH / APPLE_API_KEY / APPLE_API_ISSUER   App Store Connect key → notarize + staple
#   SPARKLE_PUBLIC_ED_KEY                            embeds the appcast feed keys for auto-update
#   ANVIL_MARKETING_VERSION / ANVIL_BUILD_NUMBER     version shown + Sparkle update comparison
#   BUNDLE_ANVILD=../anvild                           ship the daemon source inside the app
set -euo pipefail
cd "$(dirname "$0")"

CONFIG="${1:-release}"
APP="Anvil Server.app"
BIN_NAME="AnvilServer"

# Version: MAJOR.MINOR from the repo-root VERSION file (single source of truth shared with the
# client + Android) → MAJOR.MINOR.<build>, so every CI build revs. The full-release workflow sets the
# marketing string via ANVIL_MARKETING_VERSION. CFBundleVersion (BUILD) is what Sparkle compares to
# decide "newer", so it must increase per release (the workflow run number provides that).
MAJOR_MINOR="$(tr -d '[:space:]' < "../VERSION" 2>/dev/null || true)"
BUILD="${ANVIL_BUILD_NUMBER:-0}"
VERSION="${ANVIL_MARKETING_VERSION:-${MAJOR_MINOR:-0.0}.$BUILD}"

# Sparkle appcast wiring — injected into Info.plist only when a public key is supplied (release
# builds). Local/ad-hoc builds omit the feed so Sparkle stays inert. Server has its OWN appcast
# (separate bundle id from the client), hosted alongside the client's on GitHub Pages.
SU_FEED_URL="${SPARKLE_FEED_URL:-https://gte619n.github.io/anvil/appcast-server.xml}"
SU_PUBLIC_KEY="${SPARKLE_PUBLIC_ED_KEY:-}"
SIGN_ID="${SIGN_ID:--}"

echo "building ($CONFIG)…"
swift build -c "$CONFIG"
BIN_DIR="$(swift build -c "$CONFIG" --show-bin-path)"
BIN="$BIN_DIR/$BIN_NAME"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/$BIN_NAME"

# Embed Sparkle.framework (auto-update). SwiftPM drops the macOS slice next to the binary.
SPARKLE_FW="$BIN_DIR/Sparkle.framework"
if [ -d "$SPARKLE_FW" ]; then
  echo "embedding Sparkle.framework…"
  mkdir -p "$APP/Contents/Frameworks"
  cp -R "$SPARKLE_FW" "$APP/Contents/Frameworks/Sparkle.framework"
  install_name_tool -add_rpath "@executable_path/../Frameworks" "$APP/Contents/MacOS/$BIN_NAME" 2>/dev/null || true
else
  echo "  ! Sparkle.framework not found in $BIN_DIR — auto-update unavailable in this build"
fi

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

# Sparkle keys only when a public key is present (release builds) — see SU_PUBLIC_KEY above.
SPARKLE_KEYS=""
if [ -n "$SU_PUBLIC_KEY" ]; then
  SPARKLE_KEYS="  <key>SUFeedURL</key><string>$SU_FEED_URL</string>
  <key>SUPublicEDKey</key><string>$SU_PUBLIC_KEY</string>
  <key>SUEnableAutomaticChecks</key><true/>"
fi
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Anvil Server</string>
  <key>CFBundleDisplayName</key><string>Anvil Server</string>
  <key>CFBundleIdentifier</key><string>com.anvil.server</string>
  <key>CFBundleVersion</key><string>$BUILD</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
$SPARKLE_KEYS
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

# ── codesign (inside-out: Sparkle.framework first, then the app) ───────────
# SIGN_ID="-" → ad-hoc (local default). A real "Developer ID Application: …" identity (release
# workflow) produces a notarizable build; --options runtime adds the hardened runtime, --timestamp
# a secure timestamp (Developer ID only — ad-hoc can't timestamp).
TIMESTAMP_FLAG=(); [ "$SIGN_ID" != "-" ] && TIMESTAMP_FLAG=(--timestamp)
if [ -d "$APP/Contents/Frameworks/Sparkle.framework" ]; then
  echo "codesigning Sparkle.framework…"
  codesign --force --deep --sign "$SIGN_ID" --options runtime ${TIMESTAMP_FLAG[@]+"${TIMESTAMP_FLAG[@]}"} \
    "$APP/Contents/Frameworks/Sparkle.framework"
fi
echo "codesigning ($([ "$SIGN_ID" = "-" ] && echo ad-hoc || echo "$SIGN_ID"))…"
codesign --force --sign "$SIGN_ID" --options runtime ${TIMESTAMP_FLAG[@]+"${TIMESTAMP_FLAG[@]}"} "$APP"
codesign --verify --deep --strict "$APP" && echo "  ✓ signature verifies"

# ── notarize + staple (real Developer ID builds only) ──────────────────────
if [ "$SIGN_ID" != "-" ] && [ -n "${APPLE_API_KEY_PATH:-}" ]; then
  echo "notarizing…"
  ditto -c -k --keepParent "$APP" "$APP.zip"
  xcrun notarytool submit "$APP.zip" \
    --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" \
    --wait
  xcrun stapler staple "$APP"
  rm -f "$APP.zip"
  echo "  ✓ notarized & stapled"
fi

echo "built: $PWD/$APP  (v$VERSION build $BUILD)"
echo "run:   open \"$APP\"   (first run: set the anvild checkout via ANVILD_DIR or Settings)"
