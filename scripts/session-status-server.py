#!/usr/bin/env python3
"""
Zellij Session Status Server

Provides a REST API for querying Zellij session information, Claude Code status,
and git branch status. Designed to work with the ZellijConnect Android app.

Endpoints:
  GET  /api/sessions        - List all sessions with status
  GET  /api/health          - Health check
  POST /api/restart-zellij  - Kill all Zellij sessions and restart server

Binds to port 7601 by default.

Zellij 0.44+ notes:
  - Session sockets live in /tmp/zellij-{uid}/contract_version_1/ (not 0.x.y/)
  - The POST /api/sessions endpoint returns success immediately and lets the Zellij
    web client (browser) create sessions via FirstClientConnected.
  - A "gateway" session is auto-created on startup via PTY with a drain thread to
    keep the Zellij client's stdout from blocking.
"""

import json
import os
import re
import shutil
import signal
import subprocess
import http.server
import socketserver
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import time

# Configuration
PORT = int(os.environ.get('SESSION_SERVER_PORT', 7601))
STATUS_DIR = Path.home() / '.claude-status'
SESSION_CWD_MAP_FILE = Path.home() / '.zellij-session-cwd.json'
CACHE_TTL_SECONDS = 2

# Cache for session data
_cache = {
    'data': None,
    'timestamp': 0
}


# Serializes read-modify-write of the session->cwd map now that the server is
# multi-threaded (concurrent DELETEs would otherwise clobber each other).
_cwd_map_lock = threading.Lock()


def _run_raw(cmd, cwd=None, timeout=5):
    """Run a shell command, reaping the WHOLE process group on timeout.

    Returns (stdout, stderr, returncode); returncode is None if the command
    timed out (and was force-killed) or never launched.

    start_new_session=True puts the shell *and any binary it spawns* (e.g. a
    `zellij` client blocking on a wedged server) in a dedicated process group,
    so a timeout kills the entire tree via killpg. The old subprocess.run()
    timeout only killed the /bin/sh wrapper, orphaning the `zellij` grandchild —
    those dangling clients are what fueled the duplicate-server storm and
    required screen-sharing in to recover.
    """
    try:
        proc = subprocess.Popen(
            cmd, shell=True, cwd=cwd,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            start_new_session=True,
        )
    except Exception as e:
        return '', str(e), None
    try:
        out, err = proc.communicate(timeout=timeout)
        return out.strip(), err.strip(), proc.returncode
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        try:
            out, err = proc.communicate(timeout=2)
        except Exception:
            out, err = '', ''
        return (out or '').strip(), (err or '').strip(), None
    except Exception as e:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            pass
        return '', str(e), None


def run_command(cmd, cwd=None, timeout=5):
    """Run a shell command and return stdout, or None on error/timeout."""
    out, _err, rc = _run_raw(cmd, cwd=cwd, timeout=timeout)
    return out if rc == 0 else None


def run_command_verbose(cmd, cwd=None, timeout=5):
    """Run a shell command, return (stdout, stderr, success)."""
    out, err, rc = _run_raw(cmd, cwd=cwd, timeout=timeout)
    return out, err, rc == 0


def _zellij_base_dir():
    return Path(tempfile.gettempdir()) / f'zellij-{os.getuid()}'


def _session_socket_paths(session_name):
    """Existing socket paths for a session across all version/contract dirs."""
    base_dir = _zellij_base_dir()
    paths = []
    if base_dir.exists():
        for entry in base_dir.iterdir():
            if entry.is_dir() and re.match(r'^(\d+\.\d+|contract_version_\d+)', entry.name):
                sock = entry / session_name
                if sock.exists():
                    paths.append(sock)
    return paths


def _pids_holding(path):
    """PIDs with the given file/socket open, via lsof. Empty on any error."""
    out = run_command(f'lsof -t "{path}" 2>/dev/null', timeout=5)
    if not out:
        return []
    return [int(p) for p in out.split('\n') if p.strip().isdigit()]


def _kill_pids(pids, grace=0.5):
    """SIGTERM then SIGKILL a set of PIDs, never touching our own process."""
    pids = [p for p in dict.fromkeys(pids) if p and p != os.getpid()]
    if not pids:
        return
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception:
            pass
    time.sleep(grace)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except Exception:
            pass


