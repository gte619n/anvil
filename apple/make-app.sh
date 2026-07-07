#!/usr/bin/env bash
#
# Assemble a distributable, ad-hoc-signed Anvil.app from the SwiftPM build product —
# NO Xcode.app required, only the Command Line Tools (swift, iconutil, codesign).
#
# Steps:
#   1. (re)bundle the web client into Sources/Anvil/web  (unless --skip-web)
#   2. swift build -c release
#   3. lay out Anvil.app/Contents/{MacOS,Resources} + Info.plist
#   4. compile the .appiconset → AppIcon.icns via iconutil
#   5. drop the SPM resource bundle where Bundle.module looks for it
#   6. ad-hoc codesign with the app's entitlements
#
# Output: apple/dist/Anvil.app
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # apple/
ROOT="$(cd "$HERE/.." && pwd)"                          # repo root
APP_NAME="Anvil"
BUNDLE_ID="com.gte619n.anvil"
CONFIG="release"
SKIP_WEB=0

for arg in "$@"; do
  case "$arg" in
    --skip-web) SKIP_WEB=1 ;;
    --debug)    CONFIG="debug" ;;
    *) echo "unknown arg: $arg (supported: --skip-web, --debug)" >&2; exit 2 ;;
  esac
done

# Version: MAJOR.MINOR comes from the repo-root VERSION file (single source of truth shared by
# Android, iOS, and the server). The full marketing version is MAJOR.MINOR.<build> so every CI
# build revs automatically; CFBundleVersion is the same <build>. A release-* tag overrides the whole
# marketing string via ANVIL_MARKETING_VERSION so the bundled version matches the appcast entry.
MAJOR_MINOR="$(tr -d '[:space:]' < "$ROOT/VERSION" 2>/dev/null || true)"
BUILD="${ANVIL_BUILD_NUMBER:-0}"
VERSION="${ANVIL_MARKETING_VERSION:-${MAJOR_MINOR:-0.0}.$BUILD}"

# Sparkle appcast wiring. Injected into Info.plist only when a public key is supplied (release
# builds set SPARKLE_PUBLIC_ED_KEY); local/ad-hoc builds omit the feed entirely so Sparkle stays
# inert and never nags from a dev build. The feed lives on the repo's GitHub Pages site.
SU_FEED_URL="${SPARKLE_FEED_URL:-https://gte619n.github.io/anvil/appcast.xml}"
SU_PUBLIC_KEY="${SPARKLE_PUBLIC_ED_KEY:-}"

# ── 1. bundle the web client ───────────────────────────────────────────────
if [[ "$SKIP_WEB" == "0" ]]; then
  echo "▸ bundling web client…"
  ( cd "$ROOT/anvild" && bun run build:web )
  ( cd "$ROOT/anvild" && bun run web/bundle-native.ts "$HERE/Sources/Anvil/web" )
else
  echo "▸ skipping web bundle (--skip-web); expecting Sources/Anvil/web to exist"
  [[ -f "$HERE/Sources/Anvil/web/index.html" ]] || { echo "  ✗ Sources/Anvil/web/index.html missing — run without --skip-web" >&2; exit 1; }
fi

# ── 2. compile ─────────────────────────────────────────────────────────────
echo "▸ swift build -c ${CONFIG}…"
( cd "$HERE" && swift build -c "$CONFIG" )
BIN_DIR="$HERE/.build/$CONFIG"
EXE="$BIN_DIR/$APP_NAME"
RES_BUNDLE="$BIN_DIR/${APP_NAME}_${APP_NAME}.bundle"
[[ -x "$EXE" ]]          || { echo "  ✗ executable not found at $EXE" >&2; exit 1; }
[[ -d "$RES_BUNDLE" ]]   || { echo "  ✗ resource bundle not found at $RES_BUNDLE" >&2; exit 1; }

# ── 3. lay out the .app ────────────────────────────────────────────────────
DIST="$HERE/dist"
APP="$DIST/$APP_NAME.app"
echo "▸ assembling ${APP}…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$EXE" "$APP/Contents/MacOS/$APP_NAME"

# Copy the bundled web client into Contents/Resources/web. BundleSchemeHandler resolves it
# via Bundle.main.resourceURL/web at runtime (keeping everything under Contents/ so the app
# codesigns cleanly — a resource bundle at the .app root is rejected as "unsealed contents").
cp -R "$RES_BUNDLE/web" "$APP/Contents/Resources/web"

# ── 3b. embed Sparkle.framework (auto-update) ──────────────────────────────
# SwiftPM copies the macOS-sliced Sparkle.framework next to the executable in .build/<config>.
# Move it under Contents/Frameworks and add the rpath the binary uses to find it at runtime.
SPARKLE_FW="$BIN_DIR/Sparkle.framework"
if [[ -d "$SPARKLE_FW" ]]; then
  echo "▸ embedding Sparkle.framework…"
  mkdir -p "$APP/Contents/Frameworks"
  cp -R "$SPARKLE_FW" "$APP/Contents/Frameworks/Sparkle.framework"
  install_name_tool -add_rpath "@executable_path/../Frameworks" "$APP/Contents/MacOS/$APP_NAME" 2>/dev/null || true
else
  echo "  ! Sparkle.framework not found in $BIN_DIR — auto-update will be unavailable in this build"
fi

