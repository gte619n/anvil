#if os(macOS)
import Sparkle

/// Sparkle auto-update for the macOS **app shell** (`Anvil.app`), for release builds installed
/// outside the Mac App Store. This is deliberately separate from `Updater.swift`:
///
///   • "Check for Updates…" (here)      → updates Anvil.app itself off the GitHub-hosted appcast.
///   • "Update Anvil…" (Updater.swift)  → git-pulls + rebuilds the **daemon** (the dev "Update
///                                         Button"), via the server's /api/daemon/update endpoint.
///
/// Both coexist; they update different things. The updater reads SUFeedURL / SUPublicEDKey /
/// SUEnableAutomaticChecks from Info.plist (make-app.sh injects them on release builds). In dev
/// (`swift run`, no feed configured) Sparkle stays inert, so this is harmless there.
enum AnvilSparkle {
    /// The standard updater controller. `startingUpdater: true` begins Sparkle's scheduled
    /// background checks as soon as this is first touched (AnvilApp does so at launch). Held in a
    /// `static let` so it lives for the whole process.
    static let controller = SPUStandardUpdaterController(
        startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil
    )

    /// User-initiated check (the menu command).
    static func checkForUpdates() {
        controller.updater.checkForUpdates()
    }
}
#endif
