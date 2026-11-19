# Phase C0 spike: Agent SDK, Playwright MCP, test daemon, part sources (M4, 2026-11-19)

Scripts and raw output: `/tmp/sc-c0` (`scripts/` fixtures and probes, `out/` raw results, `pw/`
the pinned Playwright MCP install, `webout/dist` a built web bundle).

**Versions:** `@anthropic-ai/claude-agent-sdk` 0.3.322 with bundled CLI 2.1.322,
`@playwright/mcp` **0.0.86**, Google Chrome 157.0.8103.79, bun 1.3.14, node 26.13.0.

**Side effects of the spike:** 11 short SDK queries were run with the daemon's Claude
subscription token, read from `~/.config/anvil/env` the way `test/tools/sdk-smoke.ts` documents
(about $0.19 list-price equivalent; the token was not printed or stored). One headed Chrome
window opened briefly with a throwaway profile.

## Verdicts

| # | Verdict | Evidence |
|---|---|---|
| A1 | Confirmed (run) | One `query()` with `settingSources: []`, `strictMcpConfig: true`, sdk + stdio + http servers all connected. |
| A2 | Confirmed (run) | The hook saw `mcp__echo__ping`, `mcp__web__ping`, `mcp__inproc__hello`; from a subagent the same `tool_name` with `agent_id` set. |
| A3 | Confirmed (run) | `tool_result.content` = `[{type:"text"},{type:"image",source:{type:"base64",media_type:"image/png",data}}]`. |
| A4 | Refuted in part | A stdio server inherits the CLI env (including `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_SESSION_ID`) but the CLI strips `CLAUDE_CODE_OAUTH_TOKEN`. The `/usr/bin/env -i` wrap works: the server saw only `HOME PATH TMPDIR`. `npx -y @playwright/mcp@0.0.86` starts under it. Stdio `env` in the config adds to the inherited env; it does not replace it. |
| A7 | Partly refuted | A failed server never fails the turn. `alwaysLoad: true` puts tools in the turn-1 prompt. **The "5 s cap" is false:** init blocks until every server connects or fails: 9.4 s for a 9 s-slow server, 27.4 s for one that never answers. |
| A8 | Confirmed, with one difference | Hook throws or returns no decision: `canUseTool` is called and honoured. Hook timeout: `canUseTool` is not called; the CLI blocks the call itself. All three fail closed. |
| A9 | Flag exists; not a control | `--blocked-origins` blocked a direct navigation, but `localhost` for the same server loaded and a redirect into the blocked origin was served. The proxy is the block. |
| A10 | Confirmed (run) | A plain session has zero `mcp__*` tools. `disallowedTools` removes the three resource tools. |
| S9 | Confirmed with caveats | Installed Chrome, a profile dir and a proxy all work. The page URL is reported when it changes, not in every result. |
| S10 | Confirmed (run) | Loopback-only daemon from the worktree with a temp HOME and no credentials; 0.72 s to healthy. |
| S11 | Partial | DigiKey: datasheets yes, model links unverified. Mouser: datasheets only. SnapEDA: terms bar automated access. TraceParts: has STEP, key by request. |

Not run: HTTPS through the proxy; whether `--disable-quic` and the WebRTC flag stop UDP leaks
(flags accepted, no UDP test); desktop detection with nobody logged in.

## Agent SDK facts

- `mcpServerStatus()` per server: `{name, status: "connected"|"failed"|…, serverInfo?, error?, config, transport, scope, source, tools:[{name, annotations}]}`. The init message carries `mcp_servers: [{name, status, source}]`, already correct at init, so the session notice can be built from it.
- Failure strings: missing binary `ENOENT: no such file or directory, posix_spawn '…'`; crash on launch `Connection closed`; hang `Request timed out`.
- In-process sdk server tools are also deferred behind ToolSearch unless marked always-load.
- A stdio server's cwd is the query's `cwd` (the session worktree).

## Playwright MCP 0.0.86

