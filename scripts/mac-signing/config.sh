# Shared config for the mac-signing toolkit. Sourced by push-secrets.sh and provision.sh.
# Contains NO secrets — safe to commit.

# GCP project that holds the signing secrets. Override with SIGNING_GCP_PROJECT.
PROJECT="${SIGNING_GCP_PROJECT:-gte619n-anvil}"

# Secret Manager secret names.
SECRET_P12="mac-signing-developer-id-p12"            # base64 of the Developer ID Application .p12
SECRET_P12_PASS="mac-signing-developer-id-p12-pass"  # password used when exporting the .p12
SECRET_IDENTITY="mac-signing-identity-name"          # e.g. "Developer ID Application: Evan Ruff (TEAMID)"
SECRET_NOTARY_P8="mac-signing-notary-api-key-p8"     # base64 of the App Store Connect AuthKey .p8
SECRET_NOTARY_KEY_ID="mac-signing-notary-key-id"     # App Store Connect API Key ID
SECRET_NOTARY_ISSUER="mac-signing-notary-issuer-id"  # App Store Connect Issuer ID

# Where provision.sh lands files on each machine.
SIGNING_HOME="${SIGNING_HOME:-$HOME/.config/oxos-signing}"
KEYCHAIN_NAME="oxos-signing.keychain-db"
KEYCHAIN_PATH="$HOME/Library/Keychains/$KEYCHAIN_NAME"
ENV_FILE="$SIGNING_HOME/env.sh"
P8_PATH="$SIGNING_HOME/notary-api-key.p8"

# --- helpers ----------------------------------------------------------------
die() { echo "✗ $*" >&2; exit 1; }

require() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

check_gcloud_auth() {
  require gcloud
  gcloud auth print-access-token >/dev/null 2>&1 \
    || die "not authenticated to gcloud. Run: gcloud auth login"
}

# Read a secret's latest version to stdout.
secret_get() { gcloud secrets versions access latest --secret="$1" --project="$PROJECT"; }

# Create the secret if absent, then add a new version from a file (or '-' for stdin).
secret_put() {
  local name="$1" file="$2"
  gcloud secrets describe "$name" --project="$PROJECT" >/dev/null 2>&1 \
    || gcloud secrets create "$name" --project="$PROJECT" --replication-policy=automatic
  gcloud secrets versions add "$name" --project="$PROJECT" --data-file="$file"
}
