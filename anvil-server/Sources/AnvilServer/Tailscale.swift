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

  /// True if `tailscale serve` is currently fronting `externalPort` (HTTPS on the MagicDNS name).
  /// When true the daemon is reached over https on the name; when false it binds the tailnet IP
  /// directly over plain http. Mirrors service.sh's `setup_serve` decision.
  static func serveActive(externalPort: Int) -> Bool {
    let r = Shell.run("tailscale", ["serve", "status"])
    return r.ok && r.stdout.contains(":\(externalPort)")
  }

  /// This host's Tailscale IPv4 (100.64.0.0/10) from the network interfaces — no `tailscale` CLI
  /// needed. The daemon binds this directly, so it's reachable over the tailnet via plain HTTP.
  static func tailnetIP() -> String? {
    var ptr: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&ptr) == 0, let first = ptr else { return nil }
    defer { freeifaddrs(ptr) }
    var cur: UnsafeMutablePointer<ifaddrs>? = first
    while let c = cur {
      let ifa = c.pointee
      if let addr = ifa.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET) {
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        if getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
          let ip = String(cString: host)
          let o = ip.split(separator: ".").compactMap { Int($0) }
          if o.count == 4, o[0] == 100, o[1] >= 64, o[1] <= 127 { return ip }
        }
      }
      cur = ifa.ifa_next
    }
    return nil
  }

  /// The URL the daemon is reachable at on the tailnet, matching this host's transport: if
  /// `tailscale serve` is fronting the port, https on the MagicDNS name (browser-friendly — ts.net
  /// forces HTTPS anyway); otherwise plain http on the tailnet IP (the name can't be used over http
  /// in a browser, so prefer the IP for the direct-bind case).
  static func daemonURL() -> String? {
    if serveActive(externalPort: Paths.port), let name = magicDNSName() {
      return "https://\(name):\(Paths.port)/"
    }
    return (tailnetIP() ?? magicDNSName()).map { "http://\($0):\(Paths.port)/" }
  }

  /// This node's tailnet login (owner), e.g. "evan@example.com" — used to gate pairing to same-user.
  static func selfLogin() -> String? {
    let r = Shell.run("tailscale", ["status", "--json"])
    guard r.ok, let data = r.stdout.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let selfNode = obj["Self"] as? [String: Any],
          let uid = selfNode["UserID"] as? Int,
          let users = obj["User"] as? [String: Any],
          let user = users[String(uid)] as? [String: Any],
          let login = user["LoginName"] as? String
    else { return nil }
    return login
  }

  /// The tailnet login that owns the node at `ip` (`tailscale whois`), or nil if unknown.
  static func whoisLogin(ip: String) -> String? {
    let r = Shell.run("tailscale", ["whois", "--json", ip])
    guard r.ok, let data = r.stdout.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let prof = obj["UserProfile"] as? [String: Any],
          let login = prof["LoginName"] as? String
    else { return nil }
    return login
  }

  /// Defense-in-depth for pairing (anvil-server-app.md §4.3). Now that the joiner listens directly on
  /// the tailnet (no `serve` proxy), it sees the caller's real IP — so we `whois` it and compare to
  /// this Mac's owner. `.unknown` when whois can't resolve (caller decides whether to fall back to the code).
  enum PeerTrust { case sameUser, otherUser, unknown }
  static func peerTrust(ip: String) -> PeerTrust {
    guard let mine = selfLogin() else { return .unknown }
    guard let theirs = whoisLogin(ip: ip) else { return .unknown }
    return theirs.caseInsensitiveCompare(mine) == .orderedSame ? .sameUser : .otherUser
  }
}
