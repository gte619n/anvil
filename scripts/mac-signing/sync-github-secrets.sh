#!/usr/bin/env bash
# Mirror the iOS signing secrets from Google Secret Manager into the GitHub repo's Actions
# secrets, so .github/workflows/ios-release.yml can sign + upload without GCP auth in CI.
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

echo "▸ mirroring Secret Manager → GitHub Actions secrets…"

# The cert + APNs .p8 are stored base64 in Secret Manager; the workflow base64-decodes them, so
# pass the base64 text straight through as the GitHub secret body.
set_secret IOS_DIST_P12_BASE64   "$(secret_get "$SECRET_IOS_P12")"
set_secret IOS_DIST_P12_PASSWORD "$(secret_get "$SECRET_IOS_P12_PASS")"
set_secret APPLE_TEAM_ID         "$(secret_get "$SECRET_TEAM_ID")"
set_secret APPLE_API_KEY_BASE64  "$(secret_get "$SECRET_NOTARY_P8")"
set_secret APPLE_API_KEY_ID      "$(secret_get "$SECRET_NOTARY_KEY_ID")"
set_secret APPLE_API_ISSUER_ID   "$(secret_get "$SECRET_NOTARY_ISSUER")"

echo "✓ GitHub Actions secrets updated. Run the workflow:  gh workflow run ios-release.yml"
