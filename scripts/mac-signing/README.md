# mac-signing (Apple signing)

Provision any Mac for Apple code signing + distribution, with all certs and keys
stored in **Google Secret Manager** (not on disk, not in git). Covers:
- **macOS Developer ID** + notarization — Slates (Tauri) and Anvil (`make-app.sh`).
- **iOS/iPadOS** distribution → TestFlight — Anvil (`apple/make-ios.sh`, CI workflow).
- the daemon's **APNs** auth key — written to `~/.config/anvil/apns-key.json`.

**New here? Start with [`SETUP.md`](./SETUP.md)** — the full one-time walkthrough
for generating the certs + keys, the exact secret names, and what goes where.
This README is the quick reference.

## Files
- `SETUP.md` — complete one-time setup guide (cert generation → secrets → build).
- `config.sh` — project + secret names + helpers. No secrets; safe to commit.
- `push-secrets.sh` — run **once** to upload certs/keys to Secret Manager (push only the groups you pass).
- `provision.sh` — run on **each machine** to install signing locally (+ iOS cert + APNs config when present).
- `sync-github-secrets.sh` — mirror the iOS secrets into GitHub Actions for the CI workflow.

## One-time prerequisites (do these before `push-secrets.sh`)
1. **Developer ID Application certificate** in your login keychain, exported as a
   `.p12` (Keychain Access → right-click the cert → Export, set a password).
2. **App Store Connect API key** for notarization: App Store Connect → Users and
   Access → Integrations → App Store Connect API → create a key with the
   **Developer** role. Download the `AuthKey_*.p8` and note the **Key ID** + **Issuer ID**.
3. The identity string from `security find-identity -v -p codesigning`, e.g.
   `Developer ID Application: Evan Ruff (TEAMID)`.

## Upload secrets (once)
```sh
./push-secrets.sh \
  --p12 ~/DeveloperID.p12 --p12-pass 'your-export-pw' \
  --identity "Developer ID Application: Evan Ruff (TEAMID)" \
  --p8 ~/AuthKey_ABC123.p8 --key-id ABC123 --issuer 1234abcd-...-uuid
```
Stored in project `gte619n-anvil` by default (override with `SIGNING_GCP_PROJECT`).
Re-running rotates: it adds new secret versions; re-provision machines to pick them up.

## Provision a machine
```sh
gcloud auth login          # if not already
./provision.sh
```
Creates a dedicated `oxos-signing` keychain, imports the cert for non-interactive
`codesign`, drops the notary key in `~/.config/oxos-signing/`, and writes
`~/.config/oxos-signing/env.sh`.

## Build signed apps
```sh
source ~/.config/oxos-signing/env.sh
# Slates:
cd ~/Development/slates/desktop && npm run tauri:build
# Anvil:
cd ~/Development/anvil/apple && ./make-app.sh
```
Both read `APPLE_SIGNING_IDENTITY` + the `APPLE_API_*` vars from `env.sh`. Without
sourcing it, `make-app.sh` falls back to ad-hoc signing (local debug, unchanged).

Verify any result:
```sh
spctl -a -vvv --type exec /path/to/App.app   # → accepted, source=Notarized Developer ID
```

## Secrets stored
| Secret | Contents |
|---|---|
| `mac-signing-developer-id-p12` | base64 of the `.p12` |
| `mac-signing-developer-id-p12-pass` | `.p12` export password |
| `mac-signing-identity-name` | `Developer ID Application: …` string |
| `mac-signing-notary-api-key-p8` | base64 of the `AuthKey_*.p8` |
| `mac-signing-notary-key-id` | API Key ID |
| `mac-signing-notary-issuer-id` | API Issuer ID |
