#!/bin/bash
#
# ZellijConnect Session Status Server - Cross-Platform Installer
#
# Installs the session status server and Claude Code hooks.
# Supports: macOS (LaunchAgent) and Linux (systemd user service)
#
# Usage:
#   ./install.sh              # Install
#   ./install.sh --uninstall  # Uninstall
#   ./install.sh --update     # Update scripts only (no service reconfiguration)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$HOME/.local/bin"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
SERVICE_PORT=7601

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
warn() { echo -e "  ${YELLOW}⚠${NC}  $*"; }
err()  { echo -e "  ${RED}✗${NC} $*"; }
step() { echo -e "\n${BLUE}[$1]${NC} $2"; }

# Poll the health endpoint for up to N seconds (default 15). Returns 0 once the
# server responds, 1 on timeout. launchd/systemd spawn asynchronously, so a
# single fixed sleep races the startup; poll instead.
wait_for_health() {
    local timeout="${1:-15}"
    local i=0
    while [ "$i" -lt "$timeout" ]; do
        if curl -s "http://localhost:$SERVICE_PORT/api/health" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
        i=$((i + 1))
    done
    return 1
}

# ── OS Detection ──────────────────────────────────────────────────────────────
detect_os() {
    case "$(uname -s)" in
        Darwin) echo "macos" ;;
        Linux)  echo "linux" ;;
        *)      echo "unknown" ;;
    esac
}

OS=$(detect_os)

if [ "$OS" = "unknown" ]; then
    err "Unsupported operating system: $(uname -s)"
    exit 1
fi

# ── Python Detection ──────────────────────────────────────────────────────────
find_python3() {
    # Prefer Homebrew python on macOS, then check common paths
    local candidates=(
        /opt/homebrew/bin/python3   # macOS Apple Silicon Homebrew
        /usr/local/bin/python3      # macOS Intel Homebrew
        /usr/bin/python3            # System Python
        python3                     # PATH
    )
    for p in "${candidates[@]}"; do
        if command -v "$p" >/dev/null 2>&1; then
            echo "$p"
            return
        fi
    done
    echo ""
}

PYTHON3=$(find_python3)

# ── Argument Parsing ──────────────────────────────────────────────────────────
MODE="install"
for arg in "$@"; do
    case "$arg" in
        --uninstall) MODE="uninstall" ;;
        --update)    MODE="update" ;;
        --help|-h)
            echo "Usage: $0 [--install|--update|--uninstall]"
            echo "  (default) install   - Full installation"
            echo "  --update            - Update scripts only"
            echo "  --uninstall         - Remove all components"
            exit 0
            ;;
    esac
done

# ── Uninstall ─────────────────────────────────────────────────────────────────
do_uninstall() {
    echo "=== ZellijConnect Uninstaller ==="

    step "1/3" "Stopping service..."
    if [ "$OS" = "macos" ]; then
        PLIST="$HOME/Library/LaunchAgents/com.zellijconnect.session-status-server.plist"
        launchctl unload "$PLIST" 2>/dev/null || true
        rm -f "$PLIST"
        ok "LaunchAgent removed"
    elif [ "$OS" = "linux" ]; then
        SERVICE_FILE="$HOME/.config/systemd/user/session-status-server.service"
        systemctl --user stop session-status-server 2>/dev/null || true
        systemctl --user disable session-status-server 2>/dev/null || true
        rm -f "$SERVICE_FILE"
        systemctl --user daemon-reload 2>/dev/null || true
        ok "systemd service removed"
    fi

    step "2/3" "Removing scripts..."
    rm -f "$INSTALL_DIR/session-status-server.py"
    rm -f "$INSTALL_DIR/claude-status-hook.sh"
    ok "Scripts removed from $INSTALL_DIR"

    step "3/3" "Note on remaining files..."
    warn "Claude Code hooks in $CLAUDE_SETTINGS were NOT removed. Remove manually if needed."
    warn "Status files in ~/.claude-status/ were NOT removed. Remove with: rm -rf ~/.claude-status"

    echo ""
    echo "=== Uninstall Complete ==="
}

