# Releasing Anvil

> **See [`docs/CI-CD.md`](docs/CI-CD.md) for the authoritative pipeline** — every target, every
> trigger, and how to ship. **This file is the signing / secrets / one-time-setup companion.**

## The model: one "full release" per merge to `main`

Anvil ships a **full release** on **every merge/push to `main`** (or a manual run of the workflow):
one version fanned out to all client surfaces at once via
**[`.github/workflows/release.yml`](.github/workflows/release.yml)**.

| Surface | How it ships |
|---------|--------------|
| **Android** | Firebase App Distribution (signed debug APK) |
| **iOS** | TestFlight |
| **macOS client** | Developer-ID notarized + Sparkle |
| **macOS server** | Developer-ID notarized + Sparkle |
| **web** | bundled into every shell above (and served by the daemon) — not a separate job |

**Public app stores (Play production / App Store review) are deliberately NOT wired.** We ship to the
test / auto-update channels only. The store setup below (§1 Play/App Store secrets, §3 listings)
stays documented so a public launch is a config change away, but no workflow invokes it today.

## Versioning (single source of truth)

`MAJOR.MINOR` lives in **one** place — the repo-root **`VERSION`** file (currently `2.2`) — read by
all four build paths (`app/build.gradle`, `apple/make-app.sh`, `apple/make-ios.sh`,
`anvil-server/make-app.sh`), so every artifact reports the same number. The full version is
**`MAJOR.MINOR.<run_number>`** (e.g. `2.2.47`); every job in a run shares the run number, so all four
apps match.

**To start a new line, edit `VERSION`** (e.g. `2.2` → `2.3`) and merge — the next full release is
`2.3.<run_number>`. The static `MARKETING_VERSION` in `apple/project.yml` is only for raw Xcode dev
builds — keep its MAJOR.MINOR in sync by hand.

## The release ritual

**Merge to `main`.** That's it — no tag to push. Watch the run in the repo's **Actions** tab
(workflow **"Full release"**). After `meta` (mint the version + a `v<version>` GitHub Release to host
the macOS zips) and `verify` (the merge gate), the four ship jobs run in parallel, then `pages`:

- **android** — builds the debug APK and distributes it to **Firebase App Distribution**.
- **ios** — archives and uploads to **TestFlight** (`make-ios.sh`).
- **mac-client** / **mac-server** — build, Developer-ID-sign, notarize, staple, attach the `.zip` to
  the build's GitHub Release, and sign the update with the Sparkle key.
- **pages** — updates the two Sparkle appcasts and deploys them to GitHub Pages so installed macOS
  apps auto-update.

To re-fire without a new commit, use **Actions → Full release → Run workflow** (`workflow_dispatch`).

> **Heads up on cadence.** Every merge notarizes both macOS apps and uploads to TestFlight (three
> `macos-15` jobs). That's real runner time and a TestFlight build number per merge — see the cost
> note in `docs/CI-CD.md` if merges get frequent.

The dev **"Update Anvil" / "Restart daemon"** affordances git-pull the *daemon* — independent of the
Firebase/TestFlight/Sparkle updates that refresh the *app shells*.

---

## One-time setup

### 1. Secrets

All secrets live in Google Secret Manager (project `gte619n-anvil`) and are mirrored into GitHub Actions.
Push them once, then mirror:

```bash
cd scripts/mac-signing

# Apple (Developer ID, App Store Connect API key, iOS distribution, Team ID) — see push-secrets.sh usage.
./push-secrets.sh --p12 devid.p12 --p12-pass '…' --identity "Developer ID Application: Evan Ruff (5WX3DS8SZQ)" \
  --p8 AuthKey_ASC.p8 --key-id ASCKEYID --issuer <uuid> \
  --ios-p12 ios_dist.p12 --ios-p12-pass '…' --team-id 5WX3DS8SZQ

# Android upload key + Play service account.
./push-secrets.sh \
  --android-keystore upload.keystore --android-keystore-pass '…' \
  --android-key-alias upload --android-key-pass '…' \
  --play-sa play-service-account.json

# Sparkle EdDSA keys (generate once — see step 4).
./push-secrets.sh --sparkle-priv-file sparkle_priv.key --sparkle-pub '<base64 public key>'

# Mirror everything present in Secret Manager → GitHub Actions secrets.
./sync-github-secrets.sh
```

