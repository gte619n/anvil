#!/usr/bin/env bash
# Upload Apple signing secrets to Google Secret Manager. Run ONCE (re-run to rotate).
#
# Push only the groups you pass — each group is independent, so you can seed macOS first
# and add iOS later:
#
#   macOS Developer ID:   --p12 <file> --p12-pass <pw> --identity "Developer ID Application: …"
#   App Store Connect key: --p8 <file> --key-id <id> --issuer <uuid>   (notarize + iOS upload)
#   iOS distribution:     --ios-p12 <file> --ios-p12-pass <pw>
#   Apple Team ID:        --team-id <10-char>            (needed by iOS build + APNs)
#   APNs auth key:        --apns-p8 <file> --apns-key-id <id>
#
# Example (everything at once):
#   ./push-secrets.sh \
#     --p12 ~/developerid.p12 --p12-pass 'pw1' --identity "Developer ID Application: Evan Ruff (TEAMID)" \
#     --p8 ~/AuthKey_ASC.p8 --key-id ASCKEYID --issuer 12ab-…-uuid \
#     --ios-p12 ~/ios_dist.p12 --ios-p12-pass 'pw2' --team-id TEAMID \
#     --apns-p8 ~/AuthKey_TPMBBMT6MZ.p8 --apns-key-id TPMBBMT6MZ
set -euo pipefail
cd "$(dirname "$0")"
source ./config.sh

P12= P12_PASS= IDENTITY= P8= KEY_ID= ISSUER=
IOS_P12= IOS_P12_PASS= TEAM_ID= APNS_P8= APNS_KEY_ID=
while [ $# -gt 0 ]; do
  case "$1" in
    --p12)          P12="$2"; shift 2;;
    --p12-pass)     P12_PASS="$2"; shift 2;;
    --identity)     IDENTITY="$2"; shift 2;;
    --p8)           P8="$2"; shift 2;;
    --key-id)       KEY_ID="$2"; shift 2;;
    --issuer)       ISSUER="$2"; shift 2;;
    --ios-p12)      IOS_P12="$2"; shift 2;;
    --ios-p12-pass) IOS_P12_PASS="$2"; shift 2;;
    --team-id)      TEAM_ID="$2"; shift 2;;
    --apns-p8)      APNS_P8="$2"; shift 2;;
    --apns-key-id)  APNS_KEY_ID="$2"; shift 2;;
    *) die "unknown arg: $1";;
  esac
done

check_gcloud_auth
echo "▸ target project: $PROJECT"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
pushed=0

# --- macOS Developer ID cert -------------------------------------------------
if [ -n "$P12" ] || [ -n "$P12_PASS" ] || [ -n "$IDENTITY" ]; then
  [ -n "$P12" ] && [ -f "$P12" ] || die "--p12 <file> required with the Developer ID group"
  [ -n "$P12_PASS" ] || die "--p12-pass required with the Developer ID group"
  [ -n "$IDENTITY" ] || die "--identity required with the Developer ID group"
  base64 -i "$P12" -o "$tmp/p12.b64"
  printf '%s' "$P12_PASS" > "$tmp/p12pass"
  printf '%s' "$IDENTITY" > "$tmp/identity"
  secret_put "$SECRET_P12"      "$tmp/p12.b64"
  secret_put "$SECRET_P12_PASS" "$tmp/p12pass"
  secret_put "$SECRET_IDENTITY" "$tmp/identity"
  echo "  ✓ macOS Developer ID cert"; pushed=1
fi

# --- App Store Connect API key (notarize + iOS upload) -----------------------
if [ -n "$P8" ] || [ -n "$KEY_ID" ] || [ -n "$ISSUER" ]; then
  [ -n "$P8" ] && [ -f "$P8" ] || die "--p8 <file> required with the API-key group"
  [ -n "$KEY_ID" ] || die "--key-id required with the API-key group"
  [ -n "$ISSUER" ] || die "--issuer required with the API-key group"
  base64 -i "$P8" -o "$tmp/p8.b64"
  printf '%s' "$KEY_ID" > "$tmp/keyid"
  printf '%s' "$ISSUER" > "$tmp/issuer"
  secret_put "$SECRET_NOTARY_P8"     "$tmp/p8.b64"
  secret_put "$SECRET_NOTARY_KEY_ID" "$tmp/keyid"
  secret_put "$SECRET_NOTARY_ISSUER" "$tmp/issuer"
  echo "  ✓ App Store Connect API key"; pushed=1
fi

# --- iOS distribution cert ---------------------------------------------------
if [ -n "$IOS_P12" ] || [ -n "$IOS_P12_PASS" ]; then
  [ -n "$IOS_P12" ] && [ -f "$IOS_P12" ] || die "--ios-p12 <file> required with the iOS group"
  [ -n "$IOS_P12_PASS" ] || die "--ios-p12-pass required with the iOS group"
  base64 -i "$IOS_P12" -o "$tmp/iosp12.b64"
  printf '%s' "$IOS_P12_PASS" > "$tmp/iosp12pass"
  secret_put "$SECRET_IOS_P12"      "$tmp/iosp12.b64"
  secret_put "$SECRET_IOS_P12_PASS" "$tmp/iosp12pass"
  echo "  ✓ iOS distribution cert"; pushed=1
fi

# --- Apple Team ID -----------------------------------------------------------
if [ -n "$TEAM_ID" ]; then
  printf '%s' "$TEAM_ID" > "$tmp/teamid"
  secret_put "$SECRET_TEAM_ID" "$tmp/teamid"
  echo "  ✓ Apple Team ID"; pushed=1
fi

# --- APNs auth key (for the daemon) ------------------------------------------
if [ -n "$APNS_P8" ] || [ -n "$APNS_KEY_ID" ]; then
  [ -n "$APNS_P8" ] && [ -f "$APNS_P8" ] || die "--apns-p8 <file> required with the APNs group"
  [ -n "$APNS_KEY_ID" ] || die "--apns-key-id required with the APNs group"
  base64 -i "$APNS_P8" -o "$tmp/apns.b64"
  printf '%s' "$APNS_KEY_ID" > "$tmp/apnskeyid"
  secret_put "$SECRET_APNS_P8"     "$tmp/apns.b64"
  secret_put "$SECRET_APNS_KEY_ID" "$tmp/apnskeyid"
  echo "  ✓ APNs auth key"; pushed=1
fi

[ "$pushed" = 1 ] || die "nothing to push — pass at least one secret group (see usage at top of this script)"

echo "✓ secrets uploaded to project '$PROJECT'."
echo "  Provision a Mac with:        ./provision.sh"
echo "  Mirror to GitHub Actions:    ./sync-github-secrets.sh"
