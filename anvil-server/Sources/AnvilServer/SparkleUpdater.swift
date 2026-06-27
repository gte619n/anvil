import Sparkle

/// Sparkle auto-update for the **Server.app shell** (which bundles the `anvild` daemon source).
/// Distinct from the daemon's own update paths, which all stay:
///
///   • "Check for Updates…" (here)   → updates Anvil Server.app off the GitHub-hosted appcast.
///   • "Restart daemon" (MenuView)   → restarts the running daemon.
///   • /api/daemon/update (web UI / macOS client) → git-pulls + rebuilds the daemon (dev path).
///
/// Reads SUFeedURL / SUPublicEDKey / SUEnableAutomaticChecks from Info.plist (make-app.sh injects
/// them on release builds). Inert in dev when no feed is configured.
@MainActor
enum AnvilServerSparkle {
    /// Standard updater controller; `startingUpdater: true` begins scheduled background checks the
    /// first time it's touched (AppDelegate does so at launch). Held statically for the process life.
    static let controller = SPUStandardUpdaterController(
        startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil
    )

    /// User-initiated check (the menu command).
    static func checkForUpdates() {
        controller.updater.checkForUpdates()
    }
}
