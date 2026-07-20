# Anvil CI/CD — build & deployment pipeline

The single reference for **what gets built, where, and what you push to ship it**. The short version:
**every merge to `main` cuts a "full release"** — one version fanned out to all client surfaces at
once. There are no release tags to push and no store submissions to babysit.

> **Accuracy note.** This describes the pipeline **as wired in `.github/workflows/` today**. Where it
> disagrees with older prose in [`RELEASING.md`](../RELEASING.md), this file is authoritative.

---

## The full release

**Trigger: push / merge to `main`** (or a manual run of the workflow). One workflow,
[`release.yml`](../.github/workflows/release.yml) ("Full release"), builds and ships **every client
surface at one shared version**:

| Surface | How it ships | Where it lands |
|---------|--------------|----------------|
| **Android** | signed debug APK → Firebase App Distribution | testers (emails in `app/build.gradle`) |
| **iOS/iPadOS** | archive + upload → TestFlight | testers via TestFlight |
| **macOS client** (`Anvil.app`) | Developer-ID-notarized, Sparkle-signed | GitHub Release zip + appcast → auto-update |
| **macOS server** (`Anvil Server.app`) | Developer-ID-notarized, Sparkle-signed | GitHub Release zip + appcast → auto-update |
| **web PWA** | bundled into every shell above; served by the daemon | rides along — not a separate job |

**Public app stores are deliberately not part of this.** No Play Store production, no App Store
review — we ship to the **test / auto-update channels only** (Firebase, TestFlight, Sparkle). The
store signing + listing setup is preserved in [`RELEASING.md`](../RELEASING.md) if a public launch is
ever wanted, but nothing invokes it.

### Why "the web" isn't its own target

