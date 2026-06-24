import Foundation

/// `/api/health` shape (subset we render). Mirrors `rest.HealthResponse` in anvild/protocol.ts.
struct Health: Codable {
  var ok: Bool
  var subscriptionAuthOk: Bool
  var version: String?
  var serverId: String?
  var serverName: String?
  struct Budget: Codable { var available: Bool?; var warn: Bool? }
  var budget: Budget?
}

/// Drives the headless daemon by shelling `scripts/service.sh` (parity with the documented setup —
/// anvil-server-app.md §3.3) and polling `/api/health`. All `service.sh` calls block, so run them off
/// the main thread; health uses URLSession.
enum Daemon {
  enum Op: String { case install, restart, uninstall, status }

  /// Run a `service.sh` subcommand. Returns the combined output (or an error string if no checkout).
  static func service(_ op: Op, completion: @escaping (ShellResult) -> Void) {
    guard let script = Paths.serviceScript(), let dir = Paths.anvildDir() else {
      completion(ShellResult(code: 1, stdout: "", stderr: "anvild checkout not found — set it in Settings."))
      return
    }
    DispatchQueue.global(qos: .userInitiated).async {
      // service.sh is a bash script; run via bash explicitly so we don't depend on its +x bit.
      let r = Shell.run("bash", [script, op.rawValue], env: ["ANVIL_PORT": String(Paths.port)], cwd: dir)
      DispatchQueue.main.async { completion(r) }
    }
  }

  // Health-check the LOCAL daemon over the right interface for this host's transport: in serve mode
  // it binds loopback (serve fronts the tailnet port), in direct mode it binds the tailnet IP.
  static func healthURL() -> URL {
    let host = Tailscale.serveActive(externalPort: Paths.port) ? "127.0.0.1" : (Tailscale.tailnetIP() ?? "127.0.0.1")
    return URL(string: "http://\(host):\(Paths.port)/api/health")!
  }

  /// Poll `/api/health`. `nil` health = unreachable (daemon down / starting).
  static func fetchHealth(completion: @escaping (Health?) -> Void) {
    var req = URLRequest(url: healthURL())
    req.timeoutInterval = 2.5
    URLSession.shared.dataTask(with: req) { data, _, _ in
      let health = data.flatMap { try? JSONDecoder().decode(Health.self, from: $0) }
      DispatchQueue.main.async { completion(health) }
    }.resume()
  }
}
