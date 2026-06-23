import Foundation

/// Dependency detection + install (anvil-server-app.md §3). The daemon runs under Bun; the launcher
/// `service.sh` writes always puts `~/.bun/bin` on PATH, so installing Bun there (the official
/// installer's default) is picked up with no profile edits. Tailscale we only detect — installing it
/// needs the GUI app + a login flow we can't automate, so we link the user to the download.
enum Deps {
  static func bunInstalled() -> Bool { Shell.which("bun") != nil }

  static func bunVersion() -> String? {
    let r = Shell.run("bun", ["--version"])
    return r.ok ? r.stdout.trimmingCharacters(in: .whitespacesAndNewlines) : nil
  }

  /// Install Bun via the official script (`curl … | bash` → `~/.bun/bin`). Network action — run it
  /// only on an explicit user tap. Calls back on the main thread.
  static func installBun(completion: @escaping (Bool, String) -> Void) {
    DispatchQueue.global(qos: .userInitiated).async {
      // `-l` so curl/unzip resolve from the user's normal PATH; the script writes to ~/.bun.
      let r = Shell.run("bash", ["-lc", "curl -fsSL https://bun.sh/install | bash"])
      let ok = Shell.which("bun") != nil
      let msg = ok
        ? "Bun installed (\(bunVersion() ?? "ok"))."
        : (r.combined.isEmpty ? "Bun install failed — check your network." : String(r.combined.suffix(300)))
      DispatchQueue.main.async { completion(ok, msg) }
    }
  }

  static var tailscaleInstalled: Bool { Tailscale.installed() }
  static let tailscaleDownloadURL = URL(string: "https://tailscale.com/download/macos")!
}
