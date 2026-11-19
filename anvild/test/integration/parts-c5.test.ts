/**
 * [C5] Functional scenario for the part sources (agent-cad-and-browser §5 Phase C5 Acceptance, §4.14
 * item 36): a real Supervisor with the "part-sources" feature, the real tools, the real permission
 * hook, the real quarantine; the vendors are hand-written fixtures on a local server and the file host
 * is a local HTTPS fixture (test/helpers/parts.ts). Key propagation runs between two real daemons.
 * No vendor API is called; live vendor behaviour is UNVERIFIED (see the phase report).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { makeCanUseTool, QuestionBroker } from "../../src/agent/questions";
import { PARTS_FETCH_TOOL_ID, PARTS_MCP_SERVER_NAME, PARTS_SEARCH_TOOL_ID, PARTS_SESSION_PROMPT, partsTools } from "../../src/agent/parts-tools";
import { rotateToken } from "../../src/server/fleet";
import { createServer } from "../../src/server/http";
import { PartKeyStore } from "../../src/integrations/parts/keys";
import { loadServerIdentity } from "../../src/server/identity";
import type { Session } from "../../src/session/session";
import { callHook, isPending, mcpRig, parked, type McpRig } from "../helpers/mcp";
import { KEYS, SECRET_VALUES, STEP_BYTES, baseUrls, fixtureResolver, startFileFixture, startVendorFixture, type FileFixture, type VendorFixture } from "../helpers/parts";

let fx: VendorFixture;
let files: FileFixture;
let rig: McpRig;
let worktree: string;
const logs: string[] = [];
const orig = { log: console.log, warn: console.warn, error: console.error };
const IN_PROCESS = { inProcessKeys: [PARTS_MCP_SERVER_NAME] };

function partsRig(maxDownloadBytes?: number): McpRig {
  return mcpRig({
    features: ["part-sources"],
    parts: {
      baseUrls: baseUrls(fx),
      resolver: fixtureResolver,
      selfHosts: () => [],
      fleetHosts: () => [],
      ca: files.ca,
      dial: () => ({ address: "127.0.0.1", port: files.port }),
      sleep: async () => {},
      ...(maxDownloadBytes ? { maxDownloadBytes } : {}),
    },
  });
}
const parts = () => rig.sup.parts!;
const setKeys = (source: "digikey" | "mouser" | "traceparts") => {
  const fields = { digikey: ["DIGIKEY_CLIENT_ID", "DIGIKEY_CLIENT_SECRET"], mouser: ["MOUSER_API_KEY"], traceparts: ["TRACEPARTS_TENANT_UID", "TRACEPARTS_API_KEY", "TRACEPARTS_EMAIL"] }[source];
  rig.sup.partsSetKeys(source, Object.fromEntries(fields.map((f) => [f, KEYS[f as keyof typeof KEYS]])));
};
const tool = (s: Session, name: "parts_search" | "parts_fetch") => partsTools(parts(), s).find((t) => t.name === name)!;
async function search(s: Session, args: Record<string, unknown>): Promise<{ results: any[]; notes: string[]; text: string; isError: boolean }> {
  const out = (await tool(s, "parts_search").handler(args as never, {} as never)) as { content: { text: string }[]; isError?: boolean };
  const text = out.content[0]!.text;
  if (out.isError) return { results: [], notes: [], text, isError: true };
  return { ...(JSON.parse(text.slice(text.indexOf("\n") + 1)) as { results: any[]; notes: string[] }), text, isError: false };
}
async function fetchPart(s: Session, url: string): Promise<{ text: string; isError: boolean }> {
  const out = (await tool(s, "parts_fetch").handler({ url } as never, {} as never)) as { content: { text: string }[]; isError?: boolean };
  return { text: out.content[0]!.text, isError: out.isError === true };
}
const noSecrets = (text: string) => {
  for (const v of SECRET_VALUES) expect(text).not.toContain(v);
};

beforeAll(() => {
  files = startFileFixture();
});
afterAll(() => files.stop());
beforeEach(() => {
  fx = startVendorFixture();
  rig = partsRig();
  worktree = realpathSync(mkdtempSync(join(tmpdir(), "anvil-c5-wt-")));
  mkdirSync(join(worktree, ".git", "info"), { recursive: true });
  logs.length = 0;
  for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
});
afterEach(async () => {
  Object.assign(console, orig);
  fx.stop();
  await rig.cleanup();
  rmSync(worktree, { recursive: true, force: true });
});

describe("Acceptance: parts_search", () => {
  test("[C5] Acceptance: a search returns normalized results from each configured source — DigiKey, Mouser and TraceParts — each with its attribution", async () => {
    for (const s of ["digikey", "mouser", "traceparts"] as const) setKeys(s);
    const s = await rig.session({ cwd: worktree });
    const out = await search(s, { query: "LM317" });
    expect(out.isError).toBe(false);
    expect(out.text.split("\n")[0]).toMatch(/result\(s\)\. Show each result's attribution with it\./);
    expect(out.results.map((r) => [r.source, r.manufacturer, r.mpn])).toEqual([
      ["digikey", "Texas Instruments", "LM317T"],
      ["digikey", "STMicroelectronics", "LM317D2T-TR"],
      ["mouser", "Texas Instruments", "LM317T"],
      ["traceparts", "Texas Instruments", "LM317T"],
    ]);
    for (const r of out.results) {
      expect(Object.keys(r).every((k) => ["source", "manufacturer", "mpn", "description", "datasheetUrl", "modelUrls", "productUrl", "stock", "attribution"].includes(k))).toBe(true);
      expect(r.attribution).toMatch(/DigiKey|Mouser|TraceParts/);
    }
    expect(out.results.find((r) => r.source === "traceparts").modelUrls[0].format).toBe("STEP");
    expect(out.notes).toEqual([]);
    noSecrets(out.text);
  });

  test("[C5] Acceptance: a source with no key is skipped with a note, not an error — and TraceParts with only some of its fields counts as no key", async () => {
    setKeys("mouser");
    rig.sup.partsSetKeys("traceparts", { TRACEPARTS_TENANT_UID: KEYS.TRACEPARTS_TENANT_UID, TRACEPARTS_API_KEY: KEYS.TRACEPARTS_API_KEY }); // no email
    const s = await rig.session({ cwd: worktree });
    const out = await search(s, { query: "LM317" });
    expect(out.isError).toBe(false);
    expect(out.results.map((r) => r.source)).toEqual(["mouser"]);
    expect(out.notes).toEqual(["DigiKey: skipped — no key is set (Settings → Models → Part sources)", "TraceParts: skipped — no key is set (Settings → Models → Part sources)"]);
    expect(fx.calls.some((c) => c.path.startsWith("/dk/") || c.path.startsWith("/tp/"))).toBe(false);
  });

  test("[C5] one source failing does not fail the call: its error is a note, the others' results stand; asking for unknown sources is an error", async () => {
    setKeys("digikey");
    setKeys("mouser");
    fx.opts.dkSearchStatus = 503;
    const s = await rig.session({ cwd: worktree });
    const out = await search(s, { query: "LM317", sources: ["digikey", "mouser"] });
    expect(out.results.map((r) => r.source)).toEqual(["mouser"]);
    expect(out.notes).toEqual([expect.stringMatching(/^DigiKey: HTTP 503/)]);
    expect((await search(s, { query: "LM317", sources: ["snapeda"] })).isError).toBe(true);
  });
});

describe("Acceptance: parts_fetch", () => {
  test("[C5] Acceptance: parts_fetch of a STEP link lands in the quarantine (.anvil-downloads/, 0600, git-excluded) under the download limits", async () => {
    setKeys("digikey");
    const s = await rig.session({ cwd: worktree });
    const found = await search(s, { query: "LM317", sources: ["digikey"] });
    const step = found.results[0].modelUrls[0].url;
    expect(step).toBe("https://files.parts.test/models/lm317.step");
    const out = await fetchPart(s, step);
    expect(out).toEqual({ isError: false, text: expect.stringMatching(/^Saved \.anvil-downloads\/lm317\.step \(\d+ bytes\) from https:\/\/files\.parts\.test\/models\/lm317\.step\. It is in quarantine: never run it/) });
    expect(readFileSync(join(worktree, ".anvil-downloads", "lm317.step"), "utf8")).toBe(STEP_BYTES);
    expect(statSync(join(worktree, ".anvil-downloads", "lm317.step")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(worktree, ".git", "info", "exclude"), "utf8")).toContain(".anvil-downloads/");
    expect(existsSync(join(worktree, ".anvil-browser"))).toBe(false); // the staging folder it made is gone again
    // A TraceParts model link: cadRequest under the email, polled, then the file — into the same quarantine.
    setKeys("traceparts");
    const tp = await search(s, { query: "LM317T", manufacturer: "Texas Instruments", sources: ["traceparts"] });
    const out2 = await fetchPart(s, tp.results[0].modelUrls[0].url);
    expect(out2).toEqual({ isError: false, text: expect.stringMatching(/^Saved \.anvil-downloads\/bracket\.step/) });
    expect(readdirSync(join(worktree, ".anvil-downloads")).sort()).toEqual(["bracket.step", "lm317.step"]);
    // Over the limit: refused, nothing kept.
    await rig.cleanup();
    rig = partsRig(50);
    setKeys("digikey");
    const s2 = await rig.session({ cwd: worktree });
    await search(s2, { query: "LM317", sources: ["digikey"] });
    const big = await fetchPart(s2, "https://files.parts.test/models/lm317.step");
    expect(big).toEqual({ isError: true, text: expect.stringMatching(/over the 50-byte limit; nothing was saved/) });
    expect(readdirSync(join(worktree, ".anvil-downloads")).sort()).toEqual(["bracket.step", "lm317.step"]);
  });

  test("[C5] Acceptance: a non-allowed type is refused — nothing is saved", async () => {
    setKeys("digikey");
    fx.opts.datasheetUrl = "https://files.parts.test/tool.exe";
    const s = await rig.session({ cwd: worktree });
    await search(s, { query: "LM317", sources: ["digikey"] });
    const out = await fetchPart(s, "https://files.parts.test/tool.exe");
    expect(out).toEqual({ isError: true, text: expect.stringMatching(/\.exe files are not allowed \(allowed: step, stp, iges, igs, 3mf, stl, pdf, zip, png, jpg, jpeg, csv, json, txt\); nothing was saved/) });
    expect(existsSync(join(worktree, ".anvil-downloads"))).toBe(false);
  });

  test("[C5] parts_fetch refuses a URL that no parts_search in this session returned (another session's, a made-up one, http) — it is not a general fetcher", async () => {
    setKeys("digikey");
    const a = await rig.session({ cwd: worktree });
    const b = await rig.session({ cwd: worktree });
    await search(a, { query: "LM317", sources: ["digikey"] });
    for (const url of ["https://files.parts.test/models/other.step", "https://example.com/a.pdf"]) {
      expect((await fetchPart(a, url)).text).toMatch(/was not returned by parts_search in this session/);
    }
    expect((await fetchPart(b, "https://files.parts.test/models/lm317.step")).text).toMatch(/was not returned by parts_search in this session/);
    expect((await fetchPart(a, "http://files.parts.test/models/lm317.step")).text).toMatch(/only https URLs are fetched/);
    expect(files.requests.filter((r) => r.includes("other.step"))).toEqual([]);
    // A reset forgets what the session was given.
    await rig.sup.reset(a.id);
    expect((await fetchPart(a, "https://files.parts.test/models/lm317.step")).text).toMatch(/was not returned by parts_search/);
  });

  test("[C5] parts_fetch never writes through a symlinked .anvil-browser", async () => {
    setKeys("digikey");
    const s = await rig.session({ cwd: worktree });
    await search(s, { query: "LM317", sources: ["digikey"] });
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "anvil-c5-outside-")));
    const { symlinkSync } = await import("node:fs");
    symlinkSync(outside, join(worktree, ".anvil-browser"));
    try {
      expect(await fetchPart(s, "https://files.parts.test/models/lm317.step")).toEqual({ isError: true, text: expect.stringMatching(/symbolic link/) });
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("[C5] a model link that redirects to a loopback address is refused and nothing is saved", async () => {
    setKeys("digikey");
    fx.opts.modelUrl = "https://files.parts.test/to-loopback";
    const s = await rig.session({ cwd: worktree });
    await search(s, { query: "LM317", sources: ["digikey"] });
    const out = await fetchPart(s, "https://files.parts.test/to-loopback");
    expect(out).toEqual({ isError: true, text: expect.stringMatching(/redirected to an address that is not allowed: 127\.0\.0\.1 is a loopback address/) });
    expect(existsSync(join(worktree, ".anvil-downloads"))).toBe(false);
  });

  test("[C5] an oversize streamed response (no Content-Length) is aborted and the partial file deleted", async () => {
    await rig.cleanup();
    rig = partsRig(50_000);
    setKeys("digikey");
    fx.opts.modelUrl = "https://files.parts.test/huge-stream.step";
    const s = await rig.session({ cwd: worktree });
    await search(s, { query: "LM317", sources: ["digikey"] });
    const out = await fetchPart(s, "https://files.parts.test/huge-stream.step");
    expect(out).toEqual({ isError: true, text: expect.stringMatching(/the download was stopped and the partial file deleted/) });
    expect(existsSync(join(worktree, ".anvil-downloads"))).toBe(false);
    expect(existsSync(join(worktree, ".anvil-browser"))).toBe(false);
  });
});

describe("tools, permissions and keys", () => {
  test("[C5] the anvil_parts server is given to ordinary sessions only while a source is configured; parts_search is read-only and auto-allowed, parts_fetch follows the autonomy policy like a write; the system prompt says to try parts_search before the browser and to show attribution", async () => {
    const driverOf = (s: Session) => {
      (rig.sup as unknown as { agentEnv: () => Record<string, string> }).agentEnv = () => ({});
      return (rig.sup as unknown as { ensureDriver(id: string): { mcpServers?: Record<string, unknown>; extraAllowedTools?: string[]; systemPrompt(): { append?: string } } }).ensureDriver(s.id);
    };
    const before = await rig.session({ cwd: worktree });
    expect(driverOf(before).mcpServers).toBeUndefined();
    setKeys("mouser");
    const s = await rig.session({ cwd: worktree });
    const d = driverOf(s);
    expect(Object.keys(d.mcpServers ?? {})).toEqual([PARTS_MCP_SERVER_NAME]);
    expect(d.extraAllowedTools).toEqual([PARTS_SEARCH_TOOL_ID]);
    expect(d.systemPrompt().append).toContain(PARTS_SESSION_PROMPT.trimStart());
    expect(PARTS_SESSION_PROMPT).toMatch(/before using the browser/);
    expect(PARTS_SESSION_PROMPT).toMatch(/show each one's attribution/);
    const lead = await rig.session({ cwd: worktree, teamRole: "lead" } as never);
    expect(Object.keys(driverOf(lead).mcpServers ?? {})).not.toContain(PARTS_MCP_SERVER_NAME);

    for (const autonomy of ["prompt-all", "allowlist", "mostly-autonomous", "bypass"] as const) {
      const x = await rig.session({ cwd: worktree, autonomy });
      const searchV = callHook(x, rig.broker, PARTS_SEARCH_TOOL_ID, IN_PROCESS, { query: "a" });
      const asksSearch = await isPending(searchV);
      expect([autonomy, "search", asksSearch]).toEqual([autonomy, "search", autonomy === "prompt-all"]);
      if (asksSearch) rig.sup.resolvePermission(parked(x).requestId, "allow");
      expect((await searchV).decision).toBe("allow");
      const fetchV = callHook(x, rig.broker, PARTS_FETCH_TOOL_ID, IN_PROCESS, { url: "https://x.test/a.pdf" });
      const asksFetch = await isPending(fetchV);
      expect([autonomy, "fetch", asksFetch]).toEqual([autonomy, "fetch", autonomy === "prompt-all" || autonomy === "allowlist"]);
      if (asksFetch) rig.sup.resolvePermission(parked(x).requestId, "deny");
      expect((await fetchV).decision).toBe(asksFetch ? "deny" : "allow");
    }
    // parts_fetch is not auto-allowed: a call reaching the canUseTool backstop is denied.
    const canUseTool = makeCanUseTool(s, new QuestionBroker(), d.extraAllowedTools);
    const opts = { signal: new AbortController().signal, toolUseID: "tu_1" } as never;
    expect(((await canUseTool(PARTS_FETCH_TOOL_ID, {}, opts)) as { behavior: string }).behavior).toBe("deny");
    // The name is reserved.
    const { RESERVED_MCP_KEYS } = await import("../../src/mcp/validate");
    expect(RESERVED_MCP_KEYS).toContain(PARTS_MCP_SERVER_NAME);
  });

  test("[C5] keys never appear in logs, tool results, client events (masked) or error messages — through set, search, fetch, Test and failures", async () => {
    for (const x of ["digikey", "mouser", "traceparts"] as const) setKeys(x);
    const s = await rig.session({ cwd: worktree });
    const texts: string[] = [];
    texts.push((await search(s, { query: "LM317" })).text);
    fx.opts.mouserBadKey = true;
    fx.opts.dkSearchStatus = 500;
    texts.push((await search(s, { query: "LM317" })).text);
    texts.push((await fetchPart(s, "https://files.parts.test/nope.step")).text);
    for (const x of ["digikey", "mouser", "traceparts"] as const) texts.push(JSON.stringify(await rig.sup.partsTest(x, "c1")));
    fx.stop(); // unreachable vendor
    texts.push(JSON.stringify(await rig.sup.partsTest("digikey")));
    texts.push((await search(s, { query: "LM317" })).text);
    const events = JSON.stringify(rig.registry.ofType("parts.sources"));
    expect(rig.registry.ofType("parts.sources").length).toBeGreaterThanOrEqual(3);
    expect(events).toContain("••••");
    for (const t of [...texts, events, JSON.stringify(rig.sup.partsEvent()), logs.join("\n")]) noSecrets(t);
    expect(() => rig.sup.partsSetKeys("mouser", { MOUSER_API_KEY: "a\nb" })).toThrow();
    fx = startVendorFixture(); // (afterEach stops it)
  });

  test("[C5] Settings: Test makes one cheap authenticated call per source and reports it; an unconfigured source says what is missing; with the feature off every command is refused", async () => {
    setKeys("digikey");
    expect(await rig.sup.partsTest("digikey", "c9")).toMatchObject({ type: "parts.test.result", cid: "c9", source: "digikey", ok: true, message: expect.stringMatching(/token was issued/) });
    expect(fx.calls.map((c) => c.path)).toEqual(["/dk/v1/oauth2/token"]);
    expect(await rig.sup.partsTest("mouser")).toMatchObject({ ok: false, message: "Mouser is not configured: Search API key missing" });
    rig.sup.partsClearKeys("digikey");
    expect(rig.sup.partsEvent().sources.map((x) => [x.id, x.configured])).toEqual([["digikey", false], ["mouser", false], ["traceparts", false]]);
    const off = mcpRig({ features: [] });
    try {
      expect(off.sup.parts).toBeUndefined();
      expect(() => off.sup.partsEvent()).toThrow(/not enabled/);
      expect(() => off.sup.partsSetKeys("mouser", {})).toThrow(/not enabled/);
    } finally {
      await off.cleanup();
    }
  });
});

describe("key propagation hub → member (two real daemons)", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  test("[C5] keys set in Settings on the hub reach a member with the fleet's credential push (the OpenRouter key's path): stored in the member's env file, masked in its parts.sources, used by its tools; a push from an unknown hub is refused", async () => {
    const mk = () => {
      const d = mkdtempSync(join(tmpdir(), "anvil-c5-fleet-"));
      dirs.push(d);
      return d;
    };
    const [hubDir, memberDir] = [mk(), mk()];
    const hubId = loadServerIdentity(hubDir).serverId;
    writeFileSync(join(memberDir, "pairing.json"), JSON.stringify({ hubServerId: hubId, at: "2026-11-19T00:00:00.000Z" }));
    const boot = (stateDir: string) => createServer({ host: "127.0.0.1", port: 0, stateDir, envFile: join(stateDir, "env"), features: ["part-sources"], resolveIdentity: async () => ({ trust: "sameUser" }), selfBaseUrl: async () => undefined });
    const hub = boot(hubDir);
    // The member is its own process with a temporary HOME (see test/helpers/parts-member.ts).
    const memberHome = realpathSync(mkdtempSync(join(tmpdir(), "anvil-c5-memberhome-")));
    dirs.push(memberHome);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "helpers", "parts-member.ts"), memberDir], {
      cwd: join(import.meta.dir, "..", ".."),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: memberHome, TMPDIR: memberHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
      let out = "";
      while (!/port=\d+/.test(out)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`member did not start: ${out} ${await new Response(child.stderr as ReadableStream).text()}`);
        out += new TextDecoder().decode(value);
      }
      reader.releaseLock();
      const memberPort = Number(/port=(\d+)/.exec(out)![1]);

      // On the hub, as Settings does: parts.keys.set over the socket.
      const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws`);
      const frames: any[] = [];
      ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
      await new Promise((r) => (ws.onopen = r));
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ts: "t", type: "parts.keys.set", source: "mouser", values: { MOUSER_API_KEY: KEYS.MOUSER_API_KEY }, cid: "k1" }));
      for (let i = 0; i < 100 && !frames.some((f) => f.cid === "k1"); i++) await Bun.sleep(20);
      expect(frames.find((f) => f.cid === "k1")?.type).toBe("ack");
      const shown = frames.filter((f) => f.type === "parts.sources").at(-1);
      expect(shown.sources.find((x: any) => x.id === "mouser")).toMatchObject({ configured: true, fields: [{ name: "MOUSER_API_KEY", set: true, masked: "••••5555" }] });
      noSecrets(JSON.stringify(frames));
      ws.close();
      expect(readFileSync(join(hubDir, "env"), "utf8")).toContain(`MOUSER_API_KEY=${KEYS.MOUSER_API_KEY}`);

      // What the hub pushes (the same PartKeyStore payload pushRosterToMembers sends), through the
      // real rotation client to the member's real /api/fleet/token. (Production members listen on the
      // fleet port; here the member's port is passed.)
      const partKeys = new PartKeyStore(join(hubDir, "env")).fleetPayload();
      expect(partKeys).toEqual({ MOUSER_API_KEY: KEYS.MOUSER_API_KEY });
      const pushed = await rotateToken({ members: [{ host: "127.0.0.1", capabilities: ["pairing"] }], token: "sk-ant-oat01-fleet-test-token", hubServerId: hubId, partKeys, port: memberPort });
      expect(pushed).toEqual([expect.objectContaining({ ok: true })]);
      expect(readFileSync(join(memberDir, "env"), "utf8")).toContain(`MOUSER_API_KEY=${KEYS.MOUSER_API_KEY}`);
      const mws = new WebSocket(`ws://127.0.0.1:${memberPort}/ws`);
      const mframes: any[] = [];
      mws.onmessage = (e) => mframes.push(JSON.parse(String(e.data)));
      await new Promise((r) => (mws.onopen = r));
      for (let i = 0; i < 100 && !mframes.some((f) => f.type === "parts.sources"); i++) await Bun.sleep(20);
      expect(mframes.find((f) => f.type === "parts.sources").sources.find((x: any) => x.id === "mouser")).toMatchObject({ configured: true, fields: [{ masked: "••••5555" }] });
      noSecrets(JSON.stringify(mframes));
      mws.close();
      // A push that names another hub changes nothing.
      const evil = await rotateToken({ members: [{ host: "127.0.0.1", capabilities: ["pairing"] }], token: "sk-ant-oat01-x", hubServerId: "srv_not_the_hub", partKeys: { MOUSER_API_KEY: "evil-key-000000000" }, port: memberPort });
      expect(evil[0]!.ok).toBe(false);
      expect(readFileSync(join(memberDir, "env"), "utf8")).not.toContain("evil-key");
      // The Claude token the push carried went to the member's OWN temporary home.
      expect(readFileSync(join(memberHome, ".config", "anvil", "env"), "utf8")).toContain("sk-ant-oat01-fleet-test-token");
    } finally {
      child.kill();
      await child.exited;
      await hub.shutdown();
    }
  });

  test("[C5] a key change on the hub triggers the fleet push (onRosterChanged), and a member's adoption is broadcast without pushing on", async () => {
    const reasons: string[] = [];
    const { Supervisor } = await import("../../src/session/supervisor");
    const d = mkdtempSync(join(tmpdir(), "anvil-c5-push-"));
    dirs.push(d);
    const { RecordingRegistry } = await import("../helpers/mcp");
    const reg = new RecordingRegistry();
    const sup = new Supervisor({ stateDir: d, envFile: join(d, "env"), features: ["part-sources"], onRosterChanged: (r) => void reasons.push(r) }, reg);
    try {
      sup.partsSetKeys("mouser", { MOUSER_API_KEY: KEYS.MOUSER_API_KEY });
      expect(reasons).toEqual(["part-source keys changed"]);
      sup.parts!.adoptFleetKeys({ DIGIKEY_CLIENT_ID: KEYS.DIGIKEY_CLIENT_ID });
      expect(reasons).toEqual(["part-source keys changed"]); // a member does not push on
      expect(reg.ofType("parts.sources").length).toBe(2);
    } finally {
      await sup.shutdown();
    }
  });
});
