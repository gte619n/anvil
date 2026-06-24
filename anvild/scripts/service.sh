#!/usr/bin/env bash
#
# anvild macOS service manager (arch §3/§5, impl plan 6).
#   ./scripts/service.sh install     # install + load the LaunchAgent, build web, wire tailscale
#   ./scripts/service.sh uninstall   # bootout + remove plist/launcher (keeps state)
#   ./scripts/service.sh restart     # rebuild the web bundle + kickstart the service (full deploy)
#   ./scripts/service.sh status      # service state + /api/health
#   ./scripts/service.sh logs        # tail the daemon log
#
# DEPLOY NOTE (why `restart` rebuilds web): the daemon serves the *built* web bundle from
# web/dist (see src/server/http.ts WEB_DIR). The daemon itself runs from TS source, so a bare
# kickstart picks up daemon code changes — but it does NOT regenerate web/dist. For a long time
# `restart` only kickstarted, so a `git pull` + `restart` shipped new daemon code while silently
# serving the OLD web UI (the classic "my change merged but the dropdown/button isn't there"
# symptom). `restart` now runs `build:web` first so a pull+restart is a true full deploy. To
# verify the web change actually shipped, query the running daemon (not the browser, which the
# service worker may have cached):  curl -s http://127.0.0.1:7701/main.js | grep -c <your-string>
#
set -euo pipefail

LABEL="com.anvil.anvild"
PORT="${ANVIL_PORT:-7701}"
ANVILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
LAUNCHER="$BIN_DIR/anvild-launch"
STATE_DIR="$HOME/.local/state/anvil"
CONFIG_ENV="$HOME/.config/anvil/env"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

find_bun() {
  command -v bun 2>/dev/null && return 0
  [ -x "$HOME/.bun/bin/bun" ] && { echo "$HOME/.bun/bin/bun"; return 0; }
  return 1
}

# Rebuild the web client into web/dist. Both `install` and `restart` call this so the bundle the
# daemon serves can never lag the source (see the DEPLOY NOTE at the top of this file). We run
# `bun install` first: a `git pull` can add a new dependency (e.g. sortablejs in #26), and
# `build:web` resolves imports straight out of node_modules — so without an install the build
# fails with "Could not resolve …" and the atomic dist swap silently keeps serving the old UI.
# An in-sync lockfile makes the install a fast no-op, so it's cheap to always run.
#
# CRITICAL: the rebuild is best-effort and must NEVER block the daemon from starting. The app ships a
# prebuilt web/dist (Provision copies it into the install root) and build.ts swaps atomically — a
# failed build leaves the existing dist untouched. So if install/build fails but a usable bundle is
# already present, warn and carry on with it; only hard-fail when there's no dist to serve at all.
# (Before this, `set -e` let a failed `build:web` abort `do_install` *before* the LaunchAgent was
# bootstrapped — a transient build error left the daemon dead and fleet clients stuck "connecting".)
build_web() {
  local bun; bun="$(find_bun)" || { echo "error: bun not found (looked on PATH and ~/.bun/bin)"; exit 1; }
  # Put bun's own dir on PATH. The `build:web` script re-invokes bun BY NAME (`bun run web/build.ts`),
  # and `bun install` may run package hooks that do the same. Some bun builds don't propagate their
  # install dir to spawned scripts, so a bun that's resolvable by full path but missing from PATH
  # (e.g. ~/.bun/bin absent from the shell/daemon PATH) makes those nested calls die with
  # "bun: command not found" (exit 127) — observed on a fleet M1, which silently kept the daemon down.
  export PATH="$(dirname "$bun"):$PATH"
  echo "installing dependencies…"
  ( cd "$ANVILD_DIR" && "$bun" install ) || echo "warning: bun install failed — building against the existing node_modules"
  echo "building web client…"
  if ( cd "$ANVILD_DIR" && "$bun" run build:web >/dev/null ); then
    return 0
  fi
  if [ -f "$ANVILD_DIR/web/dist/main.js" ]; then
    echo "warning: web build failed — serving the existing web/dist bundle (may be stale; see the build error above)"
    return 0
  fi
  echo "error: web build failed and there's no prebuilt web/dist to fall back on"
  exit 1
}

# This host's Tailscale IPv4 (100.64.0.0/10), if any. Found from interfaces, so it works even when
# the `tailscale` CLI doesn't (the App Store build). Used as the plain-HTTP bind/URL fallback.
tailnet_ip() {
  ifconfig 2>/dev/null | awk '/inet 100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./{print $2; exit}'
}

