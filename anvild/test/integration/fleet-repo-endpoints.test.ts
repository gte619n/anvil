/**
 * The member-side fleet-concierge surface (anvil-fleet-concierge): /api/fleet/environments, /repo,
 * /handoff — what lets the HUB's default "Claude" chat reach repos that live on THIS machine. Boots
 * the real server against a temp stateDir seeded with an environment + a paired hub, and asserts:
 *   • the gate: a caller naming the wrong hub is 403'd; a PROVEN different tailnet user (identity
 *     header present, resolver says otherUser) is 403'd even with the right hub id;
 *   • environments lists the registered repos with this daemon's identity echoed;
 *   • repo ops answer inside the repoRoot and refuse escapes (200 + ok:false, so the hub's
 *     scheme-fallback transport doesn't burn a second attempt on an op-level error);
 *   • handoff validates its required fields.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PeerTrust } from "../../src/server/pairing";

process.env.CLAUDE_CODE_OAUTH_TOKEN ||= "sk-ant-oat-test-placeholder";
const { createServer } = await import("../../src/server/http");

const HUB_ID = "srv_hub_test";

function boot(resolveIdentity?: () => Promise<{ trust: PeerTrust; reject?: string }>) {
  const dir = mkdtempSync(join(tmpdir(), "anvil-fleetrepo-"));
  const repo = mkdtempSync(join(tmpdir(), "anvil-fleetrepo-repo-"));
  writeFileSync(join(repo, "hello.txt"), "needle here\n");
  // Seed the stores the routes read: one registered environment, and the hub this "member" is
  // paired to (the gate matches hubServerId against pairing.json).
  writeFileSync(join(dir, "environments.json"), JSON.stringify({ environments: [{ id: "env_here", name: "proj", repoRoot: repo, isRepo: false }] }));
  writeFileSync(join(dir, "pairing.json"), JSON.stringify({ hubServerId: HUB_ID, at: new Date().toISOString() }));
  const srv = createServer({ host: "127.0.0.1", port: 0, stateDir: dir, envFile: join(dir, "env"), ...(resolveIdentity ? { resolveIdentity } : {}) });
  return {
    base: `http://127.0.0.1:${srv.port}`,
    cleanup: () => {
      srv.stop();
      rmSync(dir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("environments: lists registered repos for the paired hub; wrong hub is 403", async () => {
  const { base, cleanup } = boot();
  try {
    const ok = await fetch(`${base}/api/fleet/environments?hub=${HUB_ID}`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { ok: boolean; serverId: string; environments: { id: string }[] };
    expect(body.ok).toBe(true);
    expect(body.serverId).toBeTruthy();
    expect(body.environments.map((e) => e.id)).toEqual(["env_here"]);

    const wrong = await fetch(`${base}/api/fleet/environments?hub=srv_imposter`);
    expect(wrong.status).toBe(403);
    const missing = await fetch(`${base}/api/fleet/environments`);
    expect(missing.status).toBe(403);
  } finally {
    cleanup();
  }
}, 30_000);

test("repo: read/list/grep answer inside the repoRoot; escapes and unknown envs report ok:false", async () => {
  const { base, cleanup } = boot();
  try {
    const read = await post(base, "/api/fleet/repo", { hubServerId: HUB_ID, environmentId: "env_here", op: "read", path: "hello.txt" });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ ok: true, text: "needle here\n" });

    const list = await post(base, "/api/fleet/repo", { hubServerId: HUB_ID, environmentId: "env_here", op: "list" });
    const listBody = (await list.json()) as { ok: boolean; entries: { name: string }[] };
    expect(listBody.ok).toBe(true);
    expect(listBody.entries.map((e) => e.name)).toContain("hello.txt");

    const grep = await post(base, "/api/fleet/repo", { hubServerId: HUB_ID, environmentId: "env_here", op: "grep", pattern: "needle" });
    const grepBody = (await grep.json()) as { ok: boolean; matches: string[] };
    expect(grepBody.ok).toBe(true);
    expect(grepBody.matches.some((l) => l.includes("hello.txt:1:"))).toBe(true);

    // Op-level failures: 200 + ok:false (see the route comment about the transport fallback).
    const escape = await post(base, "/api/fleet/repo", { hubServerId: HUB_ID, environmentId: "env_here", op: "read", path: "../../etc/hosts" });
    expect(escape.status).toBe(200);
    expect(((await escape.json()) as { ok: boolean }).ok).toBe(false);

    const unknownEnv = await post(base, "/api/fleet/repo", { hubServerId: HUB_ID, environmentId: "env_nope", op: "list" });
    expect(((await unknownEnv.json()) as { ok: boolean }).ok).toBe(false);

    const badReq = await post(base, "/api/fleet/repo", { hubServerId: HUB_ID });
    expect(badReq.status).toBe(400);
  } finally {
    cleanup();
  }
}, 30_000);

test("gate: a proven different tailnet user is 403'd on all three routes even with the right hub id", async () => {
  const { base, cleanup } = boot(async () => ({ trust: "otherUser", reject: "different tailnet user (mallory@example)" }));
  try {
    // The identity header makes this a serve-proxied tailnet caller (NOT the local-no-identity
    // exception), so the resolver's otherUser verdict must reject.
    const hdr = { "Tailscale-User-Login": "mallory@example" };
    expect((await fetch(`${base}/api/fleet/environments?hub=${HUB_ID}`, { headers: hdr })).status).toBe(403);
    expect((await post(base, "/api/fleet/repo", { hubServerId: HUB_ID, environmentId: "env_here", op: "list" }, hdr)).status).toBe(403);
    expect((await post(base, "/api/fleet/handoff", { hubServerId: HUB_ID, source: "existing-dir", cwd: "/tmp", title: "t", brief: "b" }, hdr)).status).toBe(403);
  } finally {
    cleanup();
  }
}, 30_000);

test("handoff: validates required fields before touching the supervisor", async () => {
  const { base, cleanup } = boot();
  try {
    const r = await post(base, "/api/fleet/handoff", { hubServerId: HUB_ID, source: "existing-dir", cwd: "/tmp", title: "t" }); // no brief
    expect(r.status).toBe(400);
    expect(((await r.json()) as { ok: boolean }).ok).toBe(false);
  } finally {
    cleanup();
  }
}, 30_000);
