import SwiftUI

/// Anvil "forge" accent used across the UI.
extension Color {
  static let anvil = Color(red: 0.90, green: 0.47, blue: 0.13)
}

/// A header row: a tinted icon chip + title/subtitle. Used at the top of each window/popover.
private struct Header: View {
  let symbol: String
  let title: String
  var subtitle: String?
  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: symbol)
        .font(.title2).foregroundStyle(.white)
        .frame(width: 38, height: 38)
        .background(LinearGradient(colors: [Color.anvil, Color.anvil.opacity(0.75)], startPoint: .top, endPoint: .bottom))
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
      VStack(alignment: .leading, spacing: 1) {
        Text(title).font(.headline)
        if let subtitle { Text(subtitle).font(.caption).foregroundStyle(.secondary) }
      }
      Spacer()
    }
  }
}

/// A light rounded "card" container for grouping a section's content.
private struct Card<Content: View>: View {
  @ViewBuilder var content: Content
  var body: some View {
    VStack(alignment: .leading, spacing: 8) { content }
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(.quaternary.opacity(0.5))
      .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
  }
}

// MARK: - Menu (popover content)

struct MenuView: View {
  @ObservedObject var state: AppState

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 9) {
        Image(systemName: "hammer.fill").foregroundStyle(Color.anvil)
        Text(state.serverName).font(.headline).lineLimit(1)
        Spacer()
        if let v = state.health?.version {
          Text("anvild \(v)").font(.caption2).padding(.horizontal, 6).padding(.vertical, 2)
            .background(.quaternary).clipShape(Capsule())
        }
      }

      statusCard

      if let msg = state.lastMessage {
        Label(msg, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.red).lineLimit(3)
      }

      VStack(alignment: .leading, spacing: 2) {
        menuButton("Open client in browser", "safari", state.openClient, enabled: state.daemonURL != nil)
        menuButton("Manage fleet…", "rectangle.3.group", { state.openAddMac?() }, enabled: state.hasToken)
        menuButton("Restart daemon", "arrow.clockwise", state.restart, enabled: state.hasToken && state.hasCheckout)
        menuButton("Settings…", "gearshape", { state.openWizard?() })
      }
      Divider()
      menuButton("Quit Anvil Server", "power", { NSApplication.shared.terminate(nil) }, tint: .secondary)
    }
    .padding(14)
    .frame(width: 340)
  }

  @ViewBuilder private var statusCard: some View {
    Card {
      HStack(spacing: 8) {
        Image(systemName: statusSymbol).foregroundStyle(dotColor)
        Text(statusText).font(.subheadline.weight(.medium))
        Spacer()
      }
      switch state.phase {
      case .needsSetup:
        Button { state.openWizard?() } label: { Label("Set up this Mac…", systemImage: "wand.and.stars") }
          .buttonStyle(.borderedProminent).tint(.anvil)
      case .stopped:
        Button { state.install(); state.ensureServe() } label: { Label("Start Anvil", systemImage: "play.fill") }
          .buttonStyle(.borderedProminent).tint(.anvil)
      case .starting:
        HStack(spacing: 6) { ProgressView().controlSize(.small); Text(state.busy ?? "Starting…").font(.caption) }
      case .authError:
        Button { state.openWizard?() } label: { Label("Re-login…", systemImage: "key.fill") }.tint(.orange)
      case .running:
        if let url = state.daemonURL {
          HStack(spacing: 6) {
            Image(systemName: "link").font(.caption).foregroundStyle(.secondary)
            Text(url).font(.caption).textSelection(.enabled).lineLimit(1).truncationMode(.middle)
            Button { copy(url) } label: { Image(systemName: "doc.on.doc") }.buttonStyle(.plain).help("Copy URL")
          }
        }
        if let b = state.health?.budget {
          Label(b.warn == true ? "Approaching the weekly limit" : "Budget OK",
                systemImage: b.warn == true ? "exclamationmark.triangle.fill" : "gauge.with.dots.needle.67percent")
            .font(.caption).foregroundStyle(b.warn == true ? .orange : .secondary)
        }
      }
    }
  }

  private func menuButton(_ title: String, _ symbol: String, _ action: @escaping () -> Void, enabled: Bool = true, tint: Color = .primary) -> some View {
    Button(action: action) {
      Label(title, systemImage: symbol).frame(maxWidth: .infinity, alignment: .leading)
    }
    .buttonStyle(.plain).foregroundStyle(enabled ? tint : Color.secondary).disabled(!enabled)
    .padding(.vertical, 3)
  }

  private var statusText: String {
    switch state.phase {
    case .needsSetup: return "Not set up yet"
    case .stopped: return state.busy ?? "Daemon stopped"
    case .starting: return "Starting…"
    case .authError: return "Subscription auth invalid"
    case .running: return "Running"
    }
  }
  private var statusSymbol: String {
    switch state.phase {
    case .running: return "checkmark.circle.fill"
    case .starting: return "clock.fill"
    case .authError: return "exclamationmark.triangle.fill"
    case .needsSetup: return "wand.and.stars"
    case .stopped: return "stop.circle.fill"
    }
  }
  private var dotColor: Color {
    switch state.phase {
    case .running: return .green
    case .starting: return .yellow
    case .authError: return .orange
    case .needsSetup: return .anvil
    case .stopped: return .secondary
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
  @State private var checkoutTick = 0
  @State private var bunOK = Deps.bunInstalled()
  @State private var tsOK = Deps.tailscaleInstalled
  @State private var tsUp = Deps.tailscaleInstalled && Tailscale.loggedIn() // installed AND signed in/running
  @State private var installingBun = false
  @State private var provisioning = false
  @State private var daemonUpdate = Provision.needed() // bundled daemon differs from what's installed

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Header(symbol: "hammer.fill", title: "Set up Anvil Server", subtitle: "Drive Claude across your Macs")

      dependencyCard

      if let w = Auth.apiKeyWarning() {
        Label(w, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.orange)
      }
      if !state.hasCheckout {
        let _ = checkoutTick
        Card {
          if Paths.bundledAnvild != nil {
            Label("The Anvil daemon needs to be installed on this Mac.", systemImage: "shippingbox").font(.callout)
            Text("Copies the bundled daemon to ~/.local/share/anvil and fetches its dependencies (~250 MB, version-locked) with Bun — once.").font(.caption).foregroundStyle(.secondary)
            Button { provisionDaemon() } label: {
              if provisioning { HStack(spacing: 5) { ProgressView().controlSize(.small); Text("Installing…") } }
              else { Label("Install Anvil daemon", systemImage: "arrow.down.circle.fill") }
            }.buttonStyle(.borderedProminent).tint(.anvil).disabled(provisioning || !bunOK)
            if !bunOK { Text("Install Bun first (above).").font(.caption2).foregroundStyle(.orange) }
          } else {
            Label("Can't find the anvild daemon on this Mac.", systemImage: "folder.badge.questionmark")
              .font(.callout).foregroundStyle(.red)
            Button { chooseCheckout() } label: { Label("Choose anvild folder…", systemImage: "folder") }
          }
        }
      } else if daemonUpdate {
        // A checkout exists but the app bundles a NEWER daemon (e.g. a fixed service.sh) — offer to
        // update it in place. Re-provision preserves node_modules, so this is fast, and it restarts a
        // running daemon to pick up the new code.
        Card {
          Label("A daemon update is available.", systemImage: "arrow.triangle.2.circlepath").font(.callout)
          Text("This Mac is running an older copy of the Anvil daemon than this app ships. Updating refreshes it (keeps the installed dependencies) and restarts it.").font(.caption).foregroundStyle(.secondary)
          Button { provisionDaemon() } label: {
            if provisioning { HStack(spacing: 5) { ProgressView().controlSize(.small); Text("Updating…") } }
            else { Label("Update Anvil daemon", systemImage: "arrow.down.circle.fill") }
          }.buttonStyle(.borderedProminent).tint(.anvil).disabled(provisioning || !bunOK)
        }
      }

      switch role {
      case .choose:
        Text("Is this your first Anvil Mac, or are you adding it to an existing fleet?").font(.callout)
        HStack(spacing: 10) {
          roleButton("Establish a new fleet", "flag.checkered", prominent: true) { role = .establish }
          roleButton("Join an existing fleet", "person.2.fill") { startJoin() }
        }
        if state.hasToken {
          Divider()
          Button { state.openAddMac?() } label: {
            Label("Manage fleet / add a Mac…", systemImage: "rectangle.3.group").frame(maxWidth: .infinity)
          }.buttonStyle(.borderedProminent).tint(.anvil)
        }
      case .establish:
        Card {
          Label("Log in with your Claude subscription", systemImage: "1.circle.fill").font(.callout.weight(.medium))
          Text("Opens Terminal to run `claude setup-token` (no API key — your subscription).").font(.caption).foregroundStyle(.secondary)
          Button {
            // Don't silently do nothing if Claude Code isn't installed — tell the user how to fix it.
            if !Auth.openSetupTokenInTerminal() {
              status = "Claude Code isn't installed on this Mac. Install it from claude.com/claude-code, then try again."
            }
          } label: { Label("Run setup-token", systemImage: "terminal") }
        }
        Card {
          Label("Paste the token it prints", systemImage: "2.circle.fill").font(.callout.weight(.medium))
          SecureField("CLAUDE_CODE_OAUTH_TOKEN", text: $token).textFieldStyle(.roundedBorder)
          Button { saveAndStart() } label: { Label("Save & start", systemImage: "play.fill") }
            .buttonStyle(.borderedProminent).tint(.anvil).disabled(token.isEmpty)
        }
      case .join:
        Card {
          Label("On your main Mac", systemImage: "arrow.down.left.circle.fill").font(.callout.weight(.medium))
          Text("Open Anvil → Add a Mac to the fleet → enter this code:").font(.caption).foregroundStyle(.secondary)
          Text(pairingCode)
            .font(.system(size: 38, weight: .bold, design: .monospaced)).kerning(4)
            .frame(maxWidth: .infinity).padding(.vertical, 6)
            .background(Color.anvil.opacity(0.12)).clipShape(RoundedRectangle(cornerRadius: 10))
          // Prefer the MagicDNS name, but fall back to the tailnet IP (read straight from the network
          // interfaces — works even when the `tailscale` CLI doesn't resolve in the app's sandbox, which
          // is exactly when magicDNSName() returns nil). Either value is something the hub can pair to.
          Label("This Mac: \(Tailscale.magicDNSName() ?? Tailscale.tailnetIP() ?? "—")", systemImage: "desktopcomputer").font(.caption).foregroundStyle(.secondary)
          HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Waiting for the hub…").font(.caption).foregroundStyle(.secondary) }
        }
      }

      if !status.isEmpty { Label(status, systemImage: "info.circle").font(.caption).foregroundStyle(.secondary) }
      Spacer()
      HStack { Spacer(); Button("Close") { stopJoin(); close() } }
    }
    .padding(22)
    .frame(width: 480, height: 460)
    .onAppear { recheckDeps() } // reflect reality each time the window opens (e.g. after signing in to Tailscale)
  }

  /// Re-read dependency state off the main thread (each shells out) and publish on the main actor, so
  /// the wizard always shows the current truth — a user who installs Bun or signs in to Tailscale in
  /// another window sees it update on return, with no app restart.
  private func recheckDeps() {
    DispatchQueue.global(qos: .userInitiated).async {
      let bun = Deps.bunInstalled(), ts = Deps.tailscaleInstalled, up = ts && Tailscale.loggedIn()
      let upd = Provision.needed()
      DispatchQueue.main.async { bunOK = bun; tsOK = ts; tsUp = up; daemonUpdate = upd }
    }
  }

  private func roleButton(_ title: String, _ symbol: String, prominent: Bool = false, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      VStack(spacing: 8) {
        Image(systemName: symbol).font(.title).foregroundStyle(Color.anvil) // always visible, even on a .secondary button
        Text(title).font(.callout).multilineTextAlignment(.center)
      }.frame(maxWidth: .infinity).padding(.vertical, 14)
    }
    .buttonStyle(.bordered).tint(prominent ? .anvil : .secondary)
  }

  @ViewBuilder private var dependencyCard: some View {
    Card {
      Label("Dependencies", systemImage: "shippingbox").font(.callout.weight(.medium))
      HStack {
        Label(bunOK ? "Bun installed" : "Bun not installed",
              systemImage: bunOK ? "checkmark.circle.fill" : "xmark.circle.fill")
          .font(.caption).foregroundStyle(bunOK ? .green : .red)
        Spacer()
        if !bunOK {
          Button { installBun() } label: {
            if installingBun { HStack(spacing: 5) { ProgressView().controlSize(.small); Text("Installing…") } }
            else { Label("Install Bun", systemImage: "arrow.down.circle") }
          }.controlSize(.small).disabled(installingBun)
        }
      }
      HStack {
        // Three states, because "installed" isn't enough to reach other Macs — a very common
        // regular-person snag is Tailscale installed but not signed in, which leaves the daemon
        // bound to a tailnet address that doesn't exist yet.
        Label(!tsOK ? "Tailscale not installed" : (tsUp ? "Tailscale connected" : "Tailscale not signed in"),
              systemImage: tsUp ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
          .font(.caption).foregroundStyle(tsUp ? .green : .orange)
        Spacer()
        if !tsOK {
          Link("Get Tailscale", destination: Deps.tailscaleDownloadURL).font(.caption)
        } else if !tsUp {
          Button("Open Tailscale") { _ = Shell.run("open", ["-a", "Tailscale"]); recheckDeps() }
            .controlSize(.small)
        }
      }
      if tsOK && !tsUp {
        Text("Open Tailscale and sign in — Anvil reaches your other Macs over your private tailnet.")
          .font(.caption2).foregroundStyle(.secondary)
      }
    }
  }

  private func installBun() {
    installingBun = true
    status = "Installing Bun from bun.sh…"
    Deps.installBun { ok, msg in
      installingBun = false
      bunOK = ok
      status = msg
    }
  }

  private func provisionDaemon() {
    provisioning = true
    Provision.run(progress: { status = $0 }, completion: { ok, msg in
      provisioning = false
      status = msg
      checkoutTick += 1 // hasCheckout now resolves to the provisioned install root
      if ok {
        daemonUpdate = false
        // If this Mac is already configured, restart so the freshly-installed daemon code takes effect.
        if state.hasToken { state.restart() }
      }
    })
  }

  private func chooseCheckout() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.prompt = "Use this anvild folder"
    panel.message = "Choose the anvild checkout (the folder containing scripts/service.sh)."
    if panel.runModal() == .OK, let url = panel.url {
      if Paths.valid(url.path) {
        Paths.setAnvildDir(url.path); checkoutTick += 1; status = "Using anvild at \(url.path)"
      } else {
        status = "That folder isn't an anvild checkout (no scripts/service.sh)."
      }
    }
  }

  private func saveAndStart() {
    do {
      try Auth.writeToken(token)
      state.install(); state.ensureServe()
      state.rotateFleet(token: token) { msg in status = msg } // re-login also refreshes the fleet (§4.4)
      status = "Token saved. Starting the daemon…"
    } catch { status = (error as NSError).localizedDescription }
  }

  private func startJoin() {
    role = .join
    let r = state.armJoin()
    pairingCode = r.code
    status = r.listening
      ? "Ready — waiting for the hub. Keep this window open."
      : "⚠️ Couldn't open the pairing port \(Paths.pairingPort). Is it already in use? Pairing won't work until this succeeds."
  }
  private func stopJoin() { state.cancelJoin() }
}

