import AppKit

// Menu-bar agent: no Dock icon, no main window (LSUIElement equivalent). The AppDelegate builds the
// status item + popover and drives the daemon.
// Program start is on the main thread; assert main-actor isolation so we can touch @MainActor types.
MainActor.assumeIsolated {
  let app = NSApplication.shared
  let delegate = AppDelegate()
  app.delegate = delegate
  app.setActivationPolicy(.accessory)
  app.run()
}
