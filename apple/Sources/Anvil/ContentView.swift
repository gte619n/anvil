import SwiftUI

enum AppConfig {
    /// Override with: defaults write com.gte619n.anvil anvil.baseURL "https://…:7701/"
    /// HTTPS on the MagicDNS name — the daemon is fronted by `tailscale serve` (service.sh setup_serve).
    /// ts.net forces HTTPS in browsers/WebViews anyway; an App-Store-Tailscale host that can't serve
    /// is reached over plain http by tailnet IP instead (set the override).
    static var baseURL: URL {
        let s = UserDefaults.standard.string(forKey: "anvil.baseURL") ?? "https://mac-mini-m4.softshell-mark.ts.net:7701/"
        return URL(string: s) ?? URL(string: "https://mac-mini-m4.softshell-mark.ts.net:7701/")!
    }
}

struct ContentView: View {
    var body: some View {
        WebView(daemonURL: AppConfig.baseURL)
            .ignoresSafeArea()
    }
}
