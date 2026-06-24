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

      report("Installing dependencies (downloads ~250 MB once, version-locked)…")
      let bi = Shell.run("bun", ["install", "--frozen-lockfile"], cwd: root)
      if !bi.ok { return finish(false, "bun install failed: " + String(bi.combined.suffix(300)), completion) }

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
}