// MARK: - Fleet management (hub): members + add a Mac

struct FleetView: View {
  @ObservedObject var state: AppState
  let close: () -> Void
  @State private var host = ""
  @State private var code = ""
  @State private var status = ""
  @State private var sending = false
  @State private var members = FleetRegistry.all()

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Header(symbol: "rectangle.3.group", title: "Fleet", subtitle: "The Macs sharing this subscription login")

      Card {
        Label("This fleet", systemImage: "checkmark.seal").font(.callout.weight(.medium))
        // The hub itself.
        memberRow(name: state.serverName + "  (this Mac)", host: Tailscale.magicDNSName() ?? "—", removable: false)
        if members.isEmpty {
          Text("No other Macs yet. Add one below.").font(.caption).foregroundStyle(.secondary)
        } else {
          ForEach(members) { m in memberRow(name: m.serverName, host: m.host, removable: true, serverId: m.serverId) }
        }
        Text("Re-login (Settings) refreshes the token to every Mac here automatically.").font(.caption2).foregroundStyle(.secondary)
      }

      Card {
        Label("Add a Mac", systemImage: "plus.circle.fill").font(.callout.weight(.medium))
        Text("On the new Mac: open Anvil → Join an existing fleet, then enter its tailnet name + the 6-digit code it shows.")
          .font(.caption).foregroundStyle(.secondary)
        TextField("joiner.tailnet.ts.net", text: $host).textFieldStyle(.roundedBorder)
        TextField("6-digit code", text: $code).textFieldStyle(.roundedBorder)
        Button { send() } label: {
          Label(sending ? "Sending…" : "Send invite", systemImage: "paperplane.fill").frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent).tint(.anvil).disabled(sending || host.isEmpty || code.count != 6 || !state.hasToken)
        if !state.hasToken { Text("Set up this Mac first (it needs a token to share).").font(.caption2).foregroundStyle(.orange) }
      }

