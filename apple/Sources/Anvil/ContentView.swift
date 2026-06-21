import SwiftUI

enum AppConfig {
    /// Override with: defaults write com.gte619n.anvil anvil.baseURL "https://…:7701/"
    static var baseURL: URL {
        let s = UserDefaults.standard.string(forKey: "anvil.baseURL") ?? "https://mac-mini-m4.softshell-mark.ts.net:7701/"
        return URL(string: s) ?? URL(string: "https://mac-mini-m4.softshell-mark.ts.net:7701/")!
    }
}

struct ContentView: View {
    var body: some View {
        WebView(url: AppConfig.baseURL)
            .ignoresSafeArea()
    }
}
