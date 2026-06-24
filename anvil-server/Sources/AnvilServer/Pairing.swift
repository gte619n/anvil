import Foundation
import Network

/// Fleet join + token rotation (anvil-server-app.md §4 + §4.4). A member runs a persistent
/// fleet-control HTTP listener, exposed on the tailnet via `tailscale serve --https=7702`. Two routes:
///   POST /anvil-pair   — first join: gated by a one-time 6-digit code (+ same-tailnet-user).
///   POST /anvil-token  — rotation: gated by identity (same tailnet user AND the hub serverId recorded
///                        at join) — no code, so the hub can push a refreshed token unattended.
/// Identity comes from the `Tailscale-User-Login` header `tailscale serve` injects on the proxied
/// request (TLS terminates at tailscaled → the socket peer is localhost, so we trust the header).
enum Pairing {
  static func generateCode() -> String { String(format: "%06d", Int.random(in: 0...999_999)) }

  struct PairRequest: Codable { var code: String?; var token: String; var fleetName: String?; var hubServerId: String? }
  struct PairReply: Codable { var ok: Bool; var serverId: String?; var serverName: String?; var error: String? }

  /// What the receiver does with an accepted token (write env, start/restart the daemon). Returns the
  /// reply (e.g. this member's serverId once known). Runs on the listener queue.
  typealias TokenSink = (_ token: String, _ hubServerId: String?) -> PairReply

  // MARK: - Member side: persistent fleet-control listener

  // Shared across the main thread (arm/start/stop) and its own listener queue (request handling);
  // mutable state (`armedCode`) is read/written only on `queue`, so the cross-thread sharing is safe.
  final class FleetControl: @unchecked Sendable {
    static let recordedHubKey = "fleetHubServerId"
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "anvil.fleet")
    private let onPair: TokenSink
    private let onRotate: TokenSink
    private(set) var localPort = 0

    /// A live join window: the expected code (nil when not joining). Set via `arm`, cleared on success.
    private var armedCode: String?

    /// The hub this Mac was joined by (persisted) — authorizes later rotation pushes.
    static var recordedHubId: String? {
      get { UserDefaults.standard.string(forKey: recordedHubKey) }
      set { UserDefaults.standard.set(newValue, forKey: recordedHubKey) }
    }

    init(onPair: @escaping TokenSink, onRotate: @escaping TokenSink) {
      self.onPair = onPair
      self.onRotate = onRotate
    }

    /// Start the listener and expose :7702 on the tailnet. Idempotent-ish (no-op if already started).
    @discardableResult
    func start() -> Bool {
      guard listener == nil else { return true }
      guard let l = try? NWListener(using: .tcp, on: .any) else { return false }
      listener = l
      l.newConnectionHandler = { [weak self] c in self?.handle(c) }
      let sem = DispatchSemaphore(value: 0)
      l.stateUpdateHandler = { if case .ready = $0 { sem.signal() } }
      l.start(queue: queue)
      _ = sem.wait(timeout: .now() + 3)
      localPort = l.port.map { Int($0.rawValue) } ?? 0
      if localPort > 0 { Tailscale.serve(externalPort: Paths.pairingPort, localPort: localPort) }
      return localPort > 0
    }

    func stop() {
      listener?.cancel(); listener = nil
      Tailscale.unserve(externalPort: Paths.pairingPort)
    }

    /// Open a join window with a fresh code (returned for display). Auto-disarms on success.
    /// `armedCode` is mutated on `queue` so it never races the request handlers that read it.
    func arm() -> String { let c = generateCode(); queue.sync { armedCode = c }; return c }
    func disarm() { queue.sync { armedCode = nil } }

    private func handle(_ c: NWConnection) {
      c.start(queue: queue)
      receive(c, buffer: Data())
    }

