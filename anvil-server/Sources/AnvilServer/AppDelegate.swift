import AppKit
import SwiftUI

/// Menu-bar agent shell (anvil-server-app.md §2). Owns the status item + popover (the menu) and the
/// wizard / add-a-Mac windows. The icon reflects daemon health; everything else lives in SwiftUI.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  let state = AppState()
  private var statusItem: NSStatusItem!
  private let popover = NSPopover()
  private var wizardWindow: NSWindow?
  private var addMacWindow: NSWindow?
  private var cancellable: Any?

  func applicationDidFinishLaunching(_ note: Notification) {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    statusItem.button?.image = NSImage(systemSymbolName: "hammer.fill", accessibilityDescription: "Anvil")
    statusItem.button?.action = #selector(togglePopover)
    statusItem.button?.target = self

    popover.behavior = .transient
    popover.contentViewController = NSHostingController(rootView: MenuView(state: state))

    state.openWizard = { [weak self] in self?.showWizard() }
    state.openAddMac = { [weak self] in self?.showAddMac() }

    state.startPolling()
    state.startFleetControlIfMember() // a joined Mac listens for token rotations (§4.4)
    refreshIconLoop()

    // Start Sparkle's scheduled background update checks for the Server.app shell (release builds).
    _ = AnvilServerSparkle.controller

    // First run with nothing configured → open the wizard immediately.
    if state.phase == .needsSetup { showWizard() }
  }

  @objc private func togglePopover() {
    guard let button = statusItem.button else { return }
    if popover.isShown { popover.performClose(nil) }
    else { popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY) }
  }

  /// Tint the menu-bar symbol by health (green/yellow/orange/grey) every couple seconds.
  private func refreshIconLoop() {
    Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      Task { @MainActor in
        guard let self, let button = self.statusItem.button else { return }
        let color: NSColor
        switch self.state.phase {
        case .running: color = .systemGreen
        case .starting: color = .systemYellow
        case .authError: color = .systemOrange
        case .needsSetup, .stopped: color = .secondaryLabelColor
        }
        let cfg = NSImage.SymbolConfiguration(paletteColors: [color])
        button.image = NSImage(systemSymbolName: "hammer.fill", accessibilityDescription: "Anvil")?.withSymbolConfiguration(cfg)
      }
    }
  }

  private func window(_ existing: inout NSWindow?, title: String, view: some View) -> NSWindow {
    if let w = existing { w.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return w }
    let w = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 480, height: 460),
      styleMask: [.titled, .closable], backing: .buffered, defer: false
    )
    w.title = title
    w.contentViewController = NSHostingController(rootView: view)
    w.center()
    w.isReleasedWhenClosed = false
    w.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    existing = w
    return w
  }

  private func showWizard() {
    popover.performClose(nil)
    _ = window(&wizardWindow, title: "Anvil Server Setup", view: WizardView(state: state, close: { [weak self] in self?.wizardWindow?.close() }))
  }

  private func showAddMac() {
    popover.performClose(nil)
    _ = window(&addMacWindow, title: "Fleet", view: FleetView(state: state, close: { [weak self] in self?.addMacWindow?.close() }))
  }
}
