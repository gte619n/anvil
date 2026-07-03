import { loadConfig } from "./config";
import { assertSubscriptionAuth } from "./auth/guard";
import { loadPersistedClaudeToken } from "./auth/store";
import { loadPersistedOpenRouterKey } from "./auth/openrouter";
import { createServer, VERSION } from "./server/http";
import { createMarkdownRenderer } from "./render/markdown-pipeline";

// A token set/reset from the UI (auth.set) is persisted to the launcher's env file. If the launcher
// didn't export it (dev run), load just that key before the §3 guard so the UI-set token is honoured.
loadPersistedClaudeToken();
// The OpenRouter key (adversarial panel) is persisted in the same env file; load it before loadConfig so
// the panel is enabled on startup when a key was set from the UI. It's a different provider than
// Anthropic, so it's irrelevant to the §3 guard below.
loadPersistedOpenRouterKey();
// arch §3: refuse to start unless the subscription-auth invariant holds.
assertSubscriptionAuth();

const config = loadConfig();
const renderer = await createMarkdownRenderer(); // loads Shiki grammars once at startup
const server = createServer({
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
    console.log(`[anvild ${VERSION}] ${sig} — shutting down gracefully…`);
    const watchdog = setTimeout(() => {
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