The web client (`anvild/web`) is never deployed standalone. It's **bundled into every native shell**
(`bundle-native.ts`, run inside each build job) **and served by the daemon** from `web/dist`. So a
full release carries the current web UI into all four apps automatically. The browser-facing UI
served over Tailscale updates on a **daemon deploy**, which is a separate channel — see
[The daemon channel](#the-daemon-channel-self-update).

---

## Triggers: what pushing does

| You do this | Workflow(s) | What happens | Ships? |
|-------------|-------------|--------------|--------|
| **Open / update a PR** | `ci.yml`, `codeql.yml` | Typecheck (daemon + web) + `build:web` + `bun test`; CodeQL SAST | ❌ gate only |
| **Merge / push to `main`** | `ci.yml`, `codeql.yml`, **`release.yml`** | Re-runs the gate, then the **full release** to all surfaces | ✅ **everything** |
| **Run `release.yml` manually** (Actions → Run workflow, or `gh workflow run release.yml`) | `release.yml` | Re-fires the full release for the current `main` | ✅ everything |

There are **no release tags** — versioning is automatic (below). `ci.yml` remains the fast PR gate;
`release.yml` re-runs the same checks as its `verify` job so nothing untested can ship.

> **Cost / cadence note.** Every merge to `main` runs **two macOS notarizations + a TestFlight
> upload** (three `macos-15` jobs) plus the Firebase build. That's real runner time, and each iOS
> build consumes a TestFlight build number. If merges get frequent, consider gating the heavy jobs
> (e.g. move macOS/iOS behind `workflow_dispatch` or a path filter) — they're independent jobs in
> `release.yml`, so it's a small change.

---

## The full-release jobs (`release.yml`)

Runs on merge to `main`, in dependency order:

- **meta** *(ubuntu)* — computes the version (`<VERSION>.<run_number>`, e.g. `2.2.47`) and creates a
  GitHub Release tagged `v<version>`. That Release is the stable public URL the macOS Sparkle zips
  are attached to and the appcasts point at. (No tag is pushed by a human; the workflow mints it.)
- **verify** *(ubuntu)* — the merge gate again (`typecheck` + `typecheck:web` + `build:web` +
  `bun test`). Every ship job `needs:` this, so a red suite halts the whole release.
- **android** *(ubuntu)* — builds the debug APK (web re-bundled via `bundleWebAssets`), generates
  grouped release notes from the commits, and uploads to **Firebase App Distribution**.
- **ios** *(macos-15)* — imports the distribution cert/profile and runs `make-ios.sh` to archive +
  upload to **TestFlight**.
- **mac-client** *(macos-15)* — builds, Developer-ID-signs, notarizes, staples `Anvil.app`; attaches
  `Anvil.zip` to the Release; signs it with the Sparkle key.
- **mac-server** *(macos-15)* — same for `Anvil Server.app` → `Anvil-Server.zip`.
- **pages** *(ubuntu)* — updates both Sparkle appcasts and deploys them to GitHub Pages.

**When each goes live:**

- **macOS** — installed apps auto-update via Sparkle **as soon as `pages` finishes**. Appcast URLs
  (embedded at build time): client `https://gte619n.github.io/anvil/appcast.xml`, server
  `https://gte619n.github.io/anvil/appcast-server.xml`.
- **Android / iOS** — available to testers once Firebase/TestFlight finish processing (minutes).

---

## Where builds happen

Everything builds in **GitHub Actions** — nothing ships from a laptop in the normal flow.

| Runner | Jobs |
|--------|------|
| `ubuntu-latest` | `meta`, `verify`, `android` (Firebase), `pages` (appcast deploy); also `ci.yml`, `codeql.yml` |
| `macos-15` | `ios` (TestFlight), `mac-client`, `mac-server` (needs full Xcode + Developer-ID signing) |

Bun is pinned to **1.3.14** in the gate; other jobs use `latest`. Android needs **JDK 21 + Android
SDK**; Apple needs **Xcode 16.x** (why the Apple jobs pin `macos-15`).

`codeql.yml` runs on PRs, pushes to `main`, and weekly — analyzing **only** the TypeScript
daemon/web (Kotlin/Swift shells are covered by review, by design).

---

## Versioning (single source of truth)

`MAJOR.MINOR` lives in **one** file: repo-root [`VERSION`](../VERSION) (currently **`2.2`**). All
build paths read it (`app/build.gradle`, `apple/make-app.sh`, `apple/make-ios.sh`,
`anvil-server/make-app.sh`). The full version is **`MAJOR.MINOR.<run_number>`** (e.g. `2.2.47`),
shared by every job in a run so all four apps report the same number.

**To start a new line, bump `VERSION`** (e.g. `2.2` → `2.3`) and merge it — the next full release is
`2.3.<run_number>`. Nothing else to push. (`apple/project.yml`'s static `MARKETING_VERSION` is only
for raw Xcode dev builds — keep its MAJOR.MINOR in sync by hand.)

---

## How to ship

| I want to… | Do this |
|------------|---------|
| **Ship a full release** (all platforms) | Merge to `main` — automatic |
| **Re-fire a full release** without a new commit | Actions → **Full release** → *Run workflow* (or `gh workflow run release.yml`) |
| **Start a new version line** | Bump [`VERSION`](../VERSION) and merge |
| **Deploy new daemon / browser UI** | `cd anvild && git pull && ./scripts/service.sh restart` (or in-app "Update Anvil") |

That's it for the apps — there is no tag to push and no store console to touch.

---

## The daemon channel (self-update)

The daemon is **not** built or shipped by CI. It runs from TS source under a service manager
(launchd on macOS, systemd `--user` on Linux) and serves the **built** web bundle from `web/dist`.
A deploy = **pull source → rebuild `web/dist` → restart** so the new source is re-read. Two ways:

1. **On the host** (canonical checkout, not a worktree):
   ```bash
   cd anvild && git pull
   ./scripts/service.sh restart      # rebuilds web/dist THEN restarts — a true full deploy
   ```
   A bare restart picks up daemon-code changes but **not** web changes — `restart` runs `build:web`
   first to avoid the "code merged but UI is stale" trap. Verify the web shipped by querying the
   **running daemon**, not the browser (the service worker may cache):
   ```bash
   curl -s http://127.0.0.1:7701/main.js | grep -c <your-string>
   ```
2. **From any client** — the in-app "Update Anvil" / "Restart daemon" button
   (`anvild/src/daemon/selfupdate.ts`) does the same pull + `build:web` + restart remotely. Only
   works when a service manager launched the daemon (not `bun dev`).

This is independent of the app channels: a daemon deploy never updates an installed native shell
(each bundles its own web copy — re-ship it via a full release), and a full release never touches a
running daemon. (Scheduled/nightly autopilot deploys are hub-only.)

---

## The marketing site ([`website/`](../website/))

The public marketing site is a static page hosted on **Firebase Hosting** at
**[anvild.sh](https://anvild.sh)** (default URL `anvild.web.app`), in the **`gte619n-anvil`** GCP
project — separate from the app-release channels above.

| Piece | Where |
|-------|-------|
| Source | [`website/`](../website/) (plain HTML/CSS/JS, no build) + [`firebase.json`](../firebase.json) / [`.firebaserc`](../.firebaserc) |
| Host | Firebase Hosting site `anvild` (project `gte619n-anvil`) |
| Domain | `anvild.sh`, registered at **Porkbun**, DNS delegated to **Cloud DNS** zone `anvild-sh` (same project) |
| DNS records | apex `A → 199.36.158.100` + `TXT hosting-site=anvild` (the records Firebase Hosting requires) |

Deploy (manual for now — the site changes rarely and is not yet wired into CI):

```bash
firebase deploy --only hosting:anvild --project gte619n-anvil
```

> **Not on GitHub Pages.** GitHub Pages (`gte619n.github.io/anvil`) serves **only** the Sparkle
> appcasts; the marketing site lives on Firebase so a custom domain never redirects the app
> auto-update URLs. Nameservers for `anvild.sh` point at Cloud DNS, set once at Porkbun.

---

## Secrets & one-time setup

All secrets live in **Google Secret Manager** (project `gte619n-anvil`) and are mirrored into GitHub
Actions with `scripts/mac-signing/sync-github-secrets.sh`. Full push commands, GitHub Pages setup,
and Sparkle key generation are in [`RELEASING.md`](../RELEASING.md). Which secret feeds which job:

| Secrets | Consumed by |
|---------|-------------|
| `FIREBASE_SERVICE_ACCOUNT` | `android` (Firebase distribution) |
| `IOS_DIST_P12_BASE64`, `IOS_DIST_P12_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64` | `ios` (TestFlight) |
| `APPLE_TEAM_ID`, `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID` | `ios` + both macOS jobs |
| `MAC_DEVELOPER_ID_P12_BASE64`, `MAC_DEVELOPER_ID_P12_PASSWORD` | `mac-client`, `mac-server` |
| `SPARKLE_ED_PRIVATE_KEY`, `SPARKLE_PUBLIC_ED_KEY` | `mac-client`, `mac-server`, `pages` |

The **Android upload key / Play service account** and **App Store Connect submission** secrets in
`RELEASING.md` are only needed if the public-store path is ever wired — the full release doesn't use
them.

---

## Notes / gotchas

- **A full release re-ships the web into every app** — a UI change reaches the browser on the next
  daemon deploy, but reaches a phone/desktop app only when that app is rebuilt (i.e. on merge). This
  is the #1 "my change merged but the app didn't update" source; a full release fixes it for the
  shells, a daemon deploy fixes it for the browser.
- **The daemon is never a CI artifact** — deploys out-of-band (see above).
- **Public stores are intentionally dormant.** The Play Publisher plugin (`app/build.gradle`) and
  `scripts/mac-signing/submit-appstore.ts` still exist but nothing invokes them; ignore them unless
  you're wiring a real store launch.
