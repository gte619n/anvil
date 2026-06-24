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

        // Pop-out windows (e.g. the markdown reader "open in its own window"): keep a strong reference
        // to each window, keyed by its web view, so it isn't deallocated while open.
        private var popoutWindows: [WKWebView: NSWindow] = [:]

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

        // window.open(…): the web client uses this to pop the reader into its own window. Returning a
        // real web view (rather than nil) is also what makes window.open() non-null, so the page can
        // document.write its content into it. A target=_blank to an external URL just opens the browser.
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let u = navigationAction.request.url, !u.absoluteString.isEmpty, u.scheme != WebView.scheme {
                NSWorkspace.shared.open(u)
                return nil
            }
            let w = windowFeatures.width?.doubleValue ?? 880
            let h = windowFeatures.height?.doubleValue ?? 920
            let child = WKWebView(frame: NSRect(x: 0, y: 0, width: w, height: h), configuration: configuration)
            child.uiDelegate = self
            child.navigationDelegate = self
            child.allowsBackForwardNavigationGestures = true
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: w, height: h),
                styleMask: [.titled, .closable, .resizable, .miniaturizable],
                backing: .buffered, defer: false
            )
            window.title = "Anvil"
            window.contentView = child
            window.isReleasedWhenClosed = false
            window.center()
            window.makeKeyAndOrderFront(nil)
            popoutWindows[child] = window
            return child
        }

        // window.close() from a pop-out — tear down its window and drop the reference.
        func webViewDidClose(_ webView: WKWebView) {
            popoutWindows[webView]?.close()
            popoutWindows[webView] = nil
        }

        // Reflect the popped-out document's <title> on its window once it renders.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            if let window = popoutWindows[webView], let t = webView.title, !t.isEmpty {
                window.title = t
            }
        }
    }
}

/// Serves the bundled web client (Sources/Anvil/web) for anvil-app://app/<path>.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    /// Where the bundled web client lives. In a packaged Anvil.app the assets are copied to
    /// Contents/Resources/web (see make-app.sh), so prefer Bundle.main; fall back to the SPM
    /// resource bundle (Bundle.module) for `swift run` during development.
    static let webDir: URL? = {
        if let main = Bundle.main.resourceURL?.appendingPathComponent("web", isDirectory: true),
           FileManager.default.fileExists(atPath: main.path) {
            return main
        }
        return Bundle.module.url(forResource: "web", withExtension: nil)
    }()

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, let webDir = Self.webDir
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
