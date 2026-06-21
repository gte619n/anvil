import SwiftUI
import WebKit

/// WKWebView host for the Anvil web client. The UI is bundled in the app and served from a local
/// custom scheme (anvil-app://app/…) so the shell + fonts load offline; the bundled JS connects to
/// the daemon (WS/REST over Tailscale) via the injected window.ANVIL_DAEMON_URL.
struct WebView: NSViewRepresentable {
    let daemonURL: URL

    func makeCoordinator() -> Coordinator { Coordinator(daemonHost: daemonURL.host) }

    func makeNSView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default() // persist localStorage across launches
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true
        cfg.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: Self.scheme)

        // Inject the daemon URL before any page script runs.
        let inject = "window.ANVIL_DAEMON_URL=\(jsString(daemonURL.absoluteString));"
        cfg.userContentController.addUserScript(
            WKUserScript(source: inject, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        let webView = WKWebView(frame: .zero, configuration: cfg)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.load(URLRequest(url: URL(string: "\(Self.scheme)://app/index.html")!))

        NotificationCenter.default.addObserver(forName: .anvilReload, object: nil, queue: .main) { [weak webView] _ in
            webView?.reload()
        }
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}

    private func jsString(_ s: String) -> String {
        let escaped = s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }

    static let scheme = "anvil-app"

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let daemonHost: String?
        init(daemonHost: String?) { self.daemonHost = daemonHost }

        // Keep our bundled UI in the app; open external/daemon links in the default browser.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            let u = navigationAction.request.url
            if navigationAction.navigationType == .linkActivated, let u, u.scheme != WebView.scheme {
                NSWorkspace.shared.open(u)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }
}

/// Serves the bundled web client (Sources/Anvil/web) for anvil-app://app/<path>.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url,
              let webDir = Bundle.module.url(forResource: "web", withExtension: nil)
        else { task.didFailWithError(URLError(.fileDoesNotExist)); return }

        var rel = url.path
        if rel.isEmpty || rel == "/" { rel = "/index.html" }
        let fileURL = webDir.appendingPathComponent(String(rel.drop(while: { $0 == "/" })))

        guard let data = try? Data(contentsOf: fileURL) else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        let resp = URLResponse(url: url, mimeType: mime(for: fileURL.pathExtension), expectedContentLength: data.count, textEncodingName: nil)
        task.didReceive(resp)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func mime(for ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html"
        case "js", "mjs": return "text/javascript"
        case "css": return "text/css"
        case "json", "map": return "application/json"
        case "svg": return "image/svg+xml"
        case "woff2": return "font/woff2"
        case "png": return "image/png"
        case "wasm": return "application/wasm"
        default: return "application/octet-stream"
        }
    }
}
