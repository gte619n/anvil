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

  /// Ensure `tailscale serve` exposes the daemon, then report the URL.
  func ensureServe() {
    DispatchQueue.global().async {
      Tailscale.serve(externalPort: Paths.port, localPort: Paths.port)
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
