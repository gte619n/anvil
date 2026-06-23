import SwiftUI

// MARK: - Menu (popover content)

struct MenuView: View {
  @ObservedObject var state: AppState

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Circle().fill(dotColor).frame(width: 9, height: 9)
        Text(state.serverName).font(.headline)
        Spacer()
        Text(state.health?.version.map { "anvild \($0)" } ?? "").font(.caption).foregroundStyle(.secondary)
      }
      Divider()

      switch state.phase {
      case .needsSetup:
        Text("Not set up yet.").font(.callout)
        Button("Set up this Mac…") { state.openWizard?() }.buttonStyle(.borderedProminent)
      case .stopped:
        Text(state.busy ?? "Daemon stopped.").font(.callout)
        Button("Start Anvil") { state.install(); state.ensureServe() }
      case .starting:
        ProgressView().controlSize(.small)
        Text(state.busy ?? "Starting…").font(.callout)
      case .authError:
        Label("Subscription auth invalid", systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
        Text("The OAuth token is missing/expired (or an API key is overriding it).").font(.caption)
        Button("Re-login…") { state.openWizard?() }
      case .running:
        Label("Running", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        if let url = state.daemonURL {
          HStack {
            Text(url).font(.caption).textSelection(.enabled).lineLimit(1).truncationMode(.middle)
            Button { copy(url) } label: { Image(systemName: "doc.on.doc") }.buttonStyle(.plain)
          }
        }
        budgetLine
      }

      if let msg = state.lastMessage { Text(msg).font(.caption).foregroundStyle(.red).lineLimit(3) }
      Divider()

      Group {
        Button("Open client in browser") { state.openClient() }.disabled(state.daemonURL == nil)
        Button("Add a Mac to the fleet…") { state.openAddMac?() }.disabled(state.phase != .running)
        Button("Restart") { state.restart() }.disabled(!state.hasToken || !state.hasCheckout)
        Button("Settings…") { state.openWizard?() }
      }.buttonStyle(.plain)

      Divider()
      Button("Quit Anvil Server") { NSApplication.shared.terminate(nil) }.buttonStyle(.plain)
    }
    .padding(14)
    .frame(width: 320)
  }

  private var dotColor: Color {
    switch state.phase {
    case .running: return .green
    case .starting: return .yellow
    case .authError: return .orange
    case .needsSetup, .stopped: return .secondary
    }
  }

  @ViewBuilder private var budgetLine: some View {
    if let b = state.health?.budget {
      Text(b.warn == true ? "⚠️ Approaching the weekly limit" : "Budget OK")
        .font(.caption).foregroundStyle(b.warn == true ? .orange : .secondary)
    }
  }

  private func copy(_ s: String) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(s, forType: .string) }
}

// MARK: - First-run / settings wizard

struct WizardView: View {
  @ObservedObject var state: AppState
  let close: () -> Void

  enum Role { case choose, establish, join }
  @State private var role: Role = .choose
  @State private var token = ""
  @State private var pairingCode = ""
  @State private var status = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Set up Anvil Server").font(.title2).bold()
      if let w = Auth.apiKeyWarning() { Label(w, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange) }
      if !state.hasCheckout {
        Label("Can't find the anvild checkout. Set ANVILD_DIR or install the bundled app.", systemImage: "folder.badge.questionmark")
          .font(.caption).foregroundStyle(.red)
      }

      switch role {
      case .choose:
        Text("Is this your first Anvil Mac, or are you adding it to an existing fleet?")
        HStack {
          Button("Establish a new fleet") { role = .establish }.buttonStyle(.borderedProminent)
          Button("Join an existing fleet") { startJoin() }
        }
      case .establish:
        Text("1. Log in with your Claude subscription (opens Terminal):")
        Button("Run `claude setup-token`") { _ = Auth.openSetupTokenInTerminal() }
        Text("2. Paste the token it prints:")
        SecureField("CLAUDE_CODE_OAUTH_TOKEN", text: $token)
        Button("Save & start") { saveAndStart() }.buttonStyle(.borderedProminent).disabled(token.isEmpty)
      case .join:
        Text("On your main Mac: Anvil → Add a Mac to the fleet → enter this code:")
        Text(pairingCode).font(.system(size: 34, weight: .bold, design: .monospaced)).frame(maxWidth: .infinity)
        Text("This Mac: \(Tailscale.magicDNSName() ?? "—")").font(.caption).foregroundStyle(.secondary)
        Text("Waiting for the hub to send the token…").font(.caption)
      }

      if !status.isEmpty { Text(status).font(.caption).foregroundStyle(.secondary) }
      Spacer()
      HStack { Spacer(); Button("Close") { stopJoin(); close() } }
    }
    .padding(20)
    .frame(width: 460, height: 320)
  }

  private func saveAndStart() {
    do {
      try Auth.writeToken(token)
      state.install()
      state.ensureServe()
      // Re-login also refreshes the shared token across the fleet (§4.4); no-op if no members.
      state.rotateFleet(token: token) { msg in status = msg }
      status = "Token saved. Starting the daemon…"
    } catch { status = (error as NSError).localizedDescription }
  }

  private func startJoin() {
    role = .join
    pairingCode = state.armJoin() // opens the persistent listener + a join window; the hub pushes the token
  }

  private func stopJoin() { state.cancelJoin() }
}

// MARK: - Hub: add a Mac to the fleet

struct AddMacView: View {
  @ObservedObject var state: AppState
  let close: () -> Void
  @State private var host = ""
  @State private var code = ""
  @State private var status = ""
  @State private var sending = false

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Add a Mac to the fleet").font(.title2).bold()
      Text("On the new Mac, open Anvil → Join an existing fleet. Enter its tailnet name and the 6-digit code it shows.")
        .font(.callout).foregroundStyle(.secondary)
      TextField("joiner.tailnet.ts.net", text: $host)
      TextField("6-digit code", text: $code)
      Button(sending ? "Sending…" : "Send invite") { send() }
        .buttonStyle(.borderedProminent)
        .disabled(sending || host.isEmpty || code.count != 6)
      if !status.isEmpty { Text(status).font(.caption) }
      Spacer()
      HStack { Spacer(); Button("Close") { close() } }
    }
    .padding(20)
    .frame(width: 460, height: 280)
  }

  private func send() {
    guard let token = try? Auth.readToken() ?? nil else { status = "No local token to share — set this Mac up first."; return }
    let h = host.trimmingCharacters(in: .whitespaces)
    sending = true; status = "Pushing the token over the tailnet…"
    Pairing.pushPair(toHost: h, code: code, token: token, fleetName: nil, hubServerId: state.myServerId) { result in
      sending = false
      switch result {
      case .success(let reply):
        if reply.ok {
          state.recordMember(host: h, reply: reply) // remember it for future token rotations (§6)
          status = "✅ \(h) joined the fleet."
        } else {
          status = "Rejected: \(reply.error ?? "unknown")"
        }
      case .failure(let e): status = "Failed: \(e.localizedDescription)"
      }
    }
  }
}
