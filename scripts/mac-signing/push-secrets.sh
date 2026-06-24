#!/usr/bin/env bash
# Upload the macOS signing secrets to Google Secret Manager. Run ONCE, on the
# machine that already holds the Developer ID cert + App Store Connect API key
# (i.e. after completing Steps 1–2 of setup).
#
# Usage:
#   ./push-secrets.sh \
#     --p12 ~/DeveloperID.p12 --p12-pass 'export-password' \
#     --identity "Developer ID Application: Evan Ruff (TEAMID)" \
#     --p8 ~/AuthKey_ABC123.p8 --key-id ABC123 --issuer 12ab-...-uuid
#
# Re-running adds new secret versions (rotation); old machines keep working
# until they re-provision.
set -euo pipefail
cd "$(dirname "$0")"
source ./config.sh

P12= P12_PASS= IDENTITY= P8= KEY_ID= ISSUER=
while [ $# -gt 0 ]; do
  case "$1" in
    --p12)      P12="$2"; shift 2;;
    --p12-pass) P12_PASS="$2"; shift 2;;
    --identity) IDENTITY="$2"; shift 2;;
    --p8)       P8="$2"; shift 2;;
    --key-id)   KEY_ID="$2"; shift 2;;
    --issuer)   ISSUER="$2"; shift 2;;
    *) die "unknown arg: $1";;
  esac
done

[ -n "$P12" ] && [ -f "$P12" ] || die "--p12 <file> required (the exported Developer ID .p12)"
[ -n "$P12_PASS" ] || die "--p12-pass required (password you set when exporting the .p12)"
[ -n "$IDENTITY" ] || die "--identity required (the 'Developer ID Application: …' string)"
[ -n "$P8" ] && [ -f "$P8" ] || die "--p8 <file> required (App Store Connect AuthKey_*.p8)"
[ -n "$KEY_ID" ] || die "--key-id required"
[ -n "$ISSUER" ] || die "--issuer required"

check_gcloud_auth
echo "▸ target project: $PROJECT"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

base64 -i "$P12" -o "$tmp/p12.b64"
base64 -i "$P8"  -o "$tmp/p8.b64"
printf '%s' "$P12_PASS" > "$tmp/p12pass"
printf '%s' "$IDENTITY" > "$tmp/identity"
printf '%s' "$KEY_ID"   > "$tmp/keyid"
printf '%s' "$ISSUER"   > "$tmp/issuer"

secret_put "$SECRET_P12"            "$tmp/p12.b64"
secret_put "$SECRET_P12_PASS"       "$tmp/p12pass"
secret_put "$SECRET_IDENTITY"       "$tmp/identity"
secret_put "$SECRET_NOTARY_P8"      "$tmp/p8.b64"
secret_put "$SECRET_NOTARY_KEY_ID"  "$tmp/keyid"
secret_put "$SECRET_NOTARY_ISSUER"  "$tmp/issuer"

echo "✓ all signing secrets uploaded to project '$PROJECT'."
echo "  Provision any Mac with:  ./provision.sh"
