// swift-tools-version:6.0
import PackageDescription

// Anvil Server.app — macOS menu-bar control panel that wraps the headless `anvild` daemon
// (design: docs/plans/anvil-server-app.md). Built as a SwiftPM executable so it compiles with the
// Command Line Tools toolchain (no full Xcode required). Language mode v5 to avoid Swift 6 strict-
// concurrency churn in this orchestration-heavy app.
let package = Package(
  name: "AnvilServer",
  platforms: [.macOS(.v14)],
  dependencies: [
    // Auto-update for the Server.app shell (which ships the daemon source inside it). make-app.sh
    // embeds + signs Sparkle.framework; SparkleUpdater.swift wires the "Check for Updates…" item.
    // Separate from the daemon git self-update ("Restart daemon" / /api/daemon/update), which stays.
    .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0")
  ],
  targets: [
    .executableTarget(
      name: "AnvilServer",
      dependencies: [.product(name: "Sparkle", package: "Sparkle")],
      swiftSettings: [.swiftLanguageMode(.v5)]
    )
  ]
)
