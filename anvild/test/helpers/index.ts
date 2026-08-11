/**
 * [P5] Shared test fixtures. The plan flagged 55 files hand-rolling `mkdtempSync` and ~13 duplicating
 * the Supervisor/server boot line. This is the foundation the audit asked for — new tests should import
 * from here instead of re-deriving the boilerplate. (Retrofitting every existing file is deliberately
 * left as follow-up churn; these are used by the P0–P4 guard tests added in this program.)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh temp dir plus a cleanup thunk. Use in a try/finally (or afterEach). */
export function tmpDir(prefix = "anvil-test-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A dir containing an index.html — satisfies the update-service boot smoke (webBundleOk). */
export function webDirOk(prefix = "anvil-webdir-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  Bun.write(join(dir, "index.html"), "<html></html>");
  return dir;
}

/**
 * Boot the real HTTP/WS server on an ephemeral port against a temp stateDir, with a placeholder Claude
 * token so the agent path is reachable. Returns the base URL + a cleanup that stops the server and
 * removes the dir. `createServer` is imported lazily so a caller that mocks the SDK first still wins.
 */
export async function bootServer(opts: { fleetMembers?: unknown[] } = {}): Promise<{ base: string; dir: string; port: number; cleanup: () => void }> {
  process.env.CLAUDE_CODE_OAUTH_TOKEN ||= "sk-ant-oat-test-placeholder";
  const { createServer } = await import("../../src/server/http");
  const { dir, cleanup } = tmpDir("anvil-srv-");
  if (opts.fleetMembers) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "fleet.json"), JSON.stringify({ members: opts.fleetMembers }));
  }
  const srv = createServer({ host: "127.0.0.1", port: 0, stateDir: dir, envFile: join(dir, "env") });
  return {
    base: `http://127.0.0.1:${srv.port}`,
    dir,
    port: srv.port,
    cleanup: () => {
      srv.stop();
      cleanup();
    },
  };
}
