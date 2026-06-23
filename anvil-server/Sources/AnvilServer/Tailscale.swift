import Foundation

/// Tailscale integration (the fleet boundary — anvil-server-app.md §3.2). The app detects Tailscale,
/// reads this node's MagicDNS name, and runs `tailscale serve` to expose the daemon (and, during a
/// join, the pairing listener) on the tailnet.
enum Tailscale {
  static func installed() -> Bool { Shell.which("tailscale") != nil }

  /// This node's MagicDNS name (trailing dot stripped), or nil if Tailscale isn't up/logged in.
  static func magicDNSName() -> String? {
    let r = Shell.run("tailscale", ["status", "--json"])
    guard r.ok, let data = r.stdout.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let selfNode = obj["Self"] as? [String: Any],
          let dns = selfNode["DNSName"] as? String, !dns.isEmpty
    else { return nil }
    return dns.hasSuffix(".") ? String(dns.dropLast()) : dns
  }

  /// True when Tailscale reports a logged-in, running backend.
  static func loggedIn() -> Bool {
    let r = Shell.run("tailscale", ["status", "--json"])
    guard r.ok, let data = r.stdout.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return false }
    if let state = obj["BackendState"] as? String { return state == "Running" }
    return obj["Self"] != nil
  }

  /// `tailscale serve --bg --https=<extPort> http://127.0.0.1:<localPort>` (idempotent).
  @discardableResult
  static func serve(externalPort: Int, localPort: Int) -> ShellResult {
    Shell.run("tailscale", ["serve", "--bg", "--https=\(externalPort)", "http://127.0.0.1:\(localPort)"])
  }

  /// Stop serving a given external port (used to tear down the pairing listener after a join).
  @discardableResult
  static func unserve(externalPort: Int) -> ShellResult {
    Shell.run("tailscale", ["serve", "--https=\(externalPort)", "off"])
  }

  /// The https URL the daemon is reachable at on the tailnet, if resolvable.
  static func daemonURL() -> String? {
    magicDNSName().map { "https://\($0):\(Paths.port)/" }
  }
}
