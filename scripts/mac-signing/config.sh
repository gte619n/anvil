# Shared config for the mac-signing toolkit. Sourced by push-secrets.sh and provision.sh.
# Contains NO secrets — safe to commit.

# GCP project that holds the signing secrets. Override with SIGNING_GCP_PROJECT.
PROJECT="${SIGNING_GCP_PROJECT:-gte619n-anvil}"

# Secret Manager secret names.
# --- macOS Developer ID (direct-download / notarized app) ---
SECRET_P12="mac-signing-developer-id-p12"            # base64 of the Developer ID Application .p12
SECRET_P12_PASS="mac-signing-developer-id-p12-pass"  # password used when exporting the .p12
SECRET_IDENTITY="mac-signing-identity-name"          # e.g. "Developer ID Application: Evan Ruff (TEAMID)"
# --- App Store Connect API key (App Manager role) — used for BOTH macOS notarization AND iOS
#     TestFlight upload + automatic-signing profile updates. (Named "notary" for history.) ---
SECRET_NOTARY_P8="mac-signing-notary-api-key-p8"     # base64 of the App Store Connect AuthKey .p8
SECRET_NOTARY_KEY_ID="mac-signing-notary-key-id"     # App Store Connect API Key ID
SECRET_NOTARY_ISSUER="mac-signing-notary-issuer-id"  # App Store Connect Issuer ID
# --- iOS distribution (TestFlight / App Store) ---
SECRET_IOS_P12="ios-distribution-p12"                # base64 of the Apple Distribution .p12
SECRET_IOS_P12_PASS="ios-distribution-p12-pass"      # its export password
SECRET_IOS_PROFILE="ios-provisioning-profile"        # base64 of the App Store .mobileprovision
SECRET_TEAM_ID="apple-team-id"                        # 10-char Apple Developer Team ID
# --- APNs auth key for the daemon's push sender (anvild/src/push/apns.ts) ---
SECRET_APNS_P8="apns-auth-key-p8"                    # base64 of the APNs AuthKey_*.p8
SECRET_APNS_KEY_ID="apns-key-id"                     # the APNs key's Key ID
# --- Android Play Store upload key (PRODUCTION signing; separate from the committed debug keystore) ---
SECRET_ANDROID_KEYSTORE="android-upload-keystore"        # base64 of the upload keystore (.jks/.keystore)
SECRET_ANDROID_STORE_PASS="android-upload-keystore-pass" # keystore (store) password
SECRET_ANDROID_KEY_ALIAS="android-upload-key-alias"      # key alias inside the keystore
SECRET_ANDROID_KEY_PASS="android-upload-key-pass"        # key password
# --- Google Play service account (publishes the AAB to the production track) ---
SECRET_PLAY_SA="play-service-account-json"               # full service-account JSON (Release manager)
# --- Sparkle auto-update signing (EdDSA), for the two macOS apps' appcasts ---
SECRET_SPARKLE_PRIV="sparkle-ed-private-key"             # EdDSA private key string (sign_update -s)
SECRET_SPARKLE_PUB="sparkle-ed-public-key"               # EdDSA public key string (Info.plist SUPublicEDKey)

# Where provision.sh lands files on each machine.
SIGNING_HOME="${SIGNING_HOME:-$HOME/.config/oxos-signing}"
KEYCHAIN_NAME="oxos-signing.keychain-db"
KEYCHAIN_PATH="$HOME/Library/Keychains/$KEYCHAIN_NAME"
ENV_FILE="$SIGNING_HOME/env.sh"
P8_PATH="$SIGNING_HOME/notary-api-key.p8"
# Daemon APNs config (written by provision.sh when the APNs secrets are present).
ANVIL_CONFIG_DIR="${ANVIL_CONFIG_DIR:-$HOME/.config/anvil}"
APNS_KEY_JSON="$ANVIL_CONFIG_DIR/apns-key.json"
APNS_BUNDLE_ID="${APNS_BUNDLE_ID:-com.gte619n.anvil}"

# True if a Secret Manager secret exists (any version). Used to make iOS/APNs steps optional.
secret_exists() { gcloud secrets describe "$1" --project="$PROJECT" >/dev/null 2>&1; }

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