# Locate a usable `tailscale` CLI (matches the daemon's TAILSCALE_BINS search order). Empty if none.
TAILSCALE_BIN=""
resolve_tailscale() {
  [ -n "$TAILSCALE_BIN" ] && { echo "$TAILSCALE_BIN"; return 0; }
  local c
  for c in tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale /opt/homebrew/bin/tailscale /usr/local/bin/tailscale; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then TAILSCALE_BIN="$c"; echo "$c"; return 0; fi
  done
  return 1
}

# This host's MagicDNS name (trailing dot stripped), or empty if Tailscale/CLI is unavailable.
magicdns_name() {
  local ts; ts="$(resolve_tailscale)" || return 1
  local bun; bun="$(find_bun)" || return 1
  "$ts" status --json 2>/dev/null | "$bun" -e 'const s=JSON.parse(await Bun.stdin.text());process.stdout.write((s.Self?.DNSName||"").replace(/\.$/,""))' 2>/dev/null || true
}

# Adaptive transport (the ts.net name forces HTTPS in browsers, so plain HTTP only works by IP).
# Try to front the daemon with `tailscale serve` (HTTPS on the MagicDNS name → loopback). If that
# works (standalone Tailscale, operator configured), the daemon binds loopback and every client —
# browser/WebView/fleet — uses https://<name>:PORT. If serve is unavailable (the sandboxed App
# Store build), fall back to binding the tailnet IP directly over plain HTTP (use http://<ip>:PORT).
# Sets SERVE_OK=1/0. Idempotent: `tailscale serve --bg` config persists across reboots.
SERVE_OK=0
setup_serve() {
  SERVE_OK=0
  local ts; ts="$(resolve_tailscale)" || { echo "tailscale CLI not found — daemon will bind the tailnet IP over plain HTTP"; return 0; }
  if "$ts" serve --bg --https="$PORT" "http://127.0.0.1:$PORT" >/dev/null 2>&1 \
     && "$ts" serve status 2>/dev/null | grep -q ":$PORT"; then
    SERVE_OK=1
    echo "tailscale serve active — daemon will bind loopback, reachable at https://<magicdns>:$PORT"
  else
    echo "tailscale serve unavailable (App Store Tailscale?) — daemon will bind the tailnet IP over plain HTTP"
  fi
}

# Confirm the daemon answers, without needing to know the transport: in serve mode it binds
# loopback, in direct mode it binds the tailnet IP — try both.
wait_health() {
  local ip; ip="$(tailnet_ip)"
  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && return 0
    [ -n "$ip" ] && curl -fsS "http://$ip:$PORT/api/health" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  return 1
}

# When the daemon won't come up, print the ACTUAL reason (the tail of its error log) instead of
# just pointing at a log file — the app surfaces this output verbatim in its status line, and a
# non-technical user is never going to open a log by hand. Keep it short so it fits the menu.
report_unhealthy() {
  echo "warning: the daemon isn't answering on :$PORT yet. Most recent errors:"
  tail -n 12 "$STATE_DIR/anvild.error.log" 2>/dev/null | sed 's/^/    /' || true
  echo "  full log: $STATE_DIR/anvild.error.log"
}

free_port() {
  pkill -f "anvild/src/main.ts" 2>/dev/null || true
  local pids
  pids="$(lsof -ti "tcp:$PORT" 2>/dev/null || true)"
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
  sleep 0.5
}

