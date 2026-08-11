import XCTest
@testable import Anvil

/// Seed unit-test target for the Apple shell (`swift test`, run by the CI2-1 PR job alongside the
/// same `swift build` make-app.sh uses). Exercises `DeepLink.hash(from:)` — the pure mapping from
/// an incoming `anvil://` / universal-link URL to the web hash fragment the WebView navigates to
/// (push-notification taps and external deep links both ride on it). Grow the suite from here.
final class DeepLinkTests: XCTestCase {
    private func hash(_ s: String) -> String? {
        guard let url = URL(string: s) else { XCTFail("unparseable test URL: \(s)"); return nil }
        return DeepLink.hash(from: url)
    }

    func testCustomSchemeMapsHostAndPathToHash() {
        XCTAssertEqual(hash("anvil://autopilot"), "autopilot")
        XCTAssertEqual(hash("anvil://p/plan-42"), "p/plan-42")
        XCTAssertEqual(hash("anvil://s/sess_abc123"), "s/sess_abc123")
    }

    func testCustomSchemeTrailingSlashOnlyPathIsDropped() {
        XCTAssertEqual(hash("anvil://autopilot/"), "autopilot")
    }

    func testCustomSchemeWithoutHostIsRejected() {
        XCTAssertNil(hash("anvil://"))
    }

    func testUniversalLinkUsesTheFragment() {
        XCTAssertEqual(hash("https://mac-mini.ts.net:7701/#autopilot"), "autopilot")
        XCTAssertEqual(hash("https://mac-mini.ts.net:7701/#s/sess_abc123"), "s/sess_abc123")
    }

    func testURLWithoutFragmentIsUnrecognized() {
        XCTAssertNil(hash("https://mac-mini.ts.net:7701/"))
        XCTAssertNil(hash("https://mac-mini.ts.net:7701/#"))
    }
}
