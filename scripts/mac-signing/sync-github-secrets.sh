#!/usr/bin/env bash
# Mirror the signing/publishing secrets from Google Secret Manager into the GitHub repo's Actions
# secrets, so the full-release workflow (release.yml) can build, sign, notarize, and publish without
# GCP auth in CI.
#
# Secret Manager is the source of truth (used by local builds via provision.sh); this just copies
# the subset the CI workflow needs. Re-run after rotating any secret.
#
# Needs: gcloud (authed), gh (authed, with repo admin). Run from anywhere in the repo.
#
# Usage:  ./sync-github-secrets.sh            (auto-detects the repo via gh)
#         ./sync-github-secrets.sh owner/repo
set -euo pipefail
cd "$(dirname "$0")"
source ./config.sh

require gh
check_gcloud_auth

REPO_FLAG=()
[ $# -gt 0 ] && REPO_FLAG=(--repo "$1")

# ${arr[@]+…} guards the expansion so an empty array doesn't trip `set -u` on bash 3.2 (macOS default).
set_secret() { gh secret set "$1" ${REPO_FLAG[@]+"${REPO_FLAG[@]}"} --body "$2" >/dev/null && echo "  ✓ $1"; }
# Mirror only if the GCP secret exists (setup is incremental — you can add Android/Sparkle later).
set_secret_opt() {
  local gh_name="$1" gcp_name="$2"
  if secret_exists "$gcp_name"; then set_secret "$gh_name" "$(secret_get "$gcp_name")";
  else echo "  • skip $gh_name (no Secret Manager secret '$gcp_name' yet)"; fi
}

echo "▸ mirroring Secret Manager → GitHub Actions secrets…"

# The cert + APNs .p8 are stored base64 in Secret Manager; the workflow base64-decodes them, so
# pass the base64 text straight through as the GitHub secret body.
# iOS (TestFlight) — required by release.yml's `ios` job.
set_secret IOS_DIST_P12_BASE64   "$(secret_get "$SECRET_IOS_P12")"
set_secret IOS_DIST_P12_PASSWORD "$(secret_get "$SECRET_IOS_P12_PASS")"
set_secret IOS_PROVISIONING_PROFILE_BASE64 "$(secret_get "$SECRET_IOS_PROFILE")"
set_secret APPLE_TEAM_ID         "$(secret_get "$SECRET_TEAM_ID")"
set_secret APPLE_API_KEY_BASE64  "$(secret_get "$SECRET_NOTARY_P8")"
set_secret APPLE_API_KEY_ID      "$(secret_get "$SECRET_NOTARY_KEY_ID")"
set_secret APPLE_API_ISSUER_ID   "$(secret_get "$SECRET_NOTARY_ISSUER")"

# macOS Developer ID (notarized Sparkle builds) — the existing Developer ID cert, under GitHub names.
set_secret_opt MAC_DEVELOPER_ID_P12_BASE64   "$SECRET_P12"
set_secret_opt MAC_DEVELOPER_ID_P12_PASSWORD "$SECRET_P12_PASS"

# Sparkle EdDSA keys (macOS auto-update).
set_secret_opt SPARKLE_ED_PRIVATE_KEY "$SECRET_SPARKLE_PRIV"
set_secret_opt SPARKLE_PUBLIC_ED_KEY  "$SECRET_SPARKLE_PUB"

# Android Play Store (upload key + service account).
set_secret_opt ANDROID_UPLOAD_KEYSTORE_BASE64   "$SECRET_ANDROID_KEYSTORE"
set_secret_opt ANDROID_UPLOAD_KEYSTORE_PASSWORD "$SECRET_ANDROID_STORE_PASS"
set_secret_opt ANDROID_UPLOAD_KEY_ALIAS         "$SECRET_ANDROID_KEY_ALIAS"
set_secret_opt ANDROID_UPLOAD_KEY_PASSWORD      "$SECRET_ANDROID_KEY_PASS"
set_secret_opt PLAY_SERVICE_ACCOUNT_JSON        "$SECRET_PLAY_SA"

echo "✓ GitHub Actions secrets updated."
echo "  Full release (all platforms): merge to main, or 'gh workflow run release.yml'"
