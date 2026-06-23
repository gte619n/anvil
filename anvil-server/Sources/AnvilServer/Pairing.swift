import Foundation
import Network

/// Fleet-join pairing (anvil-server-app.md §4). The JOINER hosts a short-lived HTTP listener
/// (exposed on the tailnet via `tailscale serve --https=7702`) and shows a 6-digit code; the HUB
/// pushes the shared OAuth token to `POST /anvil-pair` with that code. WireGuard encrypts transit and
/// gates reachability to the tailnet; the code is the human-confirmed mutual-intent check.
enum Pairing {
  static func generateCode() -> String { String(format: "%06d", Int.random(in: 0...999_999)) }

  struct PairRequest: Codable { var code: String; var token: String; var fleetName: String?; var hubServerId: String? }
  struct PairReply: Codable { var ok: Bool; var serverId: String?; var serverName: String?; var error: String? }

  // MARK: - Joiner side (receive the token)

  /// Listens on a local port for the hub's pairing push. On a valid code it writes the token via
  /// `onToken` (which should persist + start the daemon) and replies ok. Caller stops it after success
  /// or on cancel. Exposed to the tailnet by the caller via `tailscale serve --https=7702`.
  final class Listener {
    private let expectedCode: String
    private let onToken: (String) -> PairReply   // returns the reply (serverId once started)
    private var listener: NWListener?
    let queue = DispatchQueue(label: "anvil.pairing")
    private(set) var localPort: Int = 0

    init(expectedCode: String, onToken: @escaping (String) -> PairReply) {
      self.expectedCode = expectedCode
      self.onToken = onToken
    }

    /// Start on an OS-assigned local port; returns it (so the caller can `tailscale serve` to it).
    func start() throws -> Int {
      let l = try NWListener(using: .tcp, on: .any)
      listener = l
      l.newConnectionHandler = { [weak self] conn in self?.handle(conn) }
      let sem = DispatchSemaphore(value: 0)
      l.stateUpdateHandler = { state in if case .ready = state { sem.signal() } }
      l.start(queue: queue)
      _ = sem.wait(timeout: .now() + 3)
      localPort = l.port.map { Int($0.rawValue) } ?? 0
      return localPort
    }

    func stop() { listener?.cancel(); listener = nil }

    private func handle(_ conn: NWConnection) {
      conn.start(queue: queue)
      receive(conn, buffer: Data())
    }

    private func receive(_ conn: NWConnection, buffer: Data) {
      conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, done, err in
        guard let self else { return }
        var buf = buffer
        if let data { buf.append(data) }
        if let req = Self.parseRequestIfComplete(buf) {
          self.respond(conn, to: req)
        } else if done || err != nil {
          conn.cancel()
        } else {
          self.receive(conn, buffer: buf)
        }
      }
    }

    private func respond(_ conn: NWConnection, to raw: (method: String, path: String, body: Data)) {
      var reply = PairReply(ok: false, serverId: nil, serverName: nil, error: "bad request")
      if raw.method == "POST", raw.path == "/anvil-pair", let pr = try? JSONDecoder().decode(PairRequest.self, from: raw.body) {
        reply = pr.code == expectedCode
          ? onToken(pr.token)
          : PairReply(ok: false, serverId: nil, serverName: nil, error: "wrong code")
      }
      let bodyData = (try? JSONEncoder().encode(reply)) ?? Data("{\"ok\":false}".utf8)
      var resp = Data("HTTP/1.1 \(reply.ok ? "200 OK" : "400 Bad Request")\r\nContent-Type: application/json\r\nContent-Length: \(bodyData.count)\r\nConnection: close\r\n\r\n".utf8)
      resp.append(bodyData)
      conn.send(content: resp, completion: .contentProcessed { _ in conn.cancel() })
    }

    /// Parse a request once headers + (Content-Length) body have arrived; nil while incomplete.
    static func parseRequestIfComplete(_ buf: Data) -> (method: String, path: String, body: Data)? {
      guard let headerEnd = buf.range(of: Data("\r\n\r\n".utf8)) else { return nil }
      let head = String(decoding: buf[..<headerEnd.lowerBound], as: UTF8.self)
      let lines = head.split(separator: "\r\n")
      guard let reqLine = lines.first else { return nil }
      let parts = reqLine.split(separator: " ")
      guard parts.count >= 2 else { return nil }
      let method = String(parts[0]), path = String(parts[1])
      var contentLength = 0
      for line in lines.dropFirst() where line.lowercased().hasPrefix("content-length:") {
        contentLength = Int(line.split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) ?? 0
      }
      let bodyStart = headerEnd.upperBound
      let have = buf.distance(from: bodyStart, to: buf.endIndex)
      guard have >= contentLength else { return nil }
      let body = buf.subdata(in: bodyStart..<(buf.index(bodyStart, offsetBy: contentLength)))
      return (method, path, body)
    }
  }

  // MARK: - Hub side (push the token)

  /// Push the shared token to a joiner's pairing listener over the tailnet.
  static func pushToken(toHost host: String, code: String, token: String, fleetName: String?, hubServerId: String?, completion: @escaping (Result<PairReply, Error>) -> Void) {
    guard let url = URL(string: "https://\(host):\(Paths.pairingPort)/anvil-pair") else {
      completion(.failure(NSError(domain: "AnvilPair", code: 1, userInfo: [NSLocalizedDescriptionKey: "bad host"])))
      return
    }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.timeoutInterval = 10
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONEncoder().encode(PairRequest(code: code, token: token, fleetName: fleetName, hubServerId: hubServerId))
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
