# Anvil Implementation Plan — Push, Tailscale & Ops
**Phase:** cross-cutting (push lands with each client; transport/ops with phase 1) | **Depends on:** daemon core, protocol.ts | **Status:** draft

## 1. Scope & goal
Three infra layers wrapping `anvild`:
- **(A) Push** — FCM (Android) + APNs (iOS) background push, sent *from the daemon*, with the live-WS connection as in-app fallback and a suppression rule. Additive: the daemon must run fully without it (§6.7).
- **(B) Tailscale transport & auth boundary** — expose WS + REST over the tailnet via `tailscale serve` (HTTPS + MagicDNS), tailnet ACL as the *primary client auth boundary* (single-user). §3's `CLAUDE_CODE_OAUTH_TOKEN` is **Claude auth, not client auth** — clients are trusted by being on the tailnet.
- **(C) Deploy/ops/migration** — macOS LaunchAgent + Linux systemd user service (replacing the Python `com.zellijconnect.session-status-server`), Bun launch, the §3 env-injection contract, logs, health/restart, updated `install.sh`, and a clean cutover retiring the Python server.
Constraints: single-user, no-sudo, `~/.local/bin`, `~/.config`/`~/Library/LaunchAgents`, poll-health-not-sleep (`wait_for_health`).

## 2. Decisions inherited
- **§3 (load-bearing):** authenticate Claude via `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`); refuse to start if `ANTHROPIC_API_KEY` set or token absent; `--bare` forbidden. Surfaced as `HealthResponse.subscriptionAuthOk`. Enforced in the service env block (§5) **and** asserted in-process.
- **§6.7 (#5/#8):** FCM/APNs background + live-WS fallback. Push fires on `permission.request` (§6.6) and `result`. A device holding a live WS gets the in-app event; the daemon **suppresses the redundant push to that device**. Cloud dependency accepted; daemon works without it.
- **Protocol:** only `PushRegisterCmd{platform:"fcm"|"apns", token, cid?}`. **No `push.unregister`, no server→client push-status** in the current protocol — see §9. Triggers are server-side side-effects of emitting `PermissionRequestEvent`/`ResultEvent` (no new server→client types).
- Transport: one WS + small REST (`/api/health`, `…/attachments`, `…/files`), both over Tailscale.
- Daemon TS/Bun, in-process — sender + health/auth self-check live in-process.

## 3. Push
**3.1 Architecture.** The daemon is the only sender (no relay). `PermissionRequestEvent`/`ResultEvent` → `NotificationRouter.shouldPush` (applies suppression) → for each registered device NOT connected-and-live → `FcmSender`/`ApnsSender`.
**3.2 Tokens.** Client sends `push.register{platform,token}` over the authed WS after connect. Persist `{token, platform, registeredAt, lastSeenConnectionId}` (`~/.local/state/anvil/push-tokens.json` or SQLite). Device-scoped. **Prune on provider invalid-token** (FCM 404 `UNREGISTERED`/400; APNs 410 `Unregistered`/400 `BadDeviceToken`); clients re-register every connect so rotation self-heals.
**3.3 FCM (Android, verified 2026).** `POST https://fcm.googleapis.com/v1/projects/{projectId}/messages:send` (HTTP v1; legacy server-key retired). Auth: OAuth2 Bearer from a **service-account JSON key**, scope `…/auth/firebase.messaging`, minted/refreshed by `google-auth-library`. Payload: `{message:{token, notification:{title,body}, data:{sessionId, kind:"permission"|"result", requestId?}, android:{priority:"high"}}}`. Cred path via `ANVIL_FCM_SERVICE_ACCOUNT`; absence disables FCM (warn, don't fail).
**3.4 APNs (iOS, verified 2026).** **Token-based `.p8`** (no expiry; sandbox+prod; all team apps) — need AuthKey + Key ID + Team ID. ES256 JWT `{alg:ES256,kid}`/`{iss:TeamID,iat}` as `authorization: bearer`, refresh ~30–50 min. **HTTP/2 mandatory** → prod `api.push.apple.com:443`, sandbox `api.sandbox.push.apple.com:443`, `POST /3/device/<token>`, headers `apns-topic`(bundle id), `apns-push-type:alert`, `apns-priority:10`. Bun `http2` or `@parse/node-apn`/`apns2`. Payload `{aps:{alert:{title,body},sound:"default"}, sessionId, kind, requestId?}`. `ANVIL_APNS_ENV=sandbox|production` toggle.
**3.5 Triggers (exactly two, §6.7).** `permission.request` (higher priority; carries `requestId` for deep-link); `result` (lower; per-session debounce against quick-turn spam). No push on `error`/`status` in v1 (open Q).
**3.6 Suppression.** Map `pushToken → connectionId` from `push.register`'s arrival connection. Recipients = all tokens minus tokens whose connection is open. **Nuance:** open WS ≠ foregrounded; **v1 = clients proactively drop/mark-background the WS on app-background** so the next trigger pushes (keeps the daemon rule simple).
**3.7 Fallback.** App open → events arrive over the live WS natively (that's the fallback, zero push infra). No provider creds → log once, run normally; `HealthResponse.ok` stays true. Push never on the startup critical path.

## 4. Tailscale transport & auth boundary
**4.1 Binding — localhost behind `serve`.** Daemon binds `127.0.0.1:<port>` only; exposed via `tailscale serve` which **terminates HTTPS with an auto MagicDNS cert** and reverse-proxies. Daemon never handles TLS / never listens routable. (Matches `install.sh` L216.)
**4.2 `serve` command.** `tailscale serve --bg --https <port> http://localhost:<port>` (the explicit form the repo already proved) or terse `tailscale serve --bg <port>`. WS upgrade is transparent through the reverse proxy. Keep the `|| true` guard; don't hard-fail on flag drift.
**4.3 Auth = the tailnet ACL.** No app login; the boundary is "you are on my tailnet." `serve` (unlike `funnel`) is never public — tailnet peers only. Right boundary for single-user.
**4.4 Optional identity (verified 2026).** `serve` injects `Tailscale-User-Login`/`-Name`/`-Profile-Pic` and **strips inbound copies first** (unspoofable). Daemon can optionally assert `Tailscale-User-Login == <owner>` (`ANVIL_REQUIRE_TS_USER`), cheap defense-in-depth. Programmatic alternative: LocalAPI `GET /localapi/v0/whois?addr=<ip:port>` (deferred to v2).
**4.5 URL discovery.** `tailscale status --json` → `.Self.DNSName` → `https://<DNSName>/` (port 443 via serve; explicit port only if non-443). Installer prints it; clients enter the stable MagicDNS name once; `GET /api/health` confirms reachability + the §3 self-check. **Fix the latent installer bug** that concatenates host+port without a colon.

## 5. Deployment & service management
**5.1 What runs.** `anvild` is Bun; install to `~/.local/bin/anvild` (`bun build --compile` single executable, or `.js` + absolute `bun`). Bun discovery mirrors `find_python3` (`~/.bun/bin/bun`, `/opt/homebrew/bin/bun`, `/usr/local/bin/bun`, PATH).
**5.2 Env/auth injection (§3, the load-bearing part).** The service MUST set `CLAUDE_CODE_OAUTH_TOKEN` (from a `chmod 600` file, **not** the world-readable plist/unit), **explicitly unset `ANTHROPIC_API_KEY`**, set push cred paths + port + minimal `PATH`. Pattern: a launcher `~/.local/bin/anvild-launch` → `set -a; . ~/.config/anvil/env; unset ANTHROPIC_API_KEY; set +a; exec ~/.local/bin/anvild`. The daemon still asserts the invariant at startup (defense in depth) → `subscriptionAuthOk`.
**5.3 macOS LaunchAgent** `com.anvil.anvild` (`~/Library/LaunchAgents/com.anvil.anvild.plist`): `ProgramArguments=[~/.local/bin/anvild-launch]`, `RunAtLoad`+`KeepAlive` true, logs to `~/.local/state/anvil/anvild{,.error}.log` (durable, not `/tmp`), stable `WorkingDirectory`; `launchctl load` + `kickstart -k gui/$(id -u)/com.anvil.anvild`.
**5.4 Linux systemd user** `~/.config/systemd/user/anvild.service`: `ExecStart=%h/.local/bin/anvild-launch`, `EnvironmentFile=-%h/.config/anvil/env`, `UnsetEnvironment=ANTHROPIC_API_KEY`, `Restart=on-failure`/`RestartSec=5`, journal output, `WantedBy=default.target`.
**5.5 Health/restart.** Keep `wait_for_health` poll discipline, pointed at `/api/health`; surface `subscriptionAuthOk` and refuse to declare success if false. Provide `restart-anvild.sh` (kill orphan on port via `lsof`, reload/`systemctl --user restart`, `wait_for_health`, print MagicDNS URL).
**5.6 Logs.** macOS file logs; Linux `journalctl --user -u anvild -f`. Structured lines for auth self-check, push enable/send/prune, serve status, session lifecycle.

## 6. Migration from the Python session-status-server
**6.1 Retire:** `session-status-server.py` (7601 REST) + its LaunchAgent/systemd unit; **the `claude-status-hook.sh` hooks** in `~/.claude/settings.json` (they scraped a TUI; the daemon owns the loop in-process — obsolete; native push supersedes the Slack hook idea). Zellij removal itself is tracked by the client phases.
**6.2 Changes:** binary py→Bun; label `com.zellijconnect.*`→`com.anvil.anvild`; port 7601→new (e.g. 7701 during overlap), HTTPS on 443 via serve; external hooks → in-process SDK; auth → §3 contract; logs `/tmp`→`~/.local/state/anvil`.
**6.3 Cutover (safe, reversible):** (1) coexist on a different port; (2) provision §3 auth (`claude setup-token` → `~/.config/anvil/env` chmod 600; confirm no `ANTHROPIC_API_KEY`; verify `subscriptionAuthOk:true`); (3) validate E2E (§10.1); (4) retire the Python server (unload/remove plist/unit + script; base on `do_uninstall` but **drop the stale `sudo`/`/usr/local/bin` path in `uninstall.sh`**); (5) strip `claude-status-hook` from settings (back up first); (6) remove old `serve --https 7601`; (7) point clients at the new MagicDNS URL. `install.sh` gains `--migrate` (detect+remove old artifacts) + documented rollback.

## 7. Implementation steps
1. **Service skeleton (with §10.1):** `anvild-launch`, plist + unit templates, §3 startup assertion + `/api/health`. Rewrite `install.sh` (Bun detect, `~/.local/bin`, `wait_for_health`, durable logs).
2. **Tailscale wiring:** `serve --bg`, URL discovery, optional `ANVIL_REQUIRE_TS_USER` header assertion; fix host:port bug.
3. **Migration:** detect+remove `com.zellijconnect.*`/`session-status-server.*` + `claude-status-hook` settings + old serve mapping; coexistence; rollback; retire `uninstall.sh` sudo path.
4. **Push core:** persist tokens; `NotificationRouter` (liveness map + suppression); fire on `PermissionRequestEvent`/`ResultEvent` (daemon-side router lands with phase 1, no-op until a provider is configured).
5. **FCM sender (with phase 2):** `google-auth-library` token minting, `messages:send`, invalid-token prune, deep-link `data`.
6. **APNs sender (with phase 5):** ES256 JWT over HTTP/2, sandbox/prod toggle, 410 prune.
7. **Hardening:** send retries/backoff, `result` debounce, optional `whois` per-device policy, decide `error`-trigger + `push.unregister`.

## 8. Dependencies / external setup
- **Claude auth:** Pro/Max/Team/Enterprise; `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`.
- **FCM:** Firebase project; service-account JSON (scope `firebase.messaging`); `google-services.json` in the app; daemon dep `google-auth-library`; `ANVIL_FCM_SERVICE_ACCOUNT`.
- **APNs:** Apple Developer account; `.p8` AuthKey + Key ID + Team ID; bundle id (→`apns-topic`); daemon `http2`/`@parse/node-apn`/`apns2`; `ANVIL_APNS_*` env.
- **Tailscale:** installed/logged-in on dev box + clients; MagicDNS on; ACL admits the user's devices; Bun installed.

## 9. Risks & open questions
- **Suppression vs backgrounded app:** open WS ≠ foreground; v1 has clients drop/mark-background the WS; may need a `connection.state foreground|background` command (protocol change). 
- **Protocol gaps:** no `push.unregister`, no server→client push feedback. **Recommend adding `push.unregister`**; server-side prune-on-error is the real backstop. Coordinate the protocol change + native mirroring.
- **`result`-push spam:** rapid autonomous turns (default Opus + mostly-autonomous) → debounce/coalesce.
- **`error` trigger:** §6.7 only blesses request+result; a fatal `error` while away may matter more — open.
- **`tailscale serve` flag drift** — keep `|| true`, verify against `--help` at install.
- **Billing model could shift (§3)** — doesn't change this plan's mechanics, only that the OAuth contract stays correct.
- **Secret handling** — token/creds in `chmod 600` file, never plist/unit; verify perms in installer.
- **Single-user assumption** baked into "all devices get the push" + the email check; multi-user needs per-user token scoping + `whois` routing.

## 10. Cross-references
Architecture §3, §4, §6.6, §6.7, §10, §11 #5/#8/#2. Protocol: `PushRegisterCmd`, `PermissionRequestEvent`, `ResultEvent`, `HealthResponse`, `Budget`/`BudgetEvent`. Ops files: `install.sh` (`wait_for_health`, `install_launchagent`, `install_systemd`, serve+URL discovery, claude-hook config, `do_uninstall`), `com.zellijconnect.session-status-server.plist` (template being replaced), `restart-server.sh` (pattern to port), `uninstall.sh` (stale sudo path NOT to carry forward).
Sources (verified 2026): FCM HTTP v1 (`fcm.googleapis.com/v1/projects/{id}/messages:send`); APNs token .p8 over HTTP/2 (`api.push.apple.com` / sandbox, `POST /3/device/<token>`, ES256 JWT); Tailscale Serve identity headers + localhost proxy; Tailscale LocalAPI whois; `claude setup-token`/`CLAUDE_CODE_OAUTH_TOKEN`.