do_install() {
  local bun; bun="$(find_bun)" || { echo "error: bun not found (looked on PATH and ~/.bun/bin)"; exit 1; }
  [ -f "$CONFIG_ENV" ] || {
    echo "error: missing $CONFIG_ENV"
    echo "  Run:  claude setup-token"
    echo "  Then: mkdir -p ~/.config/anvil && umask 077 && printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\\n' '<token>' > $CONFIG_ENV"
    exit 1
  }
  mkdir -p "$BIN_DIR" "$STATE_DIR" "$(dirname "$PLIST")"

  build_web

  # The daemon imports its dependencies at runtime (the Claude agent SDK, etc.) — without an
  # installed node_modules it just crash-loops, which would otherwise surface only as a vague
  # "not healthy" timeout. Catch the missing-deps case up front with an actionable message.
  if [ ! -d "$ANVILD_DIR/node_modules" ]; then
    echo "error: dependencies are not installed — $ANVILD_DIR/node_modules is missing, so the daemon can't run."
    echo "  Fix: open a terminal and run:  cd \"$ANVILD_DIR\" && bun install"
    exit 1
  fi

  # Decide the transport BEFORE writing the launcher: if serve is available we bind loopback so
  # `tailscale serve` can own the tailnet :PORT over HTTPS; otherwise the daemon binds the tailnet
  # IP itself (auto-detected) over plain HTTP. This is what makes the MagicDNS name usable in a
  # browser (ts.net forces HTTPS) while still working on App Store Tailscale hosts.
  setup_serve
  local host_export=""
  [ "$SERVE_OK" = "1" ] && host_export="export ANVIL_HOST=127.0.0.1"

  # launcher — sources the OAuth token, guarantees no metered key reaches the daemon (arch §3)
  cat > "$LAUNCHER" <<LAUNCH
#!/bin/sh
export PATH="\$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
set -a
[ -f "\$HOME/.config/anvil/env" ] && . "\$HOME/.config/anvil/env"
set +a
unset ANTHROPIC_API_KEY
unset ANTHROPIC_AUTH_TOKEN
# Transport chosen by service.sh setup_serve: with \`tailscale serve\` active the daemon binds
# loopback (serve fronts the tailnet port over HTTPS on the MagicDNS name); otherwise it binds the
# tailnet IP directly over plain HTTP (auto-detected, App-Store-Tailscale safe). ANVIL_HOST overrides.
$host_export
export ANVIL_PORT=$PORT
export ANVIL_MANAGED=launchd
exec "$bun" run "$ANVILD_DIR/src/main.ts"
LAUNCH
  chmod 755 "$LAUNCHER"

  # LaunchAgent (no secrets in the plist — they come from the launcher)
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$LAUNCHER</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>WorkingDirectory</key><string>$ANVILD_DIR</string>
  <key>StandardOutPath</key><string>$STATE_DIR/anvild.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/anvild.error.log</string>
</dict>
</plist>
PLISTEOF

  free_port
  launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  launchctl kickstart -k "$DOMAIN/$LABEL"

  if wait_health; then
    echo "healthy: $(curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null || curl -fsS "http://$(tailnet_ip):$PORT/api/health")"
  else
    # Exit non-zero so the caller (the app's "Start Anvil") knows the daemon didn't come up and
    # surfaces the reason — otherwise install "succeeds", the app shows no error, and the UI silently
    # falls back to "Daemon stopped" with the real cause hidden in the log.
    report_unhealthy
    exit 1
  fi

  # Print the URL clients should use for THIS host's transport: serve → HTTPS on the MagicDNS name
  # (browser-friendly; ts.net forces HTTPS anyway); otherwise plain HTTP on the tailnet IP (the name
  # can't be used over HTTP in a browser, so we print the IP). WireGuard encrypts the hop either way.
  local dns; dns="$(magicdns_name)"
  if [ "$SERVE_OK" = "1" ] && [ -n "$dns" ]; then
    echo "URL: https://$dns:$PORT/"
  else
    local ip; ip="$(tailnet_ip)"
    [ -n "$ip" ] && echo "URL: http://$ip:$PORT/  (the MagicDNS name forces HTTPS in browsers — use the IP for plain HTTP)"
  fi
  echo "installed $LABEL  (logs: $STATE_DIR/anvild.log)"
}

case "${1:-install}" in
  install)   do_install ;;
  uninstall) launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null || true; rm -f "$PLIST" "$LAUNCHER"; echo "removed $LABEL (state kept at $STATE_DIR)" ;;
  restart)
    build_web
    # Re-assert `tailscale serve` only if this install chose serve mode (loopback bind); doing it in
    # direct-bind mode would create a tailnet :PORT listener that collides with the daemon's own bind.
    grep -q 'ANVIL_HOST=127.0.0.1' "$LAUNCHER" 2>/dev/null && setup_serve >/dev/null 2>&1 || true
    launchctl kickstart -k "$DOMAIN/$LABEL"
    if wait_health; then echo "restarted, healthy"; else report_unhealthy; exit 1; fi
    ;;
  status)    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E 'state =|pid =' || echo "not loaded"; { curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null || curl -fsS "http://$(tailnet_ip):$PORT/api/health" 2>/dev/null; } && echo || echo "no health" ;;
  logs)      tail -n 80 -f "$STATE_DIR/anvild.log" ;;
  *) echo "usage: service.sh {install|uninstall|restart|status|logs}"; exit 1 ;;
esac
