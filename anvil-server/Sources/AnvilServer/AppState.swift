import Foundation
import Combine
import AppKit

/// Observable state for the menu bar + wizard. Polls `/api/health`, exposes setup status, and runs
/// the daemon control actions. `@MainActor` because every published mutation drives SwiftUI.
@MainActor
final class AppState: ObservableObject {
  enum Phase { case needsSetup, stopped, starting, running, authError }

  @Published var health: Health?
  @Published var reachable = false
  @Published var busy: String?          // a label while an action runs
  @Published var lastMessage: String?   // transient status/error line

  // Window-opening hooks, wired by the AppDelegate (the menu/popover triggers these).
  var openWizard: (() -> Void)?
  var openAddMac: (() -> Void)?

  /// Persistent fleet-control listener (anvil-server-app.md §4.4). Its token sinks are self-contained
  /// (write env + start the daemon via free functions) so they run safely off the main actor.
  let fleet = Pairing.FleetControl(
    onPair: { token, _ in AppState.acceptFleetToken(token) },
    onRotate: { token, _ in AppState.acceptFleetToken(token) }
  )

  /// Persist the token and (re)start the daemon. Used by both pairing routes; nonisolated by design.
  nonisolated static func acceptFleetToken(_ token: String) -> Pairing.PairReply {
    do { try Auth.writeToken(token) } catch {
      return Pairing.PairReply(ok: false, serverId: nil, serverName: nil, error: "could not save token — \(error.localizedDescription)")
    }
    Daemon.service(.install) { _ in } // service.sh sets up the transport (serve → https, else tailnet-IP http)
    return Pairing.PairReply(ok: true, serverId: nil, serverName: Tailscale.magicDNSName(), error: nil)
  }

  var isFleetMember: Bool { Pairing.FleetControl.recordedHubId != nil }
  var myServerId: String? { health?.serverId }

  private var timer: Timer?

  var hasToken: Bool { Auth.hasToken() }
  var hasCheckout: Bool { Paths.anvildDir() != nil }
  var serverName: String { health?.serverName ?? Tailscale.magicDNSName() ?? "this Mac" }
  var daemonURL: String? { Tailscale.daemonURL() }

  var phase: Phase {
    if !hasToken || !hasCheckout { return .needsSetup }
    guard let h = health, reachable else { return busy != nil ? .starting : .stopped }
    return h.subscriptionAuthOk ? .running : .authError
  }

  func startPolling() {
    poll()
    timer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.poll() }
    }
  }

  func poll() {
    Daemon.fetchHealth { [weak self] h in
      guard let self else { return }
      self.health = h
      self.reachable = h != nil
    }
  }

  // MARK: - Actions

  func install() { run("Starting Anvil…", .install) }
  func restart() { run("Restarting…", .restart) }
  func uninstall() { run("Stopping…", .uninstall) }

  private func run(_ label: String, _ op: Daemon.Op) {
    busy = label
    Daemon.service(op) { [weak self] r in
      guard let self else { return }
      self.busy = nil
      self.lastMessage = r.ok ? nil : r.combined
      self.poll()
    }
  }

  /// Best-effort `tailscale serve` so the daemon is reachable over HTTPS on the MagicDNS name (browsers
  /// force HTTPS on ts.net). `service.sh setup_serve` is the authority during install/restart; this is a
  /// fallback for when the app manages the host directly (e.g. Tailscale logs in after install). Harmless
  /// and idempotent; on the sandboxed App Store Tailscale it simply fails and the daemon stays on plain
  /// HTTP at the tailnet IP.
  func ensureServe() {
    let port = Paths.port
    DispatchQueue.global().async { Tailscale.serve(externalPort: port, localPort: port) }
  }

  // MARK: - Fleet (join + rotation)

  /// A joined member listens for rotation pushes at launch; call from the AppDelegate.
  func startFleetControlIfMember() {
    guard isFleetMember else { return }
    let f = fleet
    DispatchQueue.global().async { f.start() }
  }

  /// Open a join window: bind the pairing listener and return the code + whether it actually bound.
  /// (Binding a local port is instant — no `tailscale serve` to wait on anymore.)
  func armJoin() -> (code: String, listening: Bool) {
    let listening = fleet.start()
    return (fleet.arm(), listening)
  }

  /// Close a join window; stop listening if this Mac isn't (yet) a fleet member.
  func cancelJoin() {
    fleet.disarm()
    if !isFleetMember { let f = fleet; DispatchQueue.global().async { f.stop() } }
  }

  /// Record a Mac the hub just paired (so we can push token rotations to it later).
  func recordMember(host: String, reply: Pairing.PairReply) {
    let sid = reply.serverId ?? host
    FleetRegistry.record(FleetMember(serverId: sid, serverName: reply.serverName ?? host, host: host, url: "https://\(host):\(Paths.port)/"))
  }

  /// Re-login refreshed the shared token: push it to every known member (§4.4). Best-effort.
  func rotateFleet(token: String, report: @escaping (String) -> Void) {
    let members = FleetRegistry.all()
    guard !members.isEmpty else { report("No other Macs in the fleet to update."); return }
    let hubId = myServerId
    var done = 0, okCount = 0
    for m in members {
      Pairing.pushToken(toHost: m.host, token: token, hubServerId: hubId) { result in
        done += 1
        if case .success(let r) = result, r.ok { okCount += 1 }
        if done == members.count { report("Updated \(okCount)/\(members.count) fleet Macs.") }
      }
    }
  }

  func openClient() {
    guard let urlStr = daemonURL, let url = URL(string: urlStr) else {
      lastMessage = "No tailnet URL yet — is Tailscale logged in?"
      return
    }
    NSWorkspace.shared.open(url)
  }
}
