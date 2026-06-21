// swift-tools-version:5.9
import PackageDescription

// Compile-check / quick-run target for the macOS shell. The shippable, bundled app is
// generated via project.yml (XcodeGen) and built in Xcode — see apple/README.md.
let package = Package(
    name: "Anvil",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "Anvil", path: "Sources/Anvil"),
    ]
)