def filesystem_delete_session(session_name):
    """Remove a session at the filesystem level, bypassing zellij IPC.

    Kills whatever process holds the session socket, then removes the socket
    file. This is the fallback for when `zellij kill-session`/`delete-session`
    hang because the server is wedged — exactly when IPC-based deletion is
    least reliable. Returns True if no socket remains afterward.
    """
    sockets = _session_socket_paths(session_name)
    if not sockets:
        return True  # already gone
    for sock in sockets:
        _kill_pids(_pids_holding(sock))
    for sock in _session_socket_paths(session_name):
        try:
            sock.unlink()
        except Exception:
            if sock.is_dir():
                shutil.rmtree(sock, ignore_errors=True)
    return not _session_socket_paths(session_name)


def get_zellij_sessions():
    """Get list of active Zellij session names.

    Scans socket directories directly to handle version mismatches between
    the installed zellij binary version and running session server versions.

    Zellij uses version-specific socket subdirectories:
      - 0.43.x: /tmp/zellij-{uid}/0.43.1/{session-name}
      - 0.44+:  /tmp/zellij-{uid}/contract_version_1/{session-name}
    """
    SKIP_NAMES = {'web_server_bus'}

    uid = os.getuid()
    base_dir = Path(tempfile.gettempdir()) / f'zellij-{uid}'

    if base_dir.exists():
        sessions = set()
        for entry in base_dir.iterdir():
            # Match both old-style version dirs (e.g. "0.43.1") and
            # new-style contract dirs (e.g. "contract_version_1" used in 0.44+)
            if entry.is_dir() and re.match(r'^(\d+\.\d+|contract_version_\d+)', entry.name):
                for sock in entry.iterdir():
                    if sock.name not in SKIP_NAMES:
                        sessions.add(sock.name)
        if sessions:
            return sorted(sessions)

    # Fallback: use zellij list-sessions (only returns non-EXITED sessions)
    output = run_command('zellij list-sessions -n 2>/dev/null')
    if not output:
        return []
    result = []
    for line in output.split('\n'):
        line = line.strip()
        if line and not line.startswith('No active') and '(EXITED' not in line:
            session_name = line.split()[0] if line.split() else line
            result.append(session_name)
    return result


def create_zellij_session(session_name):
    """Reserve a named session slot for the Zellij web client to create.

    We intentionally do NOT pre-create the session via a PTY here.
    Pre-creating via PTY causes Zellij to send SIGHUP to the temporary client
    when we close the PTY master, which triggers on_force_close and kills all
    panes.  The web client then attaches to a dead session (no panes) and
    renders a blank screen — the control WebSocket never opens, and the
    terminal stays stuck.

    Instead we just validate the name and return success.  When the Zellij web
    client (browser) opens the session URL it sends FirstClientConnected for a
    non-existent session, which properly initialises a shell pane and renders.
    """
    if session_name in get_zellij_sessions():
        return True, 'already exists'

    # Validate that zellij is available (sanity check only)
    zellij_bin = shutil.which('zellij') or os.path.expanduser('~/.cargo/bin/zellij')
    if not os.path.isfile(zellij_bin):
        return False, 'zellij binary not found'

    return True, 'reserved'  # browser will create session via FirstClientConnected


