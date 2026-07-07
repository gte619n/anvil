import SwiftUI
import WebKit

#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// WKWebView host for the Anvil web client, shared by the macOS and iOS/iPadOS shells. The UI is
/// bundled in the app and served from a local custom scheme (anvil-app://app/…) so the shell +
/// fonts load offline; the bundled JS connects to the daemon (WS/REST over Tailscale) via the
/// injected window.ANVIL_DAEMON_URL.
///
/// The struct is platform-agnostic; the `NSViewRepresentable`/`UIViewRepresentable` conformance is
/// added per-platform in the conditional extensions below — both just call `buildWebView`.
struct WebView {
    let daemonURL: URL

    func makeCoordinator() -> Coordinator { Coordinator(daemonHost: daemonURL.host) }

    /// Build the configured WKWebView. Shared by makeNSView / makeUIView.
    fileprivate func buildWebView(_ coordinator: Coordinator) -> WKWebView {
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
        webView.navigationDelegate = coordinator
        webView.uiDelegate = coordinator
        webView.allowsBackForwardNavigationGestures = true
        coordinator.webView = webView
        webView.load(URLRequest(url: URL(string: "\(Self.scheme)://app/index.html")!))

        NotificationCenter.default.addObserver(forName: .anvilReload, object: nil, queue: .main) { [weak webView] _ in
            webView?.reload()
        }
        // A notification tap or an external deep link (warm app) asks us to route to a hash (a session,
        // the autopilot grid, a plan). Cold launches are handled in the Coordinator's didFinish
        // (DeepLink.consume) once the page is ready.
        NotificationCenter.default.addObserver(forName: .anvilOpenDeepLink, object: nil, queue: .main) { [weak coordinator] note in
            if let hash = note.userInfo?["hash"] as? String { coordinator?.openHash(hash) }
        }
        return webView
    }

    private func jsString(_ s: String) -> String {
        let escaped = s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }

    static let scheme = "anvil-app"

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let daemonHost: String?
        weak var webView: WKWebView?
        init(daemonHost: String?) { self.daemonHost = daemonHost }

        #if os(macOS)
        // Pop-out windows (e.g. the markdown reader "open in its own window"): keep a strong reference
        // to each window, keyed by its web view, so it isn't deallocated while open. macOS only — iOS
        // doesn't host child NSWindows.
        private var popoutWindows: [WKWebView: NSWindow] = [:]
        #endif

        /// Route the web client to a hash fragment (without the leading '#') — a session (`s/<id>`), the
        /// autopilot grid (`autopilot`), or a plan (`p/<id>`). If already there, re-fire hashchange so the
        /// web app re-focuses. Used by notification taps and external deep links.
        func openHash(_ hash: String) {
            guard let webView else { return }
            let safe = hash.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
            let js = """
            (function(h){if(location.hash.slice(1)===h){window.dispatchEvent(new HashChangeEvent('hashchange'));}else{location.hash=h;}})('\(safe)')
            """
            webView.evaluateJavaScript(js)
        }
        /// Convenience for the push path: route to a session by id.
        func openSession(_ id: String) { openHash("s/\(id)") }

        // Keep our bundled UI in the app; open external/daemon links in the default browser.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            let u = navigationAction.request.url
            if navigationAction.navigationType == .linkActivated, let u, u.scheme != WebView.scheme {
                openExternal(u)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        private func openExternal(_ url: URL) {
            #if os(macOS)
            NSWorkspace.shared.open(url)
            #else
            UIApplication.shared.open(url)
            #endif
        }

        // On cold launch a pending deep-link (from a notification tap that started the app) is routed
        // once the page has loaded.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            #if os(macOS)
            if let window = popoutWindows[webView], let t = webView.title, !t.isEmpty {
                window.title = t
            }
            #endif
            if let pending = DeepLink.consume() { openHash(pending) }
        }

        // window.open(…): the web client uses this to pop the reader into its own window.
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            // External target=_blank → open in the system browser on either platform.
            if let u = navigationAction.request.url, !u.absoluteString.isEmpty, u.scheme != WebView.scheme {
                openExternal(u)
                return nil
            }
            #if os(macOS)
            // Returning a real web view (rather than nil) is what makes window.open() non-null, so the
            // page can document.write its content into a new NSWindow.
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
            #else
            // iOS has no child-window model; the reader opens in-place (return nil → no new view).
            return nil
            #endif
        }

        #if os(macOS)
        // window.close() from a pop-out — tear down its window and drop the reference.
        func webViewDidClose(_ webView: WKWebView) {
            popoutWindows[webView]?.close()
            popoutWindows[webView] = nil
        }
        #endif
    }
}

/// Cross-platform deep-link hand-off (push notification tap OR an external `anvil://` / universal link)
/// to the WebView. The source sets `pending` (and posts `.anvilOpenDeepLink` for the warm-app case);
/// the WebView consumes `pending` on its next `didFinish` for the cold-launch case. The payload is a web
/// hash fragment without the leading '#': `s/<id>`, `autopilot`, or `p/<id>`.
enum DeepLink {
    private static var pendingHash: String?

    /// Route to an arbitrary hash (autopilot grid, plan, session).
    static func open(hash: String) {
        pendingHash = hash
        NotificationCenter.default.post(name: .anvilOpenDeepLink, object: nil, userInfo: ["hash": hash])
    }
    /// Convenience for the push path.
    static func open(sessionId: String) { open(hash: "s/\(sessionId)") }
    static func consume() -> String? {
        defer { pendingHash = nil }
        return pendingHash
    }

    /// Map an incoming URL to a web hash fragment (no leading '#'), or nil if unrecognized.
    ///  - Custom scheme: `anvil://autopilot`, `anvil://p/<id>`, `anvil://s/<id>`.
    ///  - Universal/browser link: the target lives in the URL fragment (`https://host/#autopilot`).
    static func hash(from url: URL) -> String? {
        if url.scheme == "anvil" {
            guard let host = url.host, !host.isEmpty else { return nil }
            let path = (url.path == "/" ? "" : url.path)
            return host + path
        }
        if let fragment = url.fragment, !fragment.isEmpty { return fragment }
        return nil
    }
}

#if os(macOS)
extension WebView: NSViewRepresentable {
    func makeNSView(context: Context) -> WKWebView { buildWebView(context.coordinator) }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
#else
extension WebView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView { buildWebView(context.coordinator) }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
#endif

/// Serves the bundled web client (Sources/Anvil/web) for anvil-app://app/<path>.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    /// Where the bundled web client lives. In a packaged app the assets are copied next to the
    /// executable (macOS: Contents/Resources/web via make-app.sh; iOS: the app bundle Resources via
    /// the xcodegen folder reference), so prefer Bundle.main; fall back to the SPM resource bundle
    /// (Bundle.module) for `swift run` during development. Bundle.module only exists under SwiftPM —
    /// the Xcode app targets (iOS + macOS via project.yml) compile without it, using Bundle.main.
    static let webDir: URL? = {
        if let main = Bundle.main.resourceURL?.appendingPathComponent("web", isDirectory: true),
           FileManager.default.fileExists(atPath: main.path) {
            return main
        }
        #if SWIFT_PACKAGE
        return Bundle.module.url(forResource: "web", withExtension: nil)
        #else
        return nil
        #endif
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
