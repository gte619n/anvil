# Setup — Developer ID signing, end to end

Everything you need to do **once** to go from nothing to signed + notarized
builds. After this, each machine just runs `./provision.sh`.

Distribution model: **Developer ID** (apps shipped outside the Mac App Store as
`.app`/`.dmg`). Account: a **personal** Apple Developer membership. No full Xcode
required — Command Line Tools are enough.

---

## 0. Prerequisites
- An **Apple Developer Program** membership ($99/yr) — enroll at
  <https://developer.apple.com/programs/> if you haven't.
- Xcode **Command Line Tools**: `xcode-select --install` (gives you `codesign`,
  `notarytool`, `stapler`).
- `gcloud` authenticated as a principal with access to the `gte619n-anvil`
  project: `gcloud auth login`.

---

## 1. Create the Developer ID Application certificate

You need a **Developer ID Application** cert whose private key lives in your
keychain. Without Xcode, create it via a CSR:

1. Open **Keychain Access** → menu **Certificate Assistant → Request a
   Certificate From a Certificate Authority**.
   - **User Email Address**: your Apple ID email.
   - **Common Name**: anything (e.g. "Evan Ruff Dev ID").
   - **CA Email Address**: leave blank.
   - Select **Saved to disk** and **Let me specify key pair information** →
     **Continue** → 2048-bit / RSA.
   - This generates the private key in your login keychain and a
     `CertificateSigningRequest.certSigningRequest` file on disk.
2. Go to <https://developer.apple.com/account/resources/certificates/list> →
   **+** → choose **Developer ID Application** → **Continue** → upload the CSR →
   **Continue** → **Download** the `.cer`.
3. **Double-click the `.cer`** to install it into your **login** keychain. It
   pairs automatically with the private key from step 1.
4. Confirm it's usable:
   ```sh
   security find-identity -v -p codesigning
   ```
   You should see a line like:
   ```
   1) ABC123… "Developer ID Application: Evan Ruff (TEAMID)"
   ```
   **Copy that full quoted string** — it's the `--identity` value below. The
   `TEAMID` (10 chars) is your Apple Team ID.

### Export the cert as a `.p12` (for Secret Manager)
Keychain Access → **login** keychain → **My Certificates** → right-click the
**Developer ID Application** entry → **Export** → format **Personal Information
Exchange (.p12)** → save as `DeveloperID.p12` → set an **export password**
(remember it; it becomes the `--p12-pass` value).

> Expand the cert's disclosure triangle before exporting and make sure the
> **private key** is included — exporting the cert alone won't sign anything.

---

## 2. Create the App Store Connect API key (notarization + iOS upload)

Notarization needs credentials to talk to Apple, and so does the iOS TestFlight
upload. **One** API key serves both. An API key is cleaner than an app-specific
password (no expiry surprises).

1. <https://appstoreconnect.apple.com/access/integrations/api> → **Team Keys**
   (or **Integrations → App Store Connect API**) → **+** to generate a key.
2. **Name**: e.g. "anvil ci". **Access**: **App Manager** — needed so the same key
   can upload builds to TestFlight (the Developer role only covers notarization).
3. **Generate**, then **Download** the `AuthKey_XXXXXXXX.p8` — *you only get one
   download*. Save it.
4. Note two values from that page:
   - **Key ID** — the `XXXXXXXX` in the filename (also shown in the table).
   - **Issuer ID** — the UUID at the top of the Keys page (shared across keys).

---

## 3. Upload everything to Secret Manager (once)

From `scripts/mac-signing/`:

```sh
./push-secrets.sh \
  --p12 ~/DeveloperID.p12 \
  --p12-pass 'your-export-password' \
  --identity "Developer ID Application: Evan Ruff (TEAMID)" \
  --p8 ~/AuthKey_ABC12345.p8 \
  --key-id ABC12345 \
  --issuer 1234abcd-12ab-34cd-56ef-1234567890ab
```

This writes six secrets into project **`gte619n-anvil`** (override with
`SIGNING_GCP_PROJECT`). After this you can delete the local `.p12`/`.p8` if you
like — Secret Manager is now the source of truth.

### What gets stored where