      if !status.isEmpty { Label(status, systemImage: "info.circle").font(.caption) }
      Spacer()
      HStack { Spacer(); Button("Close") { close() } }
    }
    .padding(22)
    .frame(width: 480, height: 500)
  }

  private func memberRow(name: String, host: String, removable: Bool, serverId: String = "") -> some View {
    HStack(spacing: 8) {
      Image(systemName: "desktopcomputer").foregroundStyle(Color.anvil)
      VStack(alignment: .leading, spacing: 0) {
        Text(name).font(.callout)
        Text(host).font(.caption2).foregroundStyle(.secondary)
      }
      Spacer()
      if removable {
        Button { FleetRegistry.remove(serverId: serverId); members = FleetRegistry.all() } label: {
          Image(systemName: "minus.circle")
        }.buttonStyle(.plain).foregroundStyle(.secondary).help("Forget this Mac")
      }
    }
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
          state.recordMember(host: h, reply: reply); members = FleetRegistry.all()
          status = "✅ \(h) joined — checking it's online…"; host = ""; code = ""
          // Confirm the new Mac's daemon actually came up, so a silent dead-daemon doesn't masquerade
          // as a successful join (the client would just spin on "connecting" with no explanation).
          Pairing.probeHealth(host: h) { online in
            status = online
              ? "✅ \(h) joined and is online."
              : "✅ \(h) joined, but its daemon isn't responding yet. Give it a moment; if it stays down, open Anvil on \(h) to see the error."
          }
        } else { status = "Rejected: \(reply.error ?? "unknown")" }
      case .failure(let e): status = "Failed: \(e.localizedDescription)"
      }
    }
  }
}
