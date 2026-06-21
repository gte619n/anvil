# ZellijConnect

A native Android app for connecting to Zellij terminal sessions via the Zellij web client. Built specifically for the Samsung Galaxy Fold 7 running Android 15.

## Features

- **Multi-tab support** - Open multiple Zellij sessions in separate tabs
- **Automatic keyboard switching** - Switches to terminal keyboard (Unexpected Keyboard) when focused, Gboard when unfocused
- **Volume key scrolling** - Use volume buttons to scroll terminal history
- **Keep-alive service** - Maintains WebSocket connections in background
- **Immersive mode** - Hide system bars for maximum terminal space
- **External link handling** - HTTP links open in phone browser
- **Copy/paste support** - Long-press to select and copy text

## Setup

### 1. Configure `local.properties`

Create `local.properties` in the project root (this file is gitignored):

```properties
# Android SDK location
sdk.dir=/path/to/your/android/sdk

# Zellij server configuration
ZELLIJ_BASE_URL=https://your-server:7600
ZELLIJ_GATEWAY_PATH=/gateway

# Zellij authentication token
ZELLIJ_TOKEN=your-token-here

# IME package IDs (verify with: adb shell ime list -s)
TERMINAL_IME_ID=juloo.keyboard2/.Keyboard2
DEFAULT_IME_ID=com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME
```

### 2. Build and Install

```bash
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### 3. Grant Permissions

The app needs `WRITE_SECURE_SETTINGS` for automatic keyboard switching:

```bash
adb shell pm grant com.zellijconnect.app android.permission.WRITE_SECURE_SETTINGS
```

## Volume Key Scrolling

Volume keys can scroll the terminal, but require Zellij keybinding configuration.

### Zellij Configuration

Add to `~/.config/zellij/config.kdl` on your Zellij server:

```kdl
keybinds {
    shared {
        bind "Ctrl Shift Alt k" { ScrollUp; }
        bind "Ctrl Shift Alt j" { ScrollDown; }
    }
}
```

Then restart your Zellij sessions for the config to take effect.

### How it works

- **Volume Up** - Sends `Ctrl+Shift+Alt+K` (scroll up)
- **Volume Down** - Sends `Ctrl+Shift+Alt+J` (scroll down)

## UI Controls

| Control | Action |
|---------|--------|
| **ESC button** | Sends Escape key to terminal |
| **+ button** | Opens new Zellij session tab |
| **Browser button** | Opens phone browser to server:5173 |
| **Fullscreen button** | Toggles immersive mode |
| **X on tab** | Detaches Zellij session and closes tab |
| **Swipe up on tab** | Same as X button |

## Clipboard Integration

ZellijConnect supports bidirectional clipboard sync between Android and your Zellij sessions using OSC 52 escape sequences.

### How it works

- **Paste (Android → Terminal)**: Long-press in terminal → Paste, or use keyboard paste
- **Copy (Terminal → Android)**: Terminal apps using OSC 52 will copy to Android clipboard

### Server-side Configuration

For clipboard sync from terminal to Android, Zellij must forward OSC 52 sequences. This is the default behavior, but ensure your config doesn't override it:

```kdl
# ~/.config/zellij/config.kdl

# Leave copy_command unset to use OSC 52 (default)
# copy_command "pbcopy"  # Don't set this for web client use

copy_clipboard "system"
copy_on_select true
```

### Testing OSC 52

Test clipboard copy from terminal to Android:

```bash
# This should copy "hello" to your Android clipboard
printf '\e]52;c;%s\a' "$(echo -n 'hello' | base64)"
```

### Supported Apps

Apps that use OSC 52 will automatically sync to Android clipboard:
- Neovim (with `set clipboard=unnamedplus`)
- tmux (with `set -g set-clipboard on`)
- vim-oscyank plugin
- Most modern terminal apps with clipboard support

## Building

Requirements:
- Android SDK 35 (Android 15)
- Java 21
- Gradle 8.x

```bash
# Build debug APK
./gradlew assembleDebug

# Build and install
./gradlew installDebug

# View logs
adb logcat -s ZellijConnect:V
```

### Deploying to Firebase App Distribution

**Always bump the version first.** Edit `app/build.gradle` and increase **both**:

- `versionCode` — integer, +1 every deploy (App Distribution orders releases by it).
- `appVersionName` — the user-visible version (e.g. `2.0.1` → `2.0.2`). This is the APK
  `versionName` **and** the version shown next to the "Anvil" title in the app, so testers can
  confirm they're on the latest build.

Then build + upload (emails the testers configured in `firebaseAppDistribution {}`):

```bash
export JAVA_HOME="$HOME/.sdkman/candidates/java/current"   # JDK 21
./gradlew :app:assembleDebug :app:appDistributionUploadDebug
```

Notes:
- `assembleDebug` must run in the same invocation — the upload task doesn't build the APK.
- `bundleWebAssets` rebuilds the web client into the APK, so web changes ship automatically;
  it passes `appVersionName` to the web build as `APP_VERSION`.
- Update `releaseNotes` in `app/build.gradle` to describe what changed.

## Session Status Server (Optional)

The `scripts/` directory contains a session status server that provides:

- List of active Zellij sessions with working directory
- Claude Code activity status and description per session
- Git branch status (uncommitted changes, unpushed commits, worktree detection)
- Session deletion with optional worktree/branch cleanup
- **HTTPS support via Tailscale** for secure remote access from Android

### Quick Install (on Zellij server)

Works on **macOS** and **Linux** — no `sudo` required:

```bash
cd scripts/
./install.sh
```

The installer automatically:
- Installs scripts to `~/.local/bin/`
- Sets up auto-start: macOS LaunchAgent or Linux systemd user service
- Configures Tailscale HTTPS proxy on port 7601
- Adds Claude Code hooks to `~/.claude/settings.json`

```bash
# Update scripts only (no reinstall)
./install.sh --update

# Uninstall
./install.sh --uninstall
```

See `scripts/README.md` for full setup instructions including Linux prerequisites and manual steps.

### Prerequisites

**macOS:** `brew install python3 git zellij`

**Linux:** `sudo apt install python3 git` + [install zellij](https://zellij.dev/documentation/installation)

### API Endpoints

**HTTPS (via Tailscale):**
```
GET https://your-tailscale-host:7601/api/sessions
GET https://your-tailscale-host:7601/api/health
DELETE https://your-tailscale-host:7601/api/sessions/{name}
```

**Local HTTP (testing only):**
```
GET http://localhost:7601/api/sessions
GET http://localhost:7601/api/health
```

Session response includes Claude status, description, and full git info (branch, uncommitted changes, unpushed commit count).

## Architecture

- `MainActivity` - Main UI, tab management, keyboard/volume handling
- `TabManager` - Tab state and SharedPreferences persistence
- `TabAdapter` - RecyclerView adapter for tab strip
- `WebViewPool` - WebView lifecycle and JavaScript bridge
- `IMESwitchManager` - Automatic keyboard switching via Settings.Secure
- `KeepAliveService` - Foreground service with wake lock
- `ConnectionMonitor` - Error detection and retry banner
- `ClipboardBridge` - OSC 52 clipboard sync (Zellij <-> Android)
- `AppConfig` - BuildConfig value access

## License

MIT
