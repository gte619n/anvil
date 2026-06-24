import Foundation

/// Installs the daemon on first run (anvil-server-app.md §3.1). The app ships a SLIM bundle — daemon
/// source + prebuilt web/dist + `bun.lock`, but NO `node_modules` (that's ~500 MB, dominated by the
/// native Claude CLI). Provision copies the source to a stable writable dir and runs
/// `bun install --frozen-lockfile` so the deps are fetched at the EXACT versions `bun.lock` pins —
/// pulled down once on the user's machine instead of shipped in the app.
enum Provision {
  static var root: String { Paths.installRoot }
  static var versionFile: String { root + "/.anvil-app-version" }

  /// Version of the bundled daemon (from its package.json) — recorded after a successful install so
  /// we know to re-provision when the app updates.
  static func bundledVersion() -> String? {
    guard let b = Paths.bundledAnvild, let data = FileManager.default.contents(atPath: b + "/package.json"),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return obj["version"] as? String
  }

  static func installedVersion() -> String? {
    (try? String(contentsOfFile: versionFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// True when there's a bundled daemon to install AND the install root is missing, dep-less, or stale.
  static func needed() -> Bool {
    guard Paths.bundledAnvild != nil else { return false } // dev / bare app — nothing to provision
    if !Paths.runnable(root) { return true }
    return installedVersion() != bundledVersion()
  }

  /// Copy the bundled source → install root, then `bun install --frozen-lockfile`. Requires Bun.
  /// Progress strings are reported on the main thread; completion gives (ok, message).
  static func run(progress: @escaping (String) -> Void, completion: @escaping (Bool, String) -> Void) {
    guard let src = Paths.bundledAnvild else { completion(false, "No bundled daemon to install."); return }
    guard Deps.bunInstalled() else { completion(false, "Install Bun first, then install the daemon."); return }
    func report(_ s: String) { DispatchQueue.main.async { progress(s) } }
    DispatchQueue.global(qos: .userInitiated).async {
      report("Copying daemon files…")
      try? FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
      // Sync source (sans node_modules/.git) into the writable install root.
      let rs = Shell.run("rsync", ["-a", "--delete", "--exclude", "node_modules", "--exclude", ".git", src + "/", root + "/"])
      if !rs.ok { return finish(false, "Copy failed: " + String(rs.combined.suffix(300)), completion) }

      // First-run dep fetch (~250 MB download, ~1 GB unpacked) is the most failure-prone — and the
      // slowest — step for a non-technical user, so: (1) give live progress (bun hides its own bar
      // when its output is piped, so we read the count + size straight off disk every second), and
      // (2) be forgiving — try the pinned install, retry once for a transient blip, then fall back to
      // a non-frozen install (covers a drifted lockfile). What decides success is whether the deps
      // actually LANDED — not bun's exit code — so we verify the core dependency the daemon needs.
      let approx = lockfilePackageCount(root)
      report(approx > 0
        ? "Installing dependencies — about \(approx) packages, a one-time ~250 MB download. This can take a minute or two…"
        : "Installing dependencies — a one-time ~250 MB download. This can take a minute or two…")
      // Live counter off disk. We show the raw count + size growing rather than a percentage: bun's
      // on-disk layout doesn't map 1:1 to the manifest's package list, so any "X of N" would look
      // stuck well short of complete. A rising count and MB is honest and always shows real movement
      // (including while the single large Claude CLI binary streams, when the count barely changes).
      let polling = Flag()
      DispatchQueue.global(qos: .utility).async {
        while polling.isSet {
          let p = installProgress(root)
          if p.packages > 0 { report("Downloading dependencies — \(p.packages) packages, \(p.mb) MB so far…") }
          Thread.sleep(forTimeInterval: 1)
        }
      }
      var bi = Shell.run("bun", ["install", "--frozen-lockfile"], cwd: root)
      if !bi.ok {
        report("Dependency install hit an error — retrying…")
        bi = Shell.run("bun", ["install", "--frozen-lockfile"], cwd: root)
      }
      if !bi.ok {
        report("Retrying with a fresh dependency resolution…")
        bi = Shell.run("bun", ["install"], cwd: root) // non-frozen: tolerate a drifted lockfile
      }
      polling.clear()
      if !FileManager.default.fileExists(atPath: root + "/node_modules/@anthropic-ai/claude-agent-sdk") {
        return finish(false, "Couldn't install the daemon's dependencies — check your internet connection and try again.\n"
          + String(bi.combined.suffix(280)), completion)
      }
      let done = installProgress(root)
      report("Dependencies ready — \(done.packages) packages, \(done.mb) MB.")

      report("Building the web client…")
      _ = Shell.run("bun", ["run", "build:web"], cwd: root) // refresh web/dist (best-effort; prebuilt shipped)

      if let v = bundledVersion() { try? v.write(toFile: versionFile, atomically: true, encoding: .utf8) }
      Paths.setAnvildDir(root) // point the app at the provisioned daemon
      finish(true, "Daemon installed (v\(bundledVersion() ?? "?")).", completion)
    }
  }

  private static func finish(_ ok: Bool, _ msg: String, _ completion: @escaping (Bool, String) -> Void) {
    DispatchQueue.main.async { completion(ok, msg) }
  }

  // MARK: - Install progress

  /// A thread-safe stop flag so the progress poller (its own thread) can be told to quit when the
  /// blocking `bun install` returns.
  private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var v = true
    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return v }
    func clear() { lock.lock(); v = false; lock.unlock() }
  }

  /// Best-effort package count from `bun.lock` (each package is one `"name": [ … ]` line in the
  /// "packages" map) — used only as a friendly "about N" scale, never as a hard denominator: ~7 of
  /// these are other-platform binaries that don't install on this Mac, so a percentage would stall.
  private static func lockfilePackageCount(_ root: String) -> Int {
    guard let data = FileManager.default.contents(atPath: root + "/bun.lock"),
          let txt = String(data: data, encoding: .utf8) else { return 0 }
    return txt.split(separator: "\n").reduce(0) {
      $0 + ($1.range(of: #"^    "[^"]+": \["#, options: .regularExpression) != nil ? 1 : 0)
    }
  }

  /// Live install progress read off disk — (#packages extracted, MB on disk). bun suppresses its own
  /// progress bar when its output is piped (as `Shell.run` does), so the filesystem is our signal.
  /// Cheap enough (~0.1s) to poll once a second.
  private static func installProgress(_ root: String) -> (packages: Int, mb: Int) {
    let nm = root + "/node_modules"
    let r = Shell.run("bash", ["-c",
      "printf '%s %s' "
      + "\"$(find '\(nm)' -maxdepth 2 -name package.json 2>/dev/null | wc -l | tr -d ' ')\" "
      + "\"$(du -sm '\(nm)' 2>/dev/null | cut -f1)\""])
    let parts = r.stdout.split(separator: " ")
    let pkgs = parts.indices.contains(0) ? Int(parts[0]) ?? 0 : 0
    let mb = parts.indices.contains(1) ? Int(parts[1]) ?? 0 : 0
    return (pkgs, mb)
  }
}