# ── Install / Update ──────────────────────────────────────────────────────────
do_install() {
    local update_only="${1:-false}"

    if [ "$update_only" = "true" ]; then
        echo "=== ZellijConnect Script Updater ==="
    else
        echo "=== ZellijConnect Session Status Server Installer ==="
        echo "  OS: $OS | Python: ${PYTHON3:-not found}"
    fi

    # ── Dependency Checks ────────────────────────────────────────────────────
    if [ "$update_only" = "false" ]; then
        step "0/5" "Checking dependencies..."

        if [ -z "$PYTHON3" ]; then
            err "python3 not found. Install it first:"
            if [ "$OS" = "macos" ]; then
                echo "       brew install python3"
            else
                echo "       sudo apt install python3   # Debian/Ubuntu"
                echo "       sudo dnf install python3   # Fedora/RHEL"
            fi
            exit 1
        fi
        ok "python3: $($PYTHON3 --version)"

        if command -v zellij >/dev/null 2>&1; then
            ok "zellij: $(zellij --version)"
        else
            warn "zellij not found. Install from: https://zellij.dev/documentation/installation"
        fi

        if command -v git >/dev/null 2>&1; then
            ok "git: $(git --version | head -1)"
        else
            warn "git not found (needed for git status features)"
        fi

        if command -v tailscale >/dev/null 2>&1; then
            ok "tailscale: $(tailscale version 2>/dev/null | head -1)"
        else
            warn "tailscale not found (optional, needed for HTTPS remote access)"
        fi
    fi

    # ── Install Scripts ───────────────────────────────────────────────────────
    step "1/5" "Installing scripts to $INSTALL_DIR..."
    mkdir -p "$INSTALL_DIR"

    cp "$SCRIPT_DIR/session-status-server.py" "$INSTALL_DIR/"
    chmod +x "$INSTALL_DIR/session-status-server.py"
    ok "session-status-server.py → $INSTALL_DIR/"

    cp "$SCRIPT_DIR/claude-status-hook.sh" "$INSTALL_DIR/"
    chmod +x "$INSTALL_DIR/claude-status-hook.sh"
    ok "claude-status-hook.sh → $INSTALL_DIR/"

    # If update-only, restart service and exit
    if [ "$update_only" = "true" ]; then
        echo ""
        step "–" "Restarting service..."
        restart_service
        echo ""
        echo "=== Update Complete ==="
        echo ""
        test_server
        return
    fi

    # ── Auto-Start Service ────────────────────────────────────────────────────
    step "2/5" "Configuring auto-start service..."

    if [ "$OS" = "macos" ]; then
        install_launchagent
    elif [ "$OS" = "linux" ]; then
        install_systemd
    fi

    # ── Tailscale HTTPS ───────────────────────────────────────────────────────
    step "3/5" "Configuring Tailscale HTTPS..."

    if command -v tailscale >/dev/null 2>&1; then
        tailscale serve --bg --https "$SERVICE_PORT" "http://localhost:$SERVICE_PORT" 2>/dev/null || true
        ok "Tailscale HTTPS proxy configured on port $SERVICE_PORT"
        HOSTNAME=$(tailscale status --json 2>/dev/null | "$PYTHON3" -c \
            "import sys,json; d=json.load(sys.stdin); print(d['Self']['DNSName'])" 2>/dev/null || echo "")
        if [ -n "$HOSTNAME" ]; then
            ok "HTTPS endpoint: https://${HOSTNAME}${SERVICE_PORT}/api/sessions"
        fi
    else
        warn "Tailscale not found. For HTTPS access, install Tailscale then run:"
        echo "         tailscale serve --bg --https $SERVICE_PORT http://localhost:$SERVICE_PORT"
    fi

    # ── Claude Code Hooks ─────────────────────────────────────────────────────
    step "4/5" "Configuring Claude Code hooks..."
    configure_claude_hooks

    # ── Zellij Config Reminder ────────────────────────────────────────────────
    step "5/5" "Zellij keybinding reminder..."
    check_zellij_config

    # ── Final Summary ─────────────────────────────────────────────────────────
    echo ""
    echo "=== Installation Complete ==="
    echo ""
    test_server
    echo ""
    echo "View logs:"
    if [ "$OS" = "macos" ]; then
        echo "  tail -f /tmp/session-status-server.log"
        echo "  tail -f /tmp/session-status-server.error.log"
    else
        echo "  journalctl --user -u session-status-server -f"
    fi
    echo ""
    echo "To update scripts later:  ./install.sh --update"
    echo "To uninstall:             ./install.sh --uninstall"
}

