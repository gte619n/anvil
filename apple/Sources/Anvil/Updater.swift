#if os(macOS)
import AppKit
import Foundation

/// Native "Update Server…" affordance (arch §5). Hits the daemon's `POST /api/daemon/update`
/// endpoint — the same self-update the web UI button triggers over the WebSocket — so the Mac
/// app can update + restart the daemon from a menu command without opening Settings. This updates
/// the SERVER process, not the Mac app shell (that's Sparkle's "Check for Updates…").
enum Updater {
    /// Confirm, then POST the update and report the outcome. Called on the main thread from the menu.
    static func runUpdate() {
        let confirm = NSAlert()
        confirm.messageText = "Update the Anvil server?"
        confirm.informativeText = "Pulls the latest daemon version, rebuilds the web UI, and restarts the server. This can take a minute. (To update this Mac app instead, use “Check for Updates…”.)"
        confirm.addButton(withTitle: "Update")
        confirm.addButton(withTitle: "Cancel")
        guard confirm.runModal() == .alertFirstButtonReturn else { return }

        let url = AppConfig.baseURL.appendingPathComponent("api/daemon/update")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 300 // bun install + web build can take a while

        URLSession.shared.dataTask(with: req) { data, _, error in
            DispatchQueue.main.async { presentResult(data: data, error: error) }
        }.resume()
    }

    private static func presentResult(data: Data?, error: Error?) {
        let alert = NSAlert()
        alert.addButton(withTitle: "OK")
        if let error = error {
            alert.messageText = "Update failed"
            alert.informativeText = error.localizedDescription
            alert.alertStyle = .warning
            alert.runModal()
            return
        }
        guard let data = data,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            alert.messageText = "Update failed"
            alert.informativeText = "Unexpected response from the daemon."
            alert.alertStyle = .warning
            alert.runModal()
            return
        }
        let phase = obj["phase"] as? String ?? "error"
        let output = obj["output"] as? String ?? ""
        switch phase {
        case "up-to-date":
            alert.messageText = "Server is up to date"
        case "updated":
            let willRestart = obj["willRestart"] as? Bool ?? false
            alert.messageText = willRestart ? "Server updated — restarting…" : "Server updated (restart to apply)"
        default:
            alert.messageText = "Server update failed"
            alert.alertStyle = .warning
        }
        alert.informativeText = output
        alert.runModal()
    }
}
#endif
