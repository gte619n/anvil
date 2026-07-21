import { loadConfig } from "./config";
import { assertSubscriptionAuth } from "./auth/guard";
import { applyDegradeMarkerAtBoot } from "./auth/degrade";
import { loadPersistedClaudeToken } from "./auth/store";
import { loadPersistedOpenRouterKey } from "./auth/openrouter";
import { createServer, VERSION } from "./server/http";
import { createMarkdownRenderer } from "./render/markdown-pipeline";
import { installTimestampedConsole, recordExit, recordStart } from "./daemon/lifecycle";

// Timestamp every log line before anything logs (so restart cadence + event timing are legible in the
// launchd log). Must run first — earlier bare lines couldn't be correlated in time.
installTimestampedConsole();

// A token set/reset from the UI (auth.set) is persisted to the launcher's env file. If the launcher
// didn't export it (dev run), load just that key before the §3 guard so the UI-set token is honoured.
loadPersistedClaudeToken();
// The OpenRouter key (adversarial panel) is persisted in the same env file; load it before loadConfig so
// the panel is enabled on startup when a key was set from the UI. It's a different provider than
// Anthropic, so it's irrelevant to the §3 guard below.
loadPersistedOpenRouterKey();

// Config must be resolved BEFORE the guard now: the degrade marker lives in the state dir and is
// consulted between the token load above and the guard below (headless-join §4.6). Nothing in
// loadConfig depends on the auth state, so hoisting it is safe.
const config = loadConfig();

// A prior run auto-degraded (2× auth failure). The launcher re-sources the env file on EVERY start and
// loadPersistedClaudeToken() reloads that key, so without this the daemon would come back looking
// authed and burn two more turns rediscovering the dead token — on every reboot (HJ-35).
const degradeMarker = applyDegradeMarkerAtBoot(config.stateDir);
if (degradeMarker) {
  console.warn(
    `[anvild] ⚠️  starting DEGRADED — a prior run flagged the Claude token as bad (${degradeMarker.reason}` +
      `${degradeMarker.at ? ` at ${degradeMarker.at}` : ""}). Re-pair this machine, or set a token in Settings → Auth.`,
  );
}

// arch §3: refuse to start on a §3 VIOLATION (a metered key). A missing/dead token warns and boots
// degraded instead — that's what lets a fresh headless box exist long enough to be paired (§4.1).
assertSubscriptionAuth();

// Log how the PRIOR run ended (deliberate restart vs crash/respawn) and stamp this run `running`, so the
// next restart is attributable on sight (arch §5 diagnostics).
recordStart(config.stateDir);
const renderer = await createMarkdownRenderer(); // loads Shiki grammars once at startup
const server = ((): ReturnType<typeof createServer> => {
  try {
    return createServer({
      host: config.host,
      port: config.port,
      stateDir: config.stateDir,
      clonesDir: config.clonesDir,
      warnFraction: config.warnFraction,
      softStopFraction: config.softStopFraction,
      adversarialModels: config.adversarialModels,
      adversarialProvider: config.adversarialProvider,
      renderer,
    });
  } catch (e) {
    // Bind failed (EADDRINUSE past the retry window, or another listen error). Record it so the next
    // start reports a deliberate-looking exit rather than an unexplained "abnormal", then rethrow.
    recordExit(config.stateDir, "bind-failed", e instanceof Error ? e.message : String(e));
    throw e;
  }
})();

console.log(
  `[anvild ${VERSION}] listening on http://localhost:${server.port}  ` +
    `(ws: /ws · health: /api/health)`,
);

// Graceful shutdown (arch §5): launchd sends SIGTERM on `kickstart -k` (service.sh restart) and on
// bootout. Reap agent/terminal child processes (so they don't orphan across restarts) and flush a
// final time, then exit. Session state is already persisted on every change, so this is belt-and-
// suspenders for durability; its real job is reaping children cleanly. The restart itself is
// launchd's: `kickstart -k` always starts a fresh instance, and a crash (non-zero exit) is respawned
// by KeepAlive — so the exit code here is irrelevant. A watchdog guarantees we exit within launchd's
// 5s kill window even if a driver hangs.
let shuttingDown = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Record the signal as the exit reason up front: a SIGTERM here is launchd's `kickstart -k` (an
    // Update Anvil / service.sh restart), so the next start can call this restart deliberate.
    recordExit(config.stateDir, sig);
    console.log(`[anvild ${VERSION}] ${sig} — shutting down gracefully…`);
    const watchdog = setTimeout(() => {
      recordExit(config.stateDir, "watchdog", `graceful shutdown exceeded 4s after ${sig}`);
      console.error("[anvild] shutdown watchdog fired — forcing exit");
      process.exit(0);
    }, 4000);
    watchdog.unref?.();
    server
      .shutdown()
      .catch((e) => console.error(`[anvild] shutdown error: ${e instanceof Error ? e.message : e}`))
      .finally(() => {
        clearTimeout(watchdog);
        process.exit(0);
      });
  });
}

// A crash that reaches here would otherwise exit with NO ledger entry, leaving the next start to infer
// only "abnormal". Catch it, record the real error, then exit non-zero so launchd's KeepAlive respawns a
// fresh instance (arch §5) — same terminal behaviour as the default handler, but now attributable.
process.on("uncaughtException", (err) => {
  if (shuttingDown) return;
  shuttingDown = true;
  recordExit(config.stateDir, "uncaughtException", err instanceof Error ? err.message : String(err));
  console.error(`[anvild ${VERSION}] uncaughtException — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
// A rejection isn't necessarily fatal (the daemon keeps running), so log it for visibility but DON'T
// touch the ledger or exit — that would corrupt the `running` record or manufacture a crash where the
// process would otherwise have survived.
process.on("unhandledRejection", (reason) => {
  console.error(`[anvild ${VERSION}] unhandledRejection — ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});