# ── macOS LaunchAgent ─────────────────────────────────────────────────────────
install_launchagent() {
    local LAUNCHAGENT_DIR="$HOME/Library/LaunchAgents"
    local PLIST_DEST="$LAUNCHAGENT_DIR/com.zellijconnect.session-status-server.plist"
    local SCRIPT_PATH="$INSTALL_DIR/session-status-server.py"

    mkdir -p "$LAUNCHAGENT_DIR"

    # Unload existing service if running
    launchctl unload "$PLIST_DEST" 2>/dev/null || true

    # Detect cargo bin path for zellij
    local CARGO_BIN="${HOME}/.cargo/bin"
    if [ ! -d "$CARGO_BIN" ]; then
        CARGO_BIN="/usr/local/bin"
    fi

    # Generate plist with correct paths
    sed -e "s|PYTHON3_PATH|${PYTHON3}|g" \
        -e "s|SESSION_SERVER_SCRIPT_PATH|${SCRIPT_PATH}|g" \
        -e "s|CARGO_BIN_PATH|${CARGO_BIN}|g" \
        "$SCRIPT_DIR/com.zellijconnect.session-status-server.plist" \
        > "$PLIST_DEST"

    launchctl load "$PLIST_DEST" 2>/dev/null || true
    launchctl kickstart -k "gui/$(id -u)/com.zellijconnect.session-status-server" 2>/dev/null || true

    if wait_for_health 15; then
        ok "LaunchAgent installed and running"
    else
        warn "LaunchAgent loaded but server not responding on port $SERVICE_PORT"
        warn "Check: tail /tmp/session-status-server.error.log"
    fi
}

# ── Linux systemd User Service ────────────────────────────────────────────────
install_systemd() {
    local SYSTEMD_DIR="$HOME/.config/systemd/user"
    local SERVICE_FILE="$SYSTEMD_DIR/session-status-server.service"
    local SCRIPT_PATH="$INSTALL_DIR/session-status-server.py"

    mkdir -p "$SYSTEMD_DIR"

    cat > "$SERVICE_FILE" << EOF
[Unit]
Description=ZellijConnect Session Status Server
After=network.target

[Service]
Type=simple
ExecStart=${PYTHON3} ${SCRIPT_PATH}
Restart=on-failure
RestartSec=5
Environment=SESSION_SERVER_PORT=${SERVICE_PORT}
Environment=PATH=${HOME}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

    systemctl --user daemon-reload
    systemctl --user enable session-status-server
    systemctl --user restart session-status-server

    if wait_for_health 15; then
        ok "systemd user service installed and running"
    else
        warn "Service not responding on port $SERVICE_PORT"
        warn "Check: journalctl --user -u session-status-server -n 20"
    fi
}

# ── Restart Service ───────────────────────────────────────────────────────────
restart_service() {
    if [ "$OS" = "macos" ]; then
        local PLIST="$HOME/Library/LaunchAgents/com.zellijconnect.session-status-server.plist"
        local LABEL="com.zellijconnect.session-status-server"
        if [ -f "$PLIST" ]; then
            launchctl unload "$PLIST" 2>/dev/null || true
            sleep 1
            launchctl load "$PLIST" 2>/dev/null || true
            # `load` does not reliably (re)spawn a service that was just
            # replaced; kickstart -k force-restarts it now.
            launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true
            if wait_for_health 15; then
                ok "Service restarted successfully"
            else
                err "Server not responding on port $SERVICE_PORT after restart"
                warn "Check: tail /tmp/session-status-server.error.log"
            fi
        else
            warn "LaunchAgent not installed. Run ./install.sh first."
        fi
    elif [ "$OS" = "linux" ]; then
        if systemctl --user is-enabled session-status-server >/dev/null 2>&1; then
            systemctl --user restart session-status-server
            if wait_for_health 15; then
                ok "Service restarted successfully"
            else
                err "Server not responding on port $SERVICE_PORT after restart"
                warn "Check: journalctl --user -u session-status-server -n 20"
            fi
        else
            warn "systemd service not installed. Run ./install.sh first."
        fi
    fi
}