| Need | Flag / config |
|---|---|
| Installed Chrome | `--browser chrome` |
| Profile | `--user-data-dir <dir>` (cannot combine with `--isolated`) |
| Headed / headless | headed is the default; `--headless` |
| Throwaway profile | `--isolated` |
| Proxy | `--proxy-server http://127.0.0.1:<port>`; **never** pass `--proxy-bypass` |
| Extra Chrome args | `--config <file.json>` with `{"browser":{"launchOptions":{"args":[…]}}}` |
| Output and downloads | `--output-dir <dir>` plus `--file-paths absolute` |
| Page-registered tools | `--no-webmcp` (on by default: pages can register tools) |
| Same profile twice | The second server gets a tool error `Browser is already in use for <dir>` |

- Every flag has a `PLAYWRIGHT_MCP_*` env twin, and `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK`
  turns off loopback proxying, so the `env -i` wrap matters.
- **Playwright adds `--disable-blink-features=AutomationControlled` by itself** (so
  `navigator.webdriver` reads false). Setting
  `browser.launchOptions.ignoreDefaultArgs: ["--disable-blink-features=AutomationControlled"]`
  removes it (verified: `webdriver=true`).
- Playwright launches Chrome with `--password-store=basic --use-mock-keychain`, so profile
  cookies are not Keychain-protected.

### Proxy behaviour (headless Chrome, local fixtures)

| Case | Result |
|---|---|
| `--proxy-server` only | Loopback goes through the proxy (Playwright adds `--proxy-bypass-list=<-loopback>` itself). Raw Chrome would bypass. |
| Explicit `--proxy-bypass-list=<-loopback>` via config | Through the proxy; `localhost` and `[::1]` too. |
| Proxy refuses | The target is never contacted. The tool result is **not** an error: it shows `- HTTP status: 403 Forbidden` and the proxy's body renders as the page. |
| WebSocket to loopback | Arrives as `CONNECT 127.0.0.1:<port>`; refusal gives a WebSocket error in the page. |
| Per-port exemption | Allowing one loopback port at the proxy lets that port through (page and WebSocket). |

Chrome sends hostnames to the proxy unresolved, so the proxy must resolve, check, and connect to
the address it checked.

### Tools (25 by default)

| Class | Tools |
|---|---|
| Read-only | `browser_snapshot`, `browser_take_screenshot`, `browser_wait_for`, `browser_console_messages`, `browser_network_requests`, `browser_network_request`, `browser_find`, `browser_tabs` with `action:"list"` |
| Navigation | `browser_navigate {url}`, `browser_navigate_back`, `browser_tabs` with `action:"new"` (takes `url`), `"select"`, `"close"` |
| Input | `browser_click`, `browser_type`, `browser_press_key`, `browser_fill_form`, `browser_select_option`, `browser_drag`, `browser_hover`, `browser_handle_dialog`, `browser_drop` with `data` |
| Upload | `browser_file_upload {paths}`, `browser_drop` with `paths` |
| Script evaluation | `browser_evaluate {function}`, `browser_run_code_unsafe {code \| filename}` |
| Other | `browser_close`, `browser_resize`, `browser_emulate_media` |

- Element tools take `target` (the `ref` from a snapshot) plus a free-text `element`.
- There is no scroll tool by default.
- Several read tools accept a `filename` argument and write a file under the workspace root.
- The server refuses uploads outside its roots (output dir + cwd).
- The server blocks `file:` itself. It allows `chrome://` and `data:`. A `javascript:` URL
  **ran** before the navigation was reported as aborted.

### Result format

```
### Ran Playwright code
...
### Open tabs                      (only when tab count != 1)
- 0: [](about:blank)
- 1: (current) [Fixture Two](http://127.0.0.1:54982/page2)
### Page
- Page URL: http://127.0.0.1:54982/page2
- Page Title: Fixture Two
- HTTP status: 403 Forbidden       (only for non-2xx)
### Modal state                    (dialog or file chooser pending)
### Snapshot
- [Snapshot](/abs/path/page-<ISO>.yml)
### Events
- Downloaded file part.step to "/abs/path/part.step"
```