def get_session_cwd_map():
    """Load session-to-cwd mapping from file."""
    if SESSION_CWD_MAP_FILE.exists():
        try:
            with open(SESSION_CWD_MAP_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def save_session_cwd_map(mapping):
    """Save session-to-cwd mapping to file."""
    try:
        with open(SESSION_CWD_MAP_FILE, 'w') as f:
            json.dump(mapping, f, indent=2)
    except Exception:
        pass


def get_claude_status(session_name):
    """Read Claude Code status for a session."""
    status_file = STATUS_DIR / f'{session_name}.json'
    if status_file.exists():
        try:
            with open(status_file) as f:
                data = json.load(f)
                # Check if status is stale (>5 minutes old)
                if 'timestamp' in data:
                    try:
                        ts = datetime.fromisoformat(data['timestamp'].replace('Z', '+00:00'))
                        age = (datetime.now(ts.tzinfo) - ts).total_seconds()
                        if age > 300:  # 5 minutes
                            data['status'] = 'stale'
                    except Exception:
                        pass
                return data
        except Exception:
            pass
    return {
        'status': 'unknown',
        'activity': None,
        'lastUpdate': None
    }


def get_git_status(cwd):
    """Get git branch status for a directory."""
    if not cwd or not os.path.isdir(cwd):
        return None

    git_dir = os.path.join(cwd, '.git')
    if not os.path.exists(git_dir):
        return None

    # Get current branch
    branch = run_command('git branch --show-current', cwd=cwd)
    if not branch:
        return None

    # Check if merged to dev
    merged_branches = run_command('git branch --merged dev 2>/dev/null', cwd=cwd)
    merged_to_dev = branch in (merged_branches or '').split() if merged_branches else False

    # Check if remote branch exists
    remote_check = run_command(f'git ls-remote --heads origin {branch} 2>/dev/null', cwd=cwd)
    remote_exists = bool(remote_check)

    # Get last commit info
    last_commit = run_command('git log -1 --format="%s" 2>/dev/null', cwd=cwd)

    # Check for uncommitted changes
    porcelain = run_command('git status --porcelain', cwd=cwd)
    has_uncommitted_changes = bool(porcelain)

    # Count unpushed commits
    unpushed_str = run_command('git rev-list @{u}..HEAD --count 2>/dev/null', cwd=cwd)
    try:
        unpushed_commit_count = int(unpushed_str) if unpushed_str is not None else 0
    except (ValueError, TypeError):
        unpushed_commit_count = 0

    # Check if this is a worktree
    has_worktree = '/.worktrees/' in cwd

    return {
        'branch': branch,
        'mergedToDev': merged_to_dev,
        'remoteBranchExists': remote_exists,
        'lastCommit': last_commit,
        'hasUncommittedChanges': has_uncommitted_changes,
        'unpushedCommitCount': unpushed_commit_count,
        'hasWorktree': has_worktree
    }


def get_all_sessions():
    """Get all session data with caching."""
    now = time.time()
    if _cache['data'] and (now - _cache['timestamp']) < CACHE_TTL_SECONDS:
        return _cache['data']

    sessions = []
    session_names = get_zellij_sessions()
    cwd_map = get_session_cwd_map()

    for name in session_names:
        cwd = cwd_map.get(name)
        claude_status = get_claude_status(name)
        git_status = get_git_status(cwd) if cwd else None

        sessions.append({
            'name': name,
            'workingDirectory': cwd,
            'claude': claude_status,
            'git': git_status
        })

    result = {
        'sessions': sessions,
        'timestamp': datetime.now(tz=timezone.utc).isoformat().replace('+00:00', 'Z')
    }

    _cache['data'] = result
    _cache['timestamp'] = now

    return result


class SessionStatusHandler(http.server.BaseHTTPRequestHandler):
    """HTTP request handler for session status API."""

    def _set_headers(self, status=200, content_type='application/json'):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_OPTIONS(self):
        self._set_headers(204)

    def do_POST(self):
        path = urlparse(self.path).path

        if path == '/api/sessions':
            self._handle_create_session()
        elif path == '/api/restart-zellij':
            self._handle_restart_zellij()
        else:
            self._set_headers(404)
            self.wfile.write(json.dumps({'error': 'Not found'}).encode())

    def _handle_create_session(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length) if content_length else b'{}'

        try:
            data = json.loads(body.decode('utf-8'))
        except Exception:
            self._set_headers(400)
            self.wfile.write(json.dumps({'error': 'Invalid JSON'}).encode())
            return

        session_name = data.get('name', '').strip()
        if not session_name or not re.match(r'^[a-zA-Z0-9_-]+$', session_name):
            self._set_headers(400)
            self.wfile.write(json.dumps({'error': 'Invalid session name'}).encode())
            return

        success, message = create_zellij_session(session_name)
        if success:
            _cache['data'] = None  # Invalidate cached session list
            self._set_headers(200)
            self.wfile.write(json.dumps({'success': True, 'name': session_name, 'message': message}).encode())
        else:
            self._set_headers(500)
            self.wfile.write(json.dumps({'error': message}).encode())

    def do_GET(self):
        path = urlparse(self.path).path

        if path == '/api/sessions':
            self._set_headers(200)
            data = get_all_sessions()
            self.wfile.write(json.dumps(data, indent=2).encode())

        elif path == '/api/health':
            self._set_headers(200)
            self.wfile.write(json.dumps({'status': 'ok'}).encode())

        elif path == '/':
            self._set_headers(200, 'text/html')
            html = '''<!DOCTYPE html>
<html>
<head><title>Session Status Server</title></head>
<body>
<h1>Zellij Session Status Server</h1>
<p>Endpoints:</p>
<ul>
<li><a href="/api/sessions">/api/sessions</a> - List all sessions</li>
<li><a href="/api/health">/api/health</a> - Health check</li>
<li>POST <a href="/api/restart-zellij">/api/restart-zellij</a> - Restart Zellij server</li>
</ul>
</body>
</html>'''
            self.wfile.write(html.encode())

        else:
            self._set_headers(404)
            self.wfile.write(json.dumps({'error': 'Not found'}).encode())

    def _handle_restart_zellij(self):
        """Kill all Zellij sessions and reap orphaned processes — safely.

        A blanket `pkill -f zellij` also kills the web server on port 7600 (so
        the Android terminal dies and needs a screen-share to recover) and any
        unrelated process whose command line merely contains "zellij". Instead
        we tear down each session at the filesystem level and then reap stray
        zellij processes while explicitly PRESERVING the web server.
        """
        errors = []

        # Identify the web server (port 7600) so we never kill it.
        web_pids = set()
        web_out = run_command('lsof -ti tcp:7600 2>/dev/null', timeout=5)
        if web_out:
            web_pids = {int(p) for p in web_out.split() if p.strip().isdigit()}

        # Step 1: kill every discoverable session (IPC best-effort + filesystem).
        sessions = get_zellij_sessions()
        for name in sessions:
            run_command_verbose(f'zellij kill-session {name}', timeout=7)
            run_command_verbose(f'zellij delete-session --force {name}', timeout=7)
            if not filesystem_delete_session(name):
                errors.append(f'Failed to remove session: {name}')

        # Step 2: reap orphaned zellij processes, but NOT the web server or us.
        # The [z] bracket keeps the pattern from matching our own helper shell.
        pgrep = run_command("pgrep -f '[z]ellij' 2>/dev/null", timeout=5)
        if pgrep:
            orphan_pids = [
                int(p) for p in pgrep.split('\n')
                if p.strip().isdigit() and int(p) not in web_pids
            ]
            _kill_pids(orphan_pids)

        time.sleep(1)

        # Step 3: Clean up all status files
        if STATUS_DIR.exists():
            for f in STATUS_DIR.iterdir():
                try:
                    f.unlink()
                except Exception:
                    pass

        # Step 4: Clear session CWD map
        with _cwd_map_lock:
            try:
                save_session_cwd_map({})
            except Exception:
                pass

        # Step 5: Invalidate cache
        _cache['data'] = None
        _cache['timestamp'] = 0

        # Step 6: Verify via the filesystem (NOT `zellij list-sessions`, which
        # can spawn a fresh server and hang). Any remaining socket is a failure.
        remaining = get_zellij_sessions()
        recovered = not remaining and not errors

        self._set_headers(200)
        self.wfile.write(json.dumps({
            'success': recovered,
            'sessionsKilled': len(sessions),
            'remaining': remaining,
            'message': (
                f'Killed {len(sessions)} session(s). Zellij is clean.' if recovered
                else f'Killed {len(sessions)} session(s); '
                     f'{len(remaining)} socket(s) remain. Errors: {"; ".join(errors)}'
            ),
            'errors': errors
        }).encode())

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        # Match /api/sessions/{name}
        match = re.match(r'^/api/sessions/(.+)$', path)
        if not match:
            self._set_headers(404)
            self.wfile.write(json.dumps({'error': 'Not found'}).encode())
            return

        session_name = match.group(1)
        delete_worktree = params.get('deleteWorktree', ['false'])[0].lower() == 'true'
        delete_branch = params.get('deleteBranch', ['false'])[0].lower() == 'true'

        # Look up session CWD and branch BEFORE killing
        cwd_map = get_session_cwd_map()
        session_cwd = cwd_map.get(session_name)
        session_branch = None
        if session_cwd and os.path.isdir(session_cwd):
            session_branch = run_command('git branch --show-current', cwd=session_cwd)

        # 1) Graceful kill via IPC. Short timeout: if the server is wedged we
        #    fall through to the filesystem path fast instead of blocking.
        print(f'[DELETE] kill-session: {session_name}', flush=True)
        _, kill_stderr, kill_ok = run_command_verbose(
            f'zellij kill-session {session_name}', timeout=7)
        if not kill_ok:
            print(f'[DELETE] kill-session stderr: {kill_stderr}', flush=True)

        # 2) Force-delete the (now exited) session socket via IPC, one shot.
        #    --force kills+deletes even if the session hasn't fully exited yet,
        #    so we no longer need the fragile sleep-then-delete dance.
        _, del_stderr, del_ok = run_command_verbose(
            f'zellij delete-session --force {session_name}', timeout=7)
        if not del_ok:
            print(f'[DELETE] delete-session stderr: {del_stderr}', flush=True)

        # 3) Guarantee removal at the filesystem level even if IPC was wedged.
        session_removed = filesystem_delete_session(session_name)
        print(f'[DELETE] filesystem cleanup, socket_gone={session_removed}', flush=True)

        # Clean up status files
        status_json = STATUS_DIR / f'{session_name}.json'
        status_desc = STATUS_DIR / f'{session_name}.desc'
        if status_json.exists():
            status_json.unlink()
        if status_desc.exists():
            status_desc.unlink()

        # Remove from CWD map (locked read-modify-write — concurrent deletes)
        with _cwd_map_lock:
            cwd_map = get_session_cwd_map()
            if session_name in cwd_map:
                del cwd_map[session_name]
                save_session_cwd_map(cwd_map)

        worktree_removed = False
        branch_deleted = False

        # Handle worktree cleanup
        if delete_worktree and session_cwd and '/.worktrees/' in session_cwd:
            # Find main repo by looking for the parent of .worktrees
            worktree_parent = session_cwd.split('/.worktrees/')[0]

            # Try git worktree remove first, with retries (processes may still be exiting)
            for attempt in range(1, 4):
                print(f'[DELETE] git worktree remove attempt {attempt}/3: {session_cwd}', flush=True)
                _, wt_stderr, wt_ok = run_command_verbose(
                    f'git worktree remove --force "{session_cwd}"', cwd=worktree_parent, timeout=15
                )
                if wt_ok:
                    worktree_removed = True
                    break
                print(f'[DELETE] worktree remove failed: {wt_stderr}', flush=True)
                if attempt < 3:
                    time.sleep(1)

            if not worktree_removed:
                # Fallback: rm -rf + prune
                print(f'[DELETE] Falling back to shutil.rmtree for: {session_cwd}', flush=True)
                try:
                    shutil.rmtree(session_cwd, ignore_errors=True)
                    run_command('git worktree prune', cwd=worktree_parent)
                    worktree_removed = True
                except Exception as e:
                    print(f'[DELETE] rmtree fallback failed: {e}', flush=True)

            # Delete branch if requested
            if delete_branch and session_branch:
                print(f'[DELETE] Deleting branch: {session_branch}', flush=True)
                _, br_stderr, br_ok = run_command_verbose(
                    f'git branch -D {session_branch}', cwd=worktree_parent, timeout=10
                )
                if br_ok:
                    branch_deleted = True
                else:
                    print(f'[DELETE] branch delete failed: {br_stderr}', flush=True)

        # Invalidate cache
        _cache['data'] = None
        _cache['timestamp'] = 0

        print(f'[DELETE] Done: {session_name} removed={session_removed} '
              f'worktreeRemoved={worktree_removed} branchDeleted={branch_deleted}', flush=True)
        self._set_headers(200)
        self.wfile.write(json.dumps({
            'success': session_removed,
            'killed': session_name,
            'sessionRemoved': session_removed,
            'worktreeRemoved': worktree_removed,
            'branchDeleted': branch_deleted
        }).encode())

    def log_message(self, format, *args):
        # Suppress default logging, or customize as needed
        pass


def main():
    # Ensure status directory exists
    STATUS_DIR.mkdir(exist_ok=True)

    # Threaded so a slow request (e.g. a DELETE that waits on zellij IPC or a
    # worktree removal) can't freeze every other request — that single-threaded
    # head-of-line block is what made the whole app appear hung.
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(('127.0.0.1', PORT), SessionStatusHandler) as httpd:
        httpd.daemon_threads = True
        print(f'Session Status Server running on port {PORT}', flush=True)
        print(f'Status directory: {STATUS_DIR}', flush=True)
        print(f'Session CWD map: {SESSION_CWD_MAP_FILE}', flush=True)
        print(f'Endpoints:', flush=True)
        print(f'  http://localhost:{PORT}/api/sessions', flush=True)
        print(f'  http://localhost:{PORT}/api/health', flush=True)

        # NOTE: Gateway sessions are NOT pre-created via PTY — the PTY client
        # eventually dies (I/O error), corrupting session state and causing
        # cascading failures. Sessions are created on-demand when browsers
        # connect to the zellij web server (port 7600).

        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nShutting down...')


if __name__ == '__main__':
    main()