# ── Claude Code Hooks ─────────────────────────────────────────────────────────
configure_claude_hooks() {
    local HOOK_CMD="$INSTALL_DIR/claude-status-hook.sh"
    mkdir -p "$(dirname "$CLAUDE_SETTINGS")"

    if [ -f "$CLAUDE_SETTINGS" ]; then
        cp "$CLAUDE_SETTINGS" "$CLAUDE_SETTINGS.backup.$(date +%Y%m%d%H%M%S)"

        if grep -q "claude-status-hook" "$CLAUDE_SETTINGS" 2>/dev/null; then
            ok "Claude hooks already configured in $CLAUDE_SETTINGS"
            return
        fi

        warn "Existing $CLAUDE_SETTINGS found but hooks not configured."
        echo "    Add these hooks manually to $CLAUDE_SETTINGS:"
        print_hooks_json "$HOOK_CMD"
    else
        # Create new settings file
        cat > "$CLAUDE_SETTINGS" << EOF
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [{"type": "command", "command": "${HOOK_CMD} session-start"}]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [{"type": "command", "command": "${HOOK_CMD} pre-tool"}]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [{"type": "command", "command": "${HOOK_CMD} post-tool"}]
      }
    ],
    "Notification": [
      {
        "hooks": [{"type": "command", "command": "${HOOK_CMD} notification"}]
      }
    ],
    "Stop": [
      {
        "hooks": [{"type": "command", "command": "${HOOK_CMD} stop"}]
      }
    ]
  }
}
EOF
        ok "Created $CLAUDE_SETTINGS with hooks"
    fi
}

print_hooks_json() {
    local HOOK_CMD="$1"
    cat << EOF

  "hooks": {
    "SessionStart": [{"hooks": [{"type": "command", "command": "${HOOK_CMD} session-start"}]}],
    "PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "${HOOK_CMD} pre-tool"}]}],
    "PostToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "${HOOK_CMD} post-tool"}]}],
    "Notification": [{"hooks": [{"type": "command", "command": "${HOOK_CMD} notification"}]}],
    "Stop": [{"hooks": [{"type": "command", "command": "${HOOK_CMD} stop"}]}]
  }

EOF
}

# ── Zellij Config Check ───────────────────────────────────────────────────────
check_zellij_config() {
    local ZELLIJ_CONFIG="$HOME/.config/zellij/config.kdl"
    if [ -f "$ZELLIJ_CONFIG" ] && grep -q "Ctrl Shift Alt k" "$ZELLIJ_CONFIG"; then
        ok "Zellij scroll keybindings already configured"
    else
        warn "Add scroll keybindings to $ZELLIJ_CONFIG:"
        cat << 'EOF'

    keybinds {
        shared {
            bind "Ctrl Shift Alt k" { ScrollUp; }
            bind "Ctrl Shift Alt j" { ScrollDown; }
        }
    }

EOF
    fi
}

# ── Server Test ───────────────────────────────────────────────────────────────
test_server() {
    if wait_for_health 15; then
        local SESSION_COUNT
        SESSION_COUNT=$(curl -s "http://localhost:$SERVICE_PORT/api/sessions" | \
            "$PYTHON3" -c "import sys,json; d=json.load(sys.stdin); print(len(d['sessions']))" 2>/dev/null || echo "?")
        ok "Server running at http://localhost:$SERVICE_PORT"
        ok "Active sessions: $SESSION_COUNT"
        echo ""
        echo "Test with:"
        echo "  curl http://localhost:$SERVICE_PORT/api/sessions | python3 -m json.tool"
    else
        err "Server not responding on port $SERVICE_PORT"
    fi
}

# ── Main ──────────────────────────────────────────────────────────────────────
case "$MODE" in
    install)   do_install "false" ;;
    update)    do_install "true" ;;
    uninstall) do_uninstall ;;
esac
