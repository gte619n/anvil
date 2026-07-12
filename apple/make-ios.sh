#!/usr/bin/env bash
#
# Build the iOS/iPadOS app and upload it to TestFlight (App Store Connect).
#
# Unlike make-app.sh (macOS, Command-Line-Tools only), this needs FULL Xcode.app and an Apple
# Developer Program account. It uses AUTOMATIC signing driven by an App Store Connect API key:
# xcodebuild creates/updates the provisioning profile itself (-allowProvisioningUpdates), so the
# only thing that must already be in a keychain on the search list is the Apple Distribution cert
# (provision.sh imports it locally; the CI workflow imports it into a temp keychain).
#
# Required env (provision.sh writes these into ~/.config/oxos-signing/env.sh):
#   APPLE_TEAM_ID        10-char Apple Developer Team ID
#   APPLE_API_KEY        App Store Connect API Key ID
#   APPLE_API_ISSUER     App Store Connect Issuer ID (UUID)
#   APPLE_API_KEY_PATH   path to the AuthKey_*.p8
# Optional:
#   ANVIL_BUILD_NUMBER       CFBundleVersion (must be unique per TestFlight upload; default 1)
#   ANVIL_MARKETING_VERSION  CFBundleShortVersionString (public version, e.g. 2.2.47). The full-release
#                            workflow sets this (VERSION + run number) so every artifact matches;
#                            default = project.yml when unset.
#
# Usage:
#   source ~/.config/oxos-signing/env.sh
#   ./make-ios.sh             # rebundle web, archive, export, upload
#   ./make-ios.sh --skip-web  # reuse the existing Sources/Anvil/web bundle
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # apple/
ROOT="$(cd "$HERE/.." && pwd)"                          # repo root
SCHEME="Anvil-iOS"
XCODEPROJ="$HERE/Anvil.xcodeproj"
RELEASE_ENTITLEMENTS="$HERE/Resources/Anvil-iOS-Release.entitlements"
BUILD_NUMBER="${ANVIL_BUILD_NUMBER:-1}"
# Marketing version: MAJOR.MINOR from the repo-root VERSION file (single source of truth shared by
# Android, the macOS client, and the server) + the build number → MAJOR.MINOR.<build>, so every CI
# (TestFlight) build revs automatically. The full-release workflow overrides it via
# ANVIL_MARKETING_VERSION (VERSION + run number).
MAJOR_MINOR="$(tr -d '[:space:]' < "$ROOT/VERSION" 2>/dev/null || true)"
MARKETING_VERSION="${ANVIL_MARKETING_VERSION:-${MAJOR_MINOR:-0.0}.$BUILD_NUMBER}"
SKIP_WEB=0

for arg in "$@"; do
  case "$arg" in
    --skip-web) SKIP_WEB=1 ;;
    *) echo "unknown arg: $arg (supported: --skip-web)" >&2; exit 2 ;;
  esac
done

die() { echo "✗ $*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }
require xcodegen; require xcodebuild; require bun
# Need a full Xcode (with the iOS SDK), not just the Command Line Tools. Check the SDK directly
# rather than grepping the xcode-select path (CI runners point xcode-select at versioned Xcode dirs).
xcrun --sdk iphoneos --show-sdk-path >/dev/null 2>&1 \
  || die "iOS SDK not found — need full Xcode.app (xcode-select -p = $(xcode-select -p)). Select it: sudo xcode-select -s /Applications/Xcode.app"

: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID (source ~/.config/oxos-signing/env.sh after provision.sh)}"
: "${APPLE_API_KEY:?set APPLE_API_KEY (App Store Connect Key ID)}"
: "${APPLE_API_ISSUER:?set APPLE_API_ISSUER (App Store Connect Issuer ID)}"
: "${APPLE_API_KEY_PATH:?set APPLE_API_KEY_PATH (path to AuthKey_*.p8)}"
[ -f "$APPLE_API_KEY_PATH" ] || die "APPLE_API_KEY_PATH not found: $APPLE_API_KEY_PATH"

# ── 1. bundle the web client (same generator the macOS app + Android use) ───
if [[ "$SKIP_WEB" == "0" ]]; then
  echo "▸ bundling web client…"
  ( cd "$ROOT/anvild" && bun run build:web )
  ( cd "$ROOT/anvild" && bun run web/bundle-native.ts "$HERE/Sources/Anvil/web" )
else
  [[ -f "$HERE/Sources/Anvil/web/index.html" ]] || die "Sources/Anvil/web missing — run without --skip-web"
fi

# ── 2. generate the Xcode project ───────────────────────────────────────────
echo "▸ xcodegen generate…"
( cd "$HERE" && xcodegen generate )

BUILD_DIR="$HERE/build"
ARCHIVE="$BUILD_DIR/Anvil.xcarchive"
EXPORT_DIR="$BUILD_DIR/export"
rm -rf "$BUILD_DIR"; mkdir -p "$BUILD_DIR"

# Manual signing: the Apple Distribution cert is in the keychain and the App Store provisioning
# profile is installed (CI: from the IOS_PROVISIONING_PROFILE_BASE64 secret; locally: provision.sh).
# Automatic signing can't work headless here — with only a distribution cert it tries to mint an iOS
# *Development* profile, which needs registered devices. The API key is still used to authenticate
# the upload on export.
PROFILE_NAME="${IOS_PROFILE_NAME:-Anvil iOS App Store CI}"

# ── 3. archive (Release → production APNs entitlement, manual distribution signing) ───
echo "▸ archiving (v$MARKETING_VERSION build $BUILD_NUMBER) with profile '$PROFILE_NAME'…"
xcodebuild archive \
  -project "$XCODEPROJ" -scheme "$SCHEME" -configuration Release \
  -archivePath "$ARCHIVE" \
  -destination 'generic/platform=iOS' \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="Apple Distribution" \
  PROVISIONING_PROFILE_SPECIFIER="$PROFILE_NAME" \
  CODE_SIGN_ENTITLEMENTS="$RELEASE_ENTITLEMENTS" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  MARKETING_VERSION="$MARKETING_VERSION"

# ── 4. ExportOptions → export + upload straight to App Store Connect ────────
cat > "$BUILD_DIR/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>                 <string>app-store</string>
    <key>destination</key>            <string>upload</string>
    <key>teamID</key>                 <string>$APPLE_TEAM_ID</string>
    <key>signingStyle</key>           <string>manual</string>
    <key>signingCertificate</key>     <string>Apple Distribution</string>
    <key>provisioningProfiles</key>
    <dict>
        <key>com.gte619n.anvil</key>  <string>$PROFILE_NAME</string>
    </dict>
    <key>uploadSymbols</key>          <true/>
</dict>
</plist>
PLIST

echo "▸ exporting + uploading to TestFlight…"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$BUILD_DIR/ExportOptions.plist" \
  -exportPath "$EXPORT_DIR" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$APPLE_API_KEY_PATH" \
  -authenticationKeyID "$APPLE_API_KEY" \
  -authenticationKeyIssuerID "$APPLE_API_ISSUER"

echo
echo "✓ uploaded build $BUILD_NUMBER to App Store Connect."
echo "  It appears under TestFlight after Apple finishes processing (a few minutes)."
