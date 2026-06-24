// swift-tools-version:6.0
import PackageDescription

// Anvil Server.app — macOS menu-bar control panel that wraps the headless `anvild` daemon
// (design: docs/plans/anvil-server-app.md). Built as a SwiftPM executable so it compiles with the
// Command Line Tools toolchain (no full Xcode required). Language mode v5 to avoid Swift 6 strict-
// concurrency churn in this orchestration-heavy app.
let package = Package(
  name: "AnvilServer",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(
      name: "AnvilServer",
      swiftSettings: [.swiftLanguageMode(.v5)]
    )
  ]
)
