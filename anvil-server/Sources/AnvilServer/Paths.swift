import Foundation

/// Filesystem locations + the daemon checkout the app drives. Mirrors `service.sh` (anvil-server-app.md
/// §3.3). `anvildDir` is where the `anvild` source + `scripts/service.sh` live; in a packaged .app it's
/// `…/Contents/Resources/anvild`, in dev it's the repo checkout (overridable via the `ANVILD_DIR` env
/// var or a stored setting).
enum Paths {
  static var home: String { NSHomeDirectory() }
  static var configEnv: String { home + "/.config/anvil/env" }       // CLAUDE_CODE_OAUTH_TOKEN, chmod 600
  static var stateDir: String { home + "/.local/state/anvil" }

  /// The bundled daemon checkout, if shipped in Resources/anvild.
  static var bundledAnvild: String? {
    let p = Bundle.main.resourcePath.map { $0 + "/anvild" }
    return p.flatMap { FileManager.default.fileExists(atPath: $0 + "/scripts/service.sh") ? $0 : nil }
  }

  /// Resolve the daemon dir: explicit setting → env → bundled → a dev-checkout guess.
  static func anvildDir() -> String? {
    if let s = UserDefaults.standard.string(forKey: "anvildDir"), valid(s) { return s }
    if let e = ProcessInfo.processInfo.environment["ANVILD_DIR"], valid(e) { return e }
    if let b = bundledAnvild { return b }
    for guess in [home + "/Development/zellij-android/anvild"] where valid(guess) { return guess }
    return nil
  }
  static func setAnvildDir(_ dir: String) { UserDefaults.standard.set(dir, forKey: "anvildDir") }

  static func valid(_ dir: String) -> Bool {
    FileManager.default.fileExists(atPath: dir + "/scripts/service.sh")
  }
  static func serviceScript() -> String? { anvildDir().map { $0 + "/scripts/service.sh" } }

  static var port: Int { Int(ProcessInfo.processInfo.environment["ANVIL_PORT"] ?? "") ?? 7701 }
  static var pairingPort: Int { 7702 } // short-lived fleet-join listener (anvil-server-app.md §4.2)
}
