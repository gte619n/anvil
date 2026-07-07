import SwiftUI

/// Anvil shell (hybrid): hosts the Anvil web client in a WKWebView over Tailscale. Shared by macOS
/// (a window + native menu commands) and iOS/iPadOS (a full-screen scene + APNs push via the app
/// delegate). The web UI is identical on every platform — only the native shell differs.
@main
struct AnvilApp: App {
    #if os(iOS)
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #endif

    init() {
        #if os(macOS)
        // Touch the Sparkle controller at launch so its scheduled background update checks start.
        _ = AnvilSparkle.controller
        #endif
    }

    var body: some Scene {
        #if os(macOS)
        WindowGroup("Anvil") {
            ContentView()
                .frame(minWidth: 720, minHeight: 480)
        }
        .defaultSize(width: 1180, height: 800)
        .commands {
            CommandGroup(after: .appInfo) {
                // Updates the app shell itself (Sparkle, off the GitHub appcast).
                Button("Check for Updates…") { AnvilSparkle.checkForUpdates() }
                // Updates the daemon (git pull + rebuild) — the dev "Update Button". Unchanged.
                Button("Update Anvil…") { Updater.runUpdate() }
                    .keyboardShortcut("u", modifiers: .command)
            }
            CommandGroup(after: .toolbar) {
                Button("Reload") { NotificationCenter.default.post(name: .anvilReload, object: nil) }
                    .keyboardShortcut("r", modifiers: .command)
            }
        }
        #else
        WindowGroup {
            ContentView()
        }
        #endif
    }
}

extension Notification.Name {
    /// Ask the hosted WebView to reload (⌘R on macOS).
    static let anvilReload = Notification.Name("anvilReload")
    /// Ask the hosted WebView to deep-link to a web hash (notification tap or external `anvil://` link).
    /// userInfo: ["hash": String] — e.g. "s/<id>", "autopilot", "p/<id>".
    static let anvilOpenDeepLink = Notification.Name("anvilOpenDeepLink")
}