# ── 4. icon: .appiconset → AppIcon.icns (iconutil, no Xcode) ────────────────
ICONSET_SRC="$HERE/Resources/Assets.xcassets/AppIcon.appiconset"
if [[ -d "$ICONSET_SRC" ]]; then
  echo "▸ compiling AppIcon.icns…"
  WORK="$(mktemp -d)"
  ICONSET="$WORK/AppIcon.iconset"
  mkdir -p "$ICONSET"
  # iconutil wants icon_<size>.png / icon_<size>@2x.png (no "@1x" suffix).
  for px in 16 32 128 256 512; do
    cp "$ICONSET_SRC/icon_${px}x${px}@1x.png" "$ICONSET/icon_${px}x${px}.png"
    cp "$ICONSET_SRC/icon_${px}x${px}@2x.png" "$ICONSET/icon_${px}x${px}@2x.png"
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
  rm -rf "$WORK"
else
  echo "  ! no AppIcon.appiconset — building without an app icon"
fi

# ── 5. Info.plist ──────────────────────────────────────────────────────────
# Sparkle keys only when a public key is present (release builds) — see SU_PUBLIC_KEY above.
SPARKLE_KEYS=""
if [[ -n "$SU_PUBLIC_KEY" ]]; then
  SPARKLE_KEYS="    <key>SUFeedURL</key>                       <string>$SU_FEED_URL</string>
    <key>SUPublicEDKey</key>                   <string>$SU_PUBLIC_KEY</string>
    <key>SUEnableAutomaticChecks</key>         <true/>"
fi
echo "▸ writing Info.plist…"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>      <string>en</string>
    <key>CFBundleExecutable</key>             <string>$APP_NAME</string>
    <key>CFBundleIconFile</key>               <string>AppIcon</string>
    <key>CFBundleIdentifier</key>             <string>$BUNDLE_ID</string>
    <key>CFBundleInfoDictionaryVersion</key>  <string>6.0</string>
    <key>CFBundleName</key>                    <string>$APP_NAME</string>
    <key>CFBundleDisplayName</key>             <string>$APP_NAME</string>
    <key>CFBundlePackageType</key>             <string>APPL</string>
    <key>CFBundleShortVersionString</key>      <string>$VERSION</string>
    <key>CFBundleVersion</key>                 <string>$BUILD</string>
$SPARKLE_KEYS
    <key>LSMinimumSystemVersion</key>          <string>13.0</string>
    <key>LSApplicationCategoryType</key>       <string>public.app-category.developer-tools</string>
    <key>NSHighResolutionCapable</key>         <true/>
    <key>NSPrincipalClass</key>                <string>NSApplication</string>
    <key>CFBundleURLTypes</key>
    <array>
      <dict>
        <key>CFBundleURLName</key>             <string>$BUNDLE_ID</string>
        <key>CFBundleURLSchemes</key>          <array><string>anvil</string></array>
      </dict>
    </array>
</dict>
</plist>
PLIST

echo "APPL????" > "$APP/Contents/PkgInfo"

# ── 6. codesign ────────────────────────────────────────────────────────────
# SIGN_ID="-" → ad-hoc (default, for local debug). Set SIGN_ID to a real
# "Developer ID Application: …" identity (e.g. via scripts/mac-signing/provision.sh,
# which exports it) to produce a distributable, notarizable build.
SIGN_ID="${SIGN_ID:--}"
ENTITLEMENTS="$HERE/Resources/Anvil.entitlements"
TIMESTAMP_FLAG=(); [ "$SIGN_ID" != "-" ] && TIMESTAMP_FLAG=(--timestamp)

# Sign inside-out: the embedded Sparkle.framework (and its nested helpers/XPC services) first, then
# the outer app. The framework gets NO app entitlements — its helpers have their own needs — so we
# --deep-sign just the framework here, then sign the app non-deep so the app keeps its entitlements.
if [[ -d "$APP/Contents/Frameworks/Sparkle.framework" ]]; then
  echo "▸ codesigning Sparkle.framework…"
  codesign --force --deep --sign "$SIGN_ID" --options runtime ${TIMESTAMP_FLAG[@]+"${TIMESTAMP_FLAG[@]}"} \
    "$APP/Contents/Frameworks/Sparkle.framework"
fi

echo "▸ codesigning ($([ "$SIGN_ID" = "-" ] && echo ad-hoc || echo "$SIGN_ID"))…"
codesign --force --sign "$SIGN_ID" \
  ${ENTITLEMENTS:+--entitlements "$ENTITLEMENTS"} \
  --options runtime ${TIMESTAMP_FLAG[@]+"${TIMESTAMP_FLAG[@]}"} \
  "$APP"
codesign --verify --deep --strict "$APP" && echo "  ✓ signature verifies"

# ── 7. notarize + staple (only for real Developer ID builds) ───────────────
if [ "$SIGN_ID" != "-" ] && [ -n "${APPLE_API_KEY_PATH:-}" ]; then
  echo "▸ notarizing…"
  ditto -c -k --keepParent "$APP" "$APP.zip"
  xcrun notarytool submit "$APP.zip" \
    --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" \
    --wait
  xcrun stapler staple "$APP"
  rm -f "$APP.zip"
  echo "  ✓ notarized & stapled"
fi

echo
echo "✓ built $APP  (v$VERSION build $BUILD)"
echo "  open it with:  open \"$APP\""
