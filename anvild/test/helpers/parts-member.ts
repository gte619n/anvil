/**
 * A fleet member daemon for the part-source propagation test (Phase C5), run as its OWN process so
 * that its HOME is a temporary folder: a credential push makes a member write the Claude token to
 * `~/.config/anvil/env`, and Bun's `os.homedir()` cannot be redirected from inside a running process.
 * Usage: bun test/helpers/parts-member.ts <stateDir>  — prints `port=<n>` once listening.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { createServer } from "../../src/server/http";

const stateDir = process.argv[2]!;
if (!stateDir || !homedir().includes("anvil-c5-memberhome-")) {
  console.error(`refusing: HOME must be a test folder (got ${homedir()})`);
  process.exit(2);
}
const srv = createServer({ host: "127.0.0.1", port: 0, stateDir, envFile: join(stateDir, "env"), features: ["part-sources"], resolveIdentity: async () => ({ trust: "sameUser" }), selfBaseUrl: async () => undefined });
console.log(`port=${srv.port}`);
process.on("SIGTERM", () => void srv.shutdown().finally(() => process.exit(0)));
