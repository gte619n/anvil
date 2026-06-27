# Releasing Anvil

Anvil has two distribution tiers:

| Tier | Trigger | Android | iOS | macOS client | macOS server |
|------|---------|---------|-----|--------------|--------------|
| **Beta** | push to `main` (Android) / manual (iOS) | Firebase App Distribution (debug APK) | TestFlight (`gh workflow run ios-release.yml`) | — | — |
| **Production** | push a `release-*` tag | Play Store (production, completed rollout) | App Store (auto-submit + auto-release) | Developer-ID notarized + Sparkle | Developer-ID notarized + Sparkle |

Beta is unchanged by this setup. Production is driven entirely by **`.github/workflows/release.yml`**.

## Versioning (single source of truth)

`MAJOR.MINOR` lives in **one** place — the repo-root **`VERSION`** file (currently `2.1`) — and is read
by all four build paths (`app/build.gradle`, `apple/make-app.sh`, `apple/make-ios.sh`,
`anvil-server/make-app.sh`), so every artifact reports the same number.

- **Beta / local builds** → `MAJOR.MINOR.<build>` where `<build>` is the workflow run number
  (e.g. `2.1.47`). The visible version revs on **every** CI build, no hand-editing.
- **Production (`release-*` tag)** → the workflow exports `ANVIL_MARKETING_VERSION` = the exact tag
  number (e.g. `release-2.1.0` → `2.1.0`), which **overrides** the auto scheme so the store version is
  the clean number you tagged. In a single release run all four jobs share one run number, so the
  build numbers match too.

**To start a new line, edit `VERSION`** (e.g. `2.1` → `2.2`); betas immediately become `2.2.<build>`.
Keep `VERSION` at or ahead of your most recent release so betas (previews of the next version) never
sort below a shipped release. The static `MARKETING_VERSION` in `apple/project.yml` is only for raw
Xcode dev builds — keep its MAJOR.MINOR in sync by hand.

## The release ritual

```bash
git tag release-2.1.0
git push origin release-2.1.0
```

The tag's version (`release-2.1.0` → `2.1.0`) becomes the marketing version everywhere; the workflow
run number becomes the build number. Watch the run in the repo's **Actions** tab. Five jobs run:

- **android** — builds a signed AAB and publishes it to the Play **production** track (full rollout).
- **ios** — uploads the build to App Store Connect (also lands in TestFlight), then `submit-appstore.ts`
  creates the App Store version, attaches the build, enables phased release, and submits for review with
  **auto-release after approval**.
- **mac-client** / **mac-server** — build, Developer-ID-sign, notarize, staple, attach the `.zip` to the
  GitHub Release, and sign the update with the Sparkle key.
- **pages** — updates the two Sparkle appcasts and deploys them to GitHub Pages so installed apps update.

> **"Fully automatic" is bounded by store review.** CI submits and arms auto-release, but the public
> release happens by itself only *after* Apple/Google approve the build (hours to days). The macOS
> Sparkle releases are live as soon as the `pages` job finishes.

The dev **"Update Anvil" / "Restart daemon"** affordances (git-pull the daemon) are unchanged — they
update the *daemon*, independent of the store/Sparkle updates that refresh the *app shells*.

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

### 3. App Store & Play Console listings

Stores reject automated submissions for an app that has no listing yet — do these once:

- **App Store Connect:** create the app for bundle id `com.gte619n.anvil`, fill metadata (description,
  screenshots, privacy, category). Export compliance is pre-answered via `ITSAppUsesNonExemptEncryption=false`
  in `apple/project.yml`, so submissions aren't held on it.
- **Play Console:** create the app, upload a first AAB manually (or to an internal track) to establish it,
  enrol in **Play App Signing**, complete the store listing + content rating, and grant the service
  account the **Release manager** role. To de-risk the first automated run, temporarily set
  `track.set("production")` → `"internal"` in `app/build.gradle`, push a tag, confirm, then switch back.

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
- **Android:** `ANVIL_RELEASE_STORE_FILE=… ./gradlew :app:bundleRelease` signs with the upload key.
  Publish to the **internal** track first (step 3) before flipping to production.
- **iOS:** run `ios-release.yml` (TestFlight) first to confirm the upload path, then push a `release-*`
  tag — the App Store version shows "Pending Developer Release" → auto-releases after approval.
- **Sparkle end-to-end:** install build N, push `release-` for N+1, wait for the `pages` job, then
  "Check for Updates…" in the app should offer the update and verify its EdDSA signature.
