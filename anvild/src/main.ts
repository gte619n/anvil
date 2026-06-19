import { loadConfig } from "./config";
import { assertSubscriptionAuth } from "./auth/guard";
import { createServer, VERSION } from "./server/http";

// arch §3: refuse to start unless the subscription-auth invariant holds.
assertSubscriptionAuth();

const config = loadConfig();
const { port } = createServer({
  port: config.port,
  stateDir: config.stateDir,
  warnFraction: config.warnFraction,
  softStopFraction: config.softStopFraction,
});

console.log(
  `[anvild ${VERSION}] listening on http://localhost:${port}  ` +
    `(ws: /ws · health: /api/health)`,
);