| Secret name | Contents | From |
|---|---|---|
| `mac-signing-developer-id-p12` | base64 of `DeveloperID.p12` | step 1 export |
| `mac-signing-developer-id-p12-pass` | the `.p12` export password | step 1 export |
| `mac-signing-identity-name` | `Developer ID Application: Evan Ruff (TEAMID)` | `find-identity` |
| `mac-signing-notary-api-key-p8` | base64 of `AuthKey_*.p8` | step 2 |
| `mac-signing-notary-key-id` | API **Key ID** | step 2 |
| `mac-signing-notary-issuer-id` | API **Issuer ID** | step 2 |

(Secret names are defined in `config.sh`.)

### IAM
Each machine that runs `provision.sh` must authenticate as a principal with
**`roles/secretmanager.secretAccessor`** on `gte619n-anvil`. As project
owner/editor you already have it; grant it to teammates/CI service accounts as
needed:
```sh
gcloud projects add-iam-policy-binding gte619n-anvil \
  --member="user:someone@example.com" \
  --role="roles/secretmanager.secretAccessor"
```

---

## 4. Provision a machine and build

On any Mac (including this one), once per machine:
```sh
gcloud auth login          # if not already
cd scripts/mac-signing
./provision.sh
```
`provision.sh` pulls the secrets, creates a dedicated `oxos-signing` keychain,
imports the cert for non-interactive `codesign`, drops the notary key in
`~/.config/oxos-signing/`, and writes `~/.config/oxos-signing/env.sh`.

Then build:
```sh
source ~/.config/oxos-signing/env.sh
# Anvil:
cd ~/Development/anvil/apple && ./make-app.sh
# Slates:
cd ~/Development/slates/desktop && npm run tauri:build
```
Without sourcing `env.sh`, `make-app.sh` still does ad-hoc signing for local
debug — nothing breaks.

Verify a finished build will pass Gatekeeper on other Macs:
```sh
spctl -a -vvv --type exec /path/to/App.app
# → accepted, source=Notarized Developer ID
```

---

## 5. iOS / iPadOS → TestFlight

The iOS app reuses the API key from step 2 and adds an **Apple Distribution**
cert. Signing is automatic (xcodebuild manages the provisioning profile via the
API key), so you only store the cert + Team ID — no profile to manage.

1. **Apple Distribution cert** — create it the same CSR way as step 1 (pick
   *Apple Distribution* in the portal), export the `.p12` with a password. Or all
   in `openssl` (see `apple/README.md`).
2. **Team ID** — the 10-char id from developer.apple.com → Membership details.
3. **APNs auth key** — Keys → **+** → Apple Push Notifications service → download
   the `AuthKey_*.p8`, note its Key ID. (Token-based; one key for dev + prod.)
4. **App record** — App Store Connect → Apps → **+** → New App, bundle id
   `com.gte619n.anvil`. TestFlight needs somewhere to receive the build.
5. Push the iOS secrets (groups are independent — add to what step 3 already pushed):
   ```sh
   ./push-secrets.sh \
     --ios-p12 ~/ios_dist.p12 --ios-p12-pass 'pw' --team-id TEAMID \
     --apns-p8 ~/AuthKey_TPMBBMT6MZ.p8 --apns-key-id TPMBBMT6MZ
   ```
6. **Build locally** (full Xcode required): `source ~/.config/oxos-signing/env.sh`
   then `cd apple && ./make-ios.sh`.
7. **CI** (the `ios` job in `.github/workflows/release.yml`): mirror the secrets into GitHub
   once with `./sync-github-secrets.sh`; the full release then runs on merge to `main` (or
   `gh workflow run release.yml`).

| iOS secret name | Contents |
|---|---|
| `ios-distribution-p12` | base64 of the Apple Distribution `.p12` |
| `ios-distribution-p12-pass` | its export password |
| `apple-team-id` | 10-char Team ID |
| `apns-auth-key-p8` | base64 of the APNs `AuthKey_*.p8` |
| `apns-key-id` | the APNs key's Key ID |

`provision.sh` on the daemon host also assembles `~/.config/anvil/apns-key.json`
from the APNs secret + Team ID, so the push sender is ready after a restart.

## Rotation / renewal
- **Cert expires** (Developer ID certs last 5 years): create a new one (step 1),
  re-run `push-secrets.sh` (adds new versions), then `./provision.sh` on each
  machine.
- **API key compromised**: revoke it in App Store Connect, generate a new one
  (step 2), re-run `push-secrets.sh`, re-provision.
- `push-secrets.sh` always adds a **new version**; existing machines keep using
  their imported cert until they re-provision.