- URL marker: `/^### Page\n- Page URL: (.*)$/m`. Present when the result carries a snapshot or a
  tab's URL or title changed (final URL after redirects). Absent when nothing changed.
- Dialog messages and console output are page-controlled text in the same result, so a page
  could plausibly forge a second `### Page` block. Require exactly one.
- Errors: `### Error\n<text>` with `isError: true`.

### Downloads

Saved into `--output-dir` under the server-suggested name, any extension, no size limit. The
result says `- Downloading file <name> ...` and later `- Downloaded file <name> to "<path>"`; the
second line can arrive in the next tool's result. The same directory also fills with
`page-<ISO>.yml`, `page-<ISO>.png` and `console-<ISO>.log`.

### Cookie domains

`sqlite3 -readonly <profile>/Default/Cookies 'select host_key from cookies'` works while Chrome
runs, with a lag of up to about 30 s. Many sites set a cookie on first visit, so "has cookies"
is not the same as "logged in". The remote-debugging port also works but gives any local process
control of the browser; rejected.

### Desktop session detection

From an Aqua session: `launchctl managername` prints `Aqua`; `stat -f%Su /dev/console` prints the
user; `scutil <<< "show State:/Users/ConsoleUser"` gives `Name` and
`kCGSSessionOnConsoleKey : TRUE`. The logged-out case was not run.

## Throwaway test daemon

Environment that booted cleanly (`env -i`, cwd = the worktree's `anvild`):

```
PATH=<bun dir>:/usr/bin:/bin:/usr/sbin:/sbin
TMPDIR=<tmp>
HOME=<new temp dir>
ANVIL_HOST=127.0.0.1
ANVIL_PORT=<random>
ANVIL_STATE_DIR=$HOME/state
ANVIL_CLONES_DIR=$HOME/repos
ANVIL_WEB_DIR=<built dist>
ANVIL_BASE_URL=http://127.0.0.1:<port>
ANVIL_LAPO_DISABLE=1
```

- Web bundle with no repo writes: `ANVIL_BUILD_OUT=<dir> bun run web/build.ts`, then
  `ANVIL_WEB_DIR=<dir>/dist`.
- One listener on `127.0.0.1:<port>`; the tailnet address refused. `GET /` 200;
  `/api/health` `ok:true, subscriptionAuthOk:false`.
- Without credentials it logs "DEGRADED" and turns refuse.
- One outbound call remains at boot: the Claude CLI version check to `registry.npmjs.org`.
- Without `ANVIL_BASE_URL`, self-URL discovery shelled out to `tailscale` and
  `parseTailscalePeers` (`server/fleet.ts:126`) threw an unhandled rejection on non-JSON output.
  Non-fatal, but a real bug.

## Part sources (from web research; "unverified" = not read on a primary page)

| Source | Auth | Keyword search | Datasheet | 3D / STEP | Limits | Terms |
|---|---|---|---|---|---|---|
| DigiKey v4 | OAuth2 client credentials, `POST https://api.digikey.com/v1/oauth2/token`; headers `X-DIGIKEY-Client-Id` + Bearer; 10 min token | `POST /products/v4/search/keyword` `{Keywords, Limit, Offset}`; detail `GET /products/v4/search/{pn}/productdetails` | `DatasheetUrl` | `GET /search/{pn}/media` returns `MediaLinks[]`; STEP unverified | 120/min, 1000/day | No database building or bulk download; attribution. Sandbox at `sandbox-api.digikey.com`. |
| Mouser Search | `?apiKey=` | `POST /api/v1/search/keyword` `{SearchByKeywordRequest:{keyword, records, startingRecord}}` | `DataSheetUrl` | None | 30/min, 1000/day (unverified) | No caching or storing content; attribution (unverified). |
| SnapEDA | No public docs; request form | unverified | unverified | advertised | unverified | Site terms bar automated access. |
| TraceParts | `POST https://api-gateway.traceparts.com/v2/RequestToken` `{tenantUid, apiKey}` | Part-number availability only | None | Yes, via `cadRequest` + polling; needs `userEmail` | 3000/hour | Key by request, days to approve. |
