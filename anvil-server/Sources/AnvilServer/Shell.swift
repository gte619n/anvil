import Foundation

/// Result of running a subprocess.
struct ShellResult {
  let code: Int32
  let stdout: String
  let stderr: String
  var ok: Bool { code == 0 }
  var combined: String { (stdout + stderr).trimmingCharacters(in: .whitespacesAndNewlines) }
}

/// Thin wrapper over `Process`. The app orchestrates by shelling out to the same tools the headless
/// setup uses — `service.sh`, `tailscale`, `claude`, `launchctl` — so behavior never diverges from
/// the documented CLI path (anvil-server-app.md §3.3).
enum Shell {
  /// Search PATH plus the usual GUI-app-launch locations (a menu-bar app inherits a minimal PATH).
  static let searchPaths = [
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
    NSHomeDirectory() + "/.bun/bin", NSHomeDirectory() + "/.local/bin",
    "/Applications/Tailscale.app/Contents/MacOS",
  ]

  /// Resolve a tool to an absolute path (first hit wins); nil if not found.
  static func which(_ tool: String) -> String? {
    if tool.hasPrefix("/") { return FileManager.default.isExecutableFile(atPath: tool) ? tool : nil }
    for dir in searchPaths {
      let p = dir + "/" + tool
      if FileManager.default.isExecutableFile(atPath: p) { return p }
    }
    return nil
  }

  /// Run `tool args…`, optionally with extra env and a working dir. Blocking — call off the main thread.
  @discardableResult
  static func run(_ tool: String, _ args: [String] = [], env extra: [String: String] = [:], cwd: String? = nil) -> ShellResult {
    guard let exe = which(tool) else {
      return ShellResult(code: 127, stdout: "", stderr: "not found on PATH: \(tool)")
    }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = (searchPaths + [env["PATH"] ?? ""]).joined(separator: ":")
    for (k, v) in extra { env[k] = v }
    p.environment = env
    let out = Pipe(), err = Pipe()
    p.standardOutput = out
    p.standardError = err
    do { try p.run() } catch {
      return ShellResult(code: 126, stdout: "", stderr: "failed to launch \(exe): \(error.localizedDescription)")
    }
    let oData = out.fileHandleForReading.readDataToEndOfFile()
    let eData = err.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return ShellResult(
      code: p.terminationStatus,
      stdout: String(decoding: oData, as: UTF8.self),
      stderr: String(decoding: eData, as: UTF8.self)
    )
  }
}