    private func receive(_ c: NWConnection, buffer: Data) {
      c.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, done, err in
        guard let self else { return }
        var buf = buffer
        if let data { buf.append(data) }
        if let req = HTTP.parse(buf) {
          self.respond(c, req)
        } else if done || err != nil {
          c.cancel()
        } else {
          self.receive(c, buffer: buf)
        }
      }
    }

    private func respond(_ c: NWConnection, _ req: HTTP.Request) {
      var reply = PairReply(ok: false, serverId: nil, serverName: nil, error: "bad request")
      let peerLogin = req.headers["tailscale-user-login"]
      let sameUser = Tailscale.isSameUser(peerLogin)
      if req.method == "POST", let pr = try? JSONDecoder().decode(PairRequest.self, from: req.body) {
        switch req.path {
        case "/anvil-pair":
          // First join: the 6-digit code is the gate; if the header IS present it must match (a
          // wrong-user request is rejected even with a guessed code). Absent header → code-only.
          if let code = armedCode, pr.code == code, peerLogin == nil || sameUser {
            FleetControl.recordedHubId = pr.hubServerId
            reply = onPair(pr.token, pr.hubServerId)
            if reply.ok { armedCode = nil } // already on `queue` (respond) — set directly, don't re-enter sync
          } else {
            reply.error = armedCode == nil ? "not accepting pairings" : (sameUser || peerLogin == nil ? "wrong code" : "different tailnet user")
          }
        case "/anvil-token":
          // Rotation: identity-only. Require same tailnet user AND the hub we were joined by.
          if sameUser, let hub = FleetControl.recordedHubId, pr.hubServerId == hub {
            reply = onRotate(pr.token, pr.hubServerId)
          } else {
            reply.error = !sameUser ? "untrusted tailnet user" : "unknown hub"
          }
        default:
          reply.error = "no such route"
        }
      }
      c.send(content: HTTP.response(json: reply, ok: reply.ok), completion: .contentProcessed { _ in c.cancel() })
    }
  }

  // MARK: - Hub side: push to a member

  /// First-join push (code-gated) to a joiner's /anvil-pair.
  static func pushPair(toHost host: String, code: String, token: String, fleetName: String?, hubServerId: String?, completion: @escaping (Result<PairReply, Error>) -> Void) {
    post(host: host, path: "/anvil-pair", body: PairRequest(code: code, token: token, fleetName: fleetName, hubServerId: hubServerId), completion: completion)
  }

  /// Rotation push (identity-gated) to a known member's /anvil-token.
  static func pushToken(toHost host: String, token: String, hubServerId: String?, completion: @escaping (Result<PairReply, Error>) -> Void) {
    post(host: host, path: "/anvil-token", body: PairRequest(code: nil, token: token, fleetName: nil, hubServerId: hubServerId), completion: completion)
  }

  private static func post(host: String, path: String, body: PairRequest, completion: @escaping (Result<PairReply, Error>) -> Void) {
    guard let url = URL(string: "https://\(host):\(Paths.pairingPort)\(path)") else {
      completion(.failure(NSError(domain: "AnvilPair", code: 1, userInfo: [NSLocalizedDescriptionKey: "bad host"])))
      return
    }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.timeoutInterval = 12
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONEncoder().encode(body)
    URLSession.shared.dataTask(with: req) { data, _, err in
      DispatchQueue.main.async {
        if let err { completion(.failure(err)); return }
        guard let data, let reply = try? JSONDecoder().decode(PairReply.self, from: data) else {
          completion(.failure(NSError(domain: "AnvilPair", code: 2, userInfo: [NSLocalizedDescriptionKey: "no/invalid response"])))
          return
        }
        completion(.success(reply))
      }
    }.resume()
  }
}

/// Minimal HTTP/1.1 request parse + response build (no deps) for the pairing listener.
enum HTTP {
  struct Request { var method: String; var path: String; var headers: [String: String]; var body: Data }

  static func parse(_ buf: Data) -> Request? {
    guard let headerEnd = buf.range(of: Data("\r\n\r\n".utf8)) else { return nil }
    let head = String(decoding: buf[..<headerEnd.lowerBound], as: UTF8.self)
    let lines = head.components(separatedBy: "\r\n")
    guard let reqLine = lines.first else { return nil }
    let parts = reqLine.split(separator: " ")
    guard parts.count >= 2 else { return nil }
    var headers: [String: String] = [:]
    for line in lines.dropFirst() {
      guard let colon = line.firstIndex(of: ":") else { continue }
      let k = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
      let v = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
      headers[k] = v
    }
    let contentLength = Int(headers["content-length"] ?? "0") ?? 0
    let bodyStart = headerEnd.upperBound
    guard buf.distance(from: bodyStart, to: buf.endIndex) >= contentLength else { return nil }
    let body = buf.subdata(in: bodyStart..<buf.index(bodyStart, offsetBy: contentLength))
    return Request(method: String(parts[0]), path: String(parts[1]), headers: headers, body: body)
  }

  static func response<T: Encodable>(json: T, ok: Bool) -> Data {
    let bodyData = (try? JSONEncoder().encode(json)) ?? Data("{\"ok\":false}".utf8)
    var resp = Data("HTTP/1.1 \(ok ? "200 OK" : "400 Bad Request")\r\nContent-Type: application/json\r\nContent-Length: \(bodyData.count)\r\nConnection: close\r\n\r\n".utf8)
    resp.append(bodyData)
    return resp
  }
}

// MARK: - Hub-side fleet membership registry (anvil-server-app.md §6)

/// A joined fleet member, persisted by the hub so it can list the fleet and push token rotations.
struct FleetMember: Codable, Identifiable {
  var serverId: String
  var serverName: String
  var host: String     // tailnet MagicDNS host (for :7702 pushes)
  var url: String      // https://host:7701 (for the client)
  var id: String { serverId }
}

/// The hub's source of truth for *administration* (token distribution). Distinct from the client's
/// session-connection registry (multi-server §4). Persisted in UserDefaults (small, app-local).
enum FleetRegistry {
  private static let key = "fleetMembers"

  static func all() -> [FleetMember] {
    guard let data = UserDefaults.standard.data(forKey: key) else { return [] }
    return (try? JSONDecoder().decode([FleetMember].self, from: data)) ?? []
  }
  static func record(_ m: FleetMember) {
    var list = all().filter { $0.serverId != m.serverId && $0.host != m.host }
    list.append(m)
    save(list)
  }
  static func remove(serverId: String) { save(all().filter { $0.serverId != serverId }) }
  private static func save(_ list: [FleetMember]) {
    if let data = try? JSONEncoder().encode(list) { UserDefaults.standard.set(data, forKey: key) }
  }
}
