import SwiftUI
import WebKit

/// WKWebView host for the Anvil web client. Persistent data store (localStorage/cookies),
/// JS enabled, external links open in the default browser, ⌘R reloads.
struct WebView: NSViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(host: url.host) }

    func makeNSView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default() // persist localStorage / cookies across launches
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = false

        let webView = WKWebView(frame: .zero, configuration: cfg)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.load(URLRequest(url: url))

        context.coordinator.webView = webView
        NotificationCenter.default.addObserver(
            forName: .anvilReload, object: nil, queue: .main
        ) { [weak webView] _ in webView?.reload() }
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let host: String?
        weak var webView: WKWebView?
        init(host: String?) { self.host = host }

        // Keep our own origin in the app; open external links in the default browser.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if navigationAction.navigationType == .linkActivated,
               let u = navigationAction.request.url, let h = u.host, h != host {
                NSWorkspace.shared.open(u)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }
}
