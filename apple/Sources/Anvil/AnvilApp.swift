import SwiftUI

/// Anvil shell (hybrid): hosts the Anvil web client in a WKWebView over Tailscale. Shared by macOS
/// (a window + native menu commands) and iOS/iPadOS (a full-screen scene + APNs push via the app
/// delegate). The web UI is identical on every platform — only the native shell differs.
@main
struct AnvilApp: App {
    #if os(iOS)
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #endif

    var body: some Scene {
        #if os(macOS)
        WindowGroup("Anvil") {
            ContentView()
                .frame(minWidth: 720, minHeight: 480)
        }
        .defaultSize(width: 1180, height: 800)
        .commands {
            CommandGroup(after: .appInfo) {
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
    /// Ask the hosted WebView to deep-link to a session (notification tap). userInfo: ["sessionId": String].
    static let anvilOpenSession = Notification.Name("anvilOpenSession")
}
