import Foundation

/// The OAuth-token side of setup (anvil-native-architecture.md §3 — load-bearing). The app captures a
/// subscription `CLAUDE_CODE_OAUTH_TOKEN` and writes it to `~/.config/anvil/env` (chmod 600). It NEVER
/// writes an API key — that would meter billing. The daemon's launcher unsets `ANTHROPIC_API_KEY`, but
/// we also warn if one is present in the user's environment.
enum Auth {
  /// True if a non-empty token is already on disk.
  static func hasToken() -> Bool { (try? readToken()) ?? nil != nil }

  static func readToken() throws -> String? {
    guard let data = FileManager.default.contents(atPath: Paths.configEnv) else { return nil }
    let text = String(decoding: data, as: UTF8.self)
    for line in text.split(separator: "\n") where line.hasPrefix("CLAUDE_CODE_OAUTH_TOKEN=") {
      let v = line.dropFirst("CLAUDE_CODE_OAUTH_TOKEN=".count).trimmingCharacters(in: .whitespaces)
      return v.isEmpty ? nil : v
    }
    return nil
  }

  /// Write `~/.config/anvil/env` with the OAuth token, 0600, parent dir 0700. Refuses an obvious API key.
  static func writeToken(_ token: String) throws {
    let t = token.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty else { throw err("empty token") }
    guard !t.hasPrefix("sk-ant-") else { throw err("that looks like an API key (sk-ant-…); Anvil needs the subscription OAuth token from `claude setup-token`, not an API key (arch §3).") }
    let dir = (Paths.configEnv as NSString).deletingLastPathComponent
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let body = "CLAUDE_CODE_OAUTH_TOKEN=\(t)\n"
    try body.write(toFile: Paths.configEnv, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: Paths.configEnv)
  }

  /// `claude setup-token` needs a browser + TTY, so we launch it in Terminal; the user pastes the
  /// printed token back into the wizard. Returns false if `claude` isn't installed.
  @discardableResult
  static func openSetupTokenInTerminal() -> Bool {
    guard let claude = Shell.which("claude") else { return false }
    let script = "tell application \"Terminal\" to do script \"\(claude) setup-token\"\ntell application \"Terminal\" to activate"
    Shell.run("osascript", ["-e", script])
    return true
  }

  /// Warn if a metered key is visible in the environment (the launcher unsets it for the daemon, but
  /// surfacing it helps the user clean up their shell profile).
  static func apiKeyWarning() -> String? {
    let r = Shell.run("printenv", ["ANTHROPIC_API_KEY"])
    return r.ok && !r.stdout.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      ? "ANTHROPIC_API_KEY is set in your environment — Anvil's launcher unsets it for the daemon, but consider removing it from your shell profile (arch §3)."
      : nil
  }

  private static func err(_ m: String) -> NSError { NSError(domain: "AnvilAuth", code: 1, userInfo: [NSLocalizedDescriptionKey: m]) }
}