The GitHub secrets the release workflow consumes:

| Secret | Used by |
|--------|---------|
| `IOS_DIST_P12_BASE64`, `IOS_DIST_P12_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64` | ios |
| `APPLE_TEAM_ID`, `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID` | ios, mac-client, mac-server |
| `MAC_DEVELOPER_ID_P12_BASE64`, `MAC_DEVELOPER_ID_P12_PASSWORD` | mac-client, mac-server |
| `SPARKLE_ED_PRIVATE_KEY`, `SPARKLE_PUBLIC_ED_KEY` | mac-client, mac-server |
| `ANDROID_UPLOAD_KEYSTORE_BASE64`, `ANDROID_UPLOAD_KEYSTORE_PASSWORD`, `ANDROID_UPLOAD_KEY_ALIAS`, `ANDROID_UPLOAD_KEY_PASSWORD` | android |
| `PLAY_SERVICE_ACCOUNT_JSON` | android |

### 2. GitHub Pages (hosts the Sparkle appcasts)

Repo **Settings → Pages → Build and deployment → Source = GitHub Actions**. The appcasts then publish to:

- client: `https://gte619n.github.io/anvil/appcast.xml`  (embedded as `SUFeedURL` in `Anvil.app`)
- server: `https://gte619n.github.io/anvil/appcast-server.xml`  (embedded in `Anvil Server.app`)

These URLs are hard-coded in `apple/make-app.sh` and `anvil-server/make-app.sh` (override with
`SPARKLE_FEED_URL` if the repo/owner changes).

### 3. App Store & Play Console listings *(only for a future public-store launch — not used today)*

Stores reject automated submissions for an app that has no listing yet — do these once **if/when you
wire the dormant store path**:

- **App Store Connect:** create the app for bundle id `com.gte619n.anvil`, fill metadata (description,
  screenshots, privacy, category). Export compliance is pre-answered via `ITSAppUsesNonExemptEncryption=false`
  in `apple/project.yml`, so submissions aren't held on it.
- **Play Console:** create the app, upload a first AAB manually (or to an internal track) to establish it,
  enrol in **Play App Signing**, complete the store listing + content rating, and grant the service
  account the **Release manager** role. (De-risk a first automated run by temporarily setting
  `track.set("production")` → `"internal"` in `app/build.gradle`.)

### 4. Sparkle signing keys

Generate the EdDSA key pair once (the tool ships in the Sparkle SPM artifact after a build):

```bash
KEYS=$(find apple/.build -path '*/Sparkle/bin/generate_keys' | head -1)
"$KEYS" -x sparkle_priv.key      # writes the private key file; prints the PUBLIC key (base64)
```

Push the private key file (`--sparkle-priv-file`) and the printed public key (`--sparkle-pub`) per step 1.
The public key is embedded into both apps at build time (`SUPublicEDKey`); the private key signs each
update in CI (`sign_update`). Keep the private key safe — losing it breaks auto-update for installed apps.

---

## Verifying before a real release

- **macOS build scripts** (no secrets needed): `ANVIL_MARKETING_VERSION=9.9.9 ANVIL_BUILD_NUMBER=999
  apple/make-app.sh` and `… anvil-server/make-app.sh` produce ad-hoc bundles; check
  `codesign --verify --deep --strict` and `spctl -a -vv`. With `SIGN_ID` + `APPLE_API_KEY_PATH` +
  `SPARKLE_PUBLIC_ED_KEY` set, they notarize and embed the feed.
- **Android (Firebase):** `./gradlew :app:assembleDebug` builds the APK that CI distributes; the
  debug keystore is committed, so no secret is needed to reproduce the build locally.
- **iOS (TestFlight):** the `ios` job in the full release drives `make-ios.sh`. To rehearse the whole
  pipeline against `main`, use **Actions → Full release → Run workflow** rather than merging.
- **Sparkle end-to-end:** install build N, merge a change (build N+1), wait for the `pages` job, then
  "Check for Updates…" in the app should offer the update and verify its EdDSA signature.

> The **Android upload-key / Play** and **App Store submission** steps below are only for a future
> public-store launch — the full release doesn't use them.
