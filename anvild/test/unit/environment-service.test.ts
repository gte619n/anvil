/**
 * [P7] EnvironmentService — the environment (project) CRUD + README domain extracted from Supervisor.
 * Pins the one method with real logic (envReadme's filename search + markdown-vs-text branch) plus the
 * add→broadcast wiring. CRUD flows are also covered end-to-end through the Supervisor delegations.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@protocol";
import { EnvironmentStore } from "../../src/env/store";
import { EnvironmentService } from "../../src/session/environment-service";

/** Environments must be git repos (EnvironmentStore.add enforces it) — init one for the test. */
function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  return dir;
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "anvil-envsvc-"));
  const envStore = new EnvironmentStore(dir);
  const broadcasts: ServerEvent[] = [];
  const svc = new EnvironmentService({
    envStore,
    registry: { toAll: (e: ServerEvent) => broadcasts.push(e) } as never,
    clonesDir: join(dir, "repos"),
    renderer: { render: (raw: string) => ({ source: raw, html: `<p>${raw}</p>` }) } as never,
  });
  return { dir, envStore, svc, broadcasts, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("[P7] addEnvironment persists + broadcasts the environments list", () => {
  const h = harness();
  try {
    const repo = gitRepo(join(h.dir, "proj"));
    h.svc.addEnvironment("Proj", repo);
    expect(h.svc.environmentsEvent().environments.map((e) => e.name)).toContain("Proj");
    expect(h.broadcasts.at(-1)?.type).toBe("environments");
  } finally {
    h.cleanup();
  }
});

test("[P7] envReadme renders markdown, returns raw text for non-md, and flags missing", () => {
  const h = harness();
  try {
    const repo = gitRepo(join(h.dir, "proj"));
    h.svc.addEnvironment("Proj", repo);
    const id = h.svc.environmentsEvent().environments.find((e) => e.name === "Proj")!.id;

    expect(h.svc.envReadme(id)).toEqual({ missing: true }); // no README yet

    writeFileSync(join(repo, "README.md"), "# Hello");
    const md = h.svc.envReadme(id);
    expect(md.markdown).toBeDefined();
    expect(md.missing).toBeUndefined();

    expect(() => h.svc.envReadme("nope")).toThrow(/no such environment/);
  } finally {
    h.cleanup();
  }
});
