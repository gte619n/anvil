import SwiftUI

/// Anvil macOS shell (hybrid): a window hosting the Anvil web client in a WKWebView over
/// Tailscale. Native bits (APNs push) layer on once an Apple Developer account is set up.
@main
struct AnvilApp: App {
    var body: some Scene {
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
    }
}

extension Notification.Name {
    static let anvilReload = Notification.Name("anvilReload")
}
