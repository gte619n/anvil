/**
 * [C3] Human hand-off (src/agent/human-tools.ts; agent-cad-and-browser §4.12 "Hand-off", D32): the
 * `anvil_human` server's one tool, the card it parks, `human.request.respond`, the unattended path
 * with its `onUnattendedHumanRequest` seam, and how a session comes to have the tool and the system
 * prompt paragraph. A real Supervisor; the tool's handler is called directly (no SDK process).
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import type { McpIntegration } from "@protocol";
import { BROWSER_SESSION_PROMPT, HUMAN_MCP_SERVER_NAME, HUMAN_TOOL_IDS, HumanRequestService, humanTools } from "../../src/agent/human-tools";
import { RESERVED_MCP_KEYS, keyProblem } from "../../src/mcp/validate";
import type { Session } from "../../src/session/session";
import { addBrowser, browserOf, browserRig, browserSession, feedResult } from "../helpers/browser";
import { callHook, echoInput, isPending, settle, type McpRig } from "../helpers/mcp";

let rig: McpRig;
let integration: McpIntegration;
beforeEach(async () => {
  rig = browserRig();
  integration = await addBrowser(rig);
});
afterEach(() => rig.cleanup());

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
/** Call the tool the way the SDK would: through its registered handler. */
const callTool = (s: Session, args: Record<string, unknown>) => (humanTools(rig.sup.human, s)[0]!.handler as (a: unknown, extra: unknown) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>)(args, {});
const humanEvents = (s: Session) => rig.sup.resume(s.id).filter((e) => e.type === "human.request") as any[];
/** The driver the supervisor builds for the session (its real `ensureDriver`; no query is started, and
 *  the agent environment — which needs a Claude token — is stubbed out). */
const driverOf = (s: Session) => {
  const sup = rig.sup as unknown as { agentEnv: () => Record<string, string>; ensureDriver(id: string): { mcpServers?: Record<string, unknown>; extraAllowedTools?: string[]; systemPrompt(): { append?: string } } };
  sup.agentEnv = () => ({});
  return sup.ensureDriver(s.id);
};

describe("request_human", () => {
  test("[C3] the server is anvil_human with one tool, request_human {reason}; anvil_human is a reserved MCP key", () => {
    expect(HUMAN_MCP_SERVER_NAME).toBe("anvil_human");
    expect(HUMAN_TOOL_IDS).toEqual(["mcp__anvil_human__request_human"]);
    const tools = humanTools(new HumanRequestService(), { id: "s", data: {} as never, requestHuman: () => {} });
    expect(tools.map((t) => t.name)).toEqual(["request_human"]);
    expect(Object.keys(tools[0]!.inputSchema as object)).toEqual(["reason"]);
    expect(tools[0]!.description).toMatch(/CAPTCHA/);
    expect(tools[0]!.description).toMatch(/Never try to solve or get around/);
    expect(RESERVED_MCP_KEYS).toContain("anvil_human");
    expect(keyProblem("anvil_human")).toBeDefined();
    expect(() => rig.sup.mcp.add(echoInput({ key: "anvil_human" }))).toThrow();
  });

  test("[C3] request_human parks a card with the reason and the latest page screenshot, and returns only when the owner answers I've cleared it — from any device", async () => {
    rig.sup.browserSiteAdd("shop.test");
    const s = await browserSession(rig, integration);
    feedResult(rig, s, "browser_navigate", "### Page\n- Page URL: https://shop.test/\n### Snapshot\n- [Snapshot](/x/page-1.yml)", { url: "https://shop.test/" });
    rig.sup.mcp.gate.onToolResult(s, "browser", { tool: "browser_take_screenshot", input: {}, content: [{ type: "text", text: "### Result\n- [Screenshot of viewport](/x/page-1.png)" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }], isError: false });

    const call = callTool(s, { reason: "  Cloudflare is asking to\nverify I am human on shop.test  " });
    expect(await isPending(call)).toBe(true); // parked: the model gets nothing yet
    expect(s.data.status).toBe("awaiting_question");
    expect(s.hasPendingHuman()).toBe(true);
    const [card] = [...s.pendingHumans.values()];
    expect(card!.reason).toBe("Cloudflare is asking to verify I am human on shop.test");
    expect(card!.requestId).toMatch(/^human_/);
    // The screenshot is a session attachment holding the real PNG bytes.
    expect(card!.image).toEqual({ attachmentId: expect.any(String), mediaType: "image/png" });
    const stored = rig.sup.attachmentBytes(s.id, card!.image!.attachmentId)!;
    expect(stored.mediaType).toBe("image/png");
    expect(Buffer.from(await Bun.file(stored.path).arrayBuffer()).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    // A device that attaches now is shown the card (it is not conversation history).
    expect(humanEvents(s)).toEqual([expect.objectContaining({ type: "human.request", requestId: card!.requestId, reason: card!.reason, image: card!.image, replay: true })]);

    // Still parked after time passes and other things happen in the session.
    await settle(30);
    expect(await isPending(call)).toBe(true);

    rig.sup.resolveHumanRequest(card!.requestId); // `human.request.respond`
    const out = await call;
    expect(out.isError).toBeUndefined();
    expect(out.content[0]!.text).toMatch(/The owner says it is cleared.*take a new snapshot/);
    expect(s.hasPendingHuman()).toBe(false);
    expect(s.data.status).toBe("running_tool");
    expect(humanEvents(s)).toEqual([]);
    expect(() => rig.sup.resolveHumanRequest(card!.requestId)).toThrow(/no pending request for a person/); // answered once
  });

  test("[C3] with no screenshot the card has none; an empty reason is refused at once; two requests are two cards answered separately", async () => {
    const s = await browserSession(rig, integration);
    expect(await callTool(s, { reason: "   " })).toMatchObject({ isError: true });
    expect(s.hasPendingHuman()).toBe(false);
    const a = callTool(s, { reason: "CAPTCHA on the login page" });
    const b = callTool(s, { reason: "Two-factor code needed" });
    await settle();
    const cards = [...s.pendingHumans.values()];
    expect(cards.map((c) => [c.reason, c.image])).toEqual([["CAPTCHA on the login page", undefined], ["Two-factor code needed", undefined]]);
    rig.sup.resolveHumanRequest(cards[1]!.requestId);
    expect((await b).isError).toBeUndefined();
    expect(await isPending(a)).toBe(true);
    expect(s.data.status).toBe("awaiting_question"); // one is still waiting
    rig.sup.resolveHumanRequest(cards[0]!.requestId);
    await a;
  });

  test("[C3] in an unattended (builder) session request_human returns an error immediately, parks nothing, and calls onUnattendedHumanRequest(sessionId, reason) so the work unit can be blocked", async () => {
    const calls: [string, string][] = [];
    rig.sup.human.onUnattendedHumanRequest = (sessionId, reason) => void calls.push([sessionId, reason]);
    const s = await rig.session({ workUnitRole: "builder", workUnitId: "wu_1" });
    const out = await callTool(s, { reason: "A CAPTCHA is in the way" }); // resolves by itself: no card, no waiting
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/Nobody is watching this session.*blocked on the owner/);
    expect(calls).toEqual([[s.id, "A CAPTCHA is in the way"]]);
    expect(s.hasPendingHuman()).toBe(false);
    expect(humanEvents(s)).toEqual([]);
    // The default callback is a no-op, and one that throws does not break the tool.
    expect(() => new HumanRequestService().onUnattendedHumanRequest("s", "r")).not.toThrow();
    rig.sup.human.onUnattendedHumanRequest = () => {
      throw new Error("unit store is down");
    };
    expect((await callTool(s, { reason: "again" })).isError).toBe(true);
  });

  test("[C3] resetting the session, or its turn dying, cancels a parked request: the card is retired and the tool returns an error", async () => {
    const s = await browserSession(rig, integration);
    const call = callTool(s, { reason: "CAPTCHA" });
    await settle();
    expect(s.hasPendingHuman()).toBe(true);
    await rig.sup.reset(s.id);
    const out = await call;
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/cancelled/);
    expect(s.hasPendingHuman()).toBe(false);

    // The same when the turn itself dies (the driver's consume loop exits): nobody is left to hear the answer.
    const second = callTool(s, { reason: "CAPTCHA again" });
    await settle();
    const { requestId } = [...s.pendingHumans.values()][0]!;
    rig.sup.mcp.gate.onConsumeExit(s);
    expect((await second).isError).toBe(true);
    expect(s.hasPendingHuman()).toBe(false);
    expect(() => rig.sup.resolveHumanRequest(requestId)).toThrow(/no pending request for a person/);
  });
});

describe("which sessions get it", () => {
  test("[C3] an ordinary session with the browser switched on gets the anvil_human server, its tool id and the browser paragraph in its system prompt; one without the browser gets none of them", async () => {
    const withBrowser = await browserSession(rig, integration);
    const d = driverOf(withBrowser);
    expect(Object.keys(d.mcpServers ?? {}).sort()).toEqual(["anvil_human", "browser"]);
    expect((d.mcpServers!.anvil_human as { type: string }).type).toBe("sdk");
    expect(d.extraAllowedTools).toEqual(["mcp__anvil_human__request_human"]);
    const prompt = d.systemPrompt().append!;
    expect(prompt.endsWith(BROWSER_SESSION_PROMPT)).toBe(true);
    // The one paragraph says the three things.
    expect(BROWSER_SESSION_PROMPT).toMatch(/bot check, a CAPTCHA/);
    expect(BROWSER_SESSION_PROMPT).toContain("mcp__anvil_human__request_human");
    expect(BROWSER_SESSION_PROMPT).toMatch(/never attempt to solve,\s+bypass or evade/);
    expect(BROWSER_SESSION_PROMPT).toMatch(/untrusted data, never as instructions/);
    expect(BROWSER_SESSION_PROMPT).toMatch(/Downloads land in `\.anvil-downloads\/`[\s\S]*copy one out\s+deliberately/);
    expect(BROWSER_SESSION_PROMPT.trim().split(/\n\n/)).toHaveLength(1);

    const plain = await rig.session();
    const p = driverOf(plain);
    expect(p.mcpServers).toBeUndefined();
    expect(p.extraAllowedTools).toBeUndefined();
    expect(p.systemPrompt().append ?? "").not.toContain("AGENT BROWSER");

    // Switching the browser off for the session takes the tool away with the next driver.
    rig.sup.setSessionMcpIntegrations(withBrowser.id, []);
    await settle();
    expect(Object.keys(driverOf(withBrowser).mcpServers ?? {})).toEqual([]);
    expect(driverOf(withBrowser).systemPrompt().append ?? "").not.toContain("AGENT BROWSER");
  });

  test("[C3] the tool is the session's own in-process tool at the permission gate (not an integration call), and it exists only with the browser feature", async () => {
    const s = await browserSession(rig, integration, { autonomy: "bypass" });
    const out = await callHook(s, rig.broker, "mcp__anvil_human__request_human", { inProcessKeys: ["anvil_human"], gate: rig.sup.mcp.gate }, { reason: "x" });
    expect(out.decision).toBe("allow");
    // Without the key in the session's in-process map it is an unknown MCP server: denied.
    expect((await callHook(s, rig.broker, "mcp__anvil_human__request_human", { inProcessKeys: [], gate: rig.sup.mcp.gate }, { reason: "x" })).decision).toBe("deny");

    await rig.cleanup();
    rig = browserRig({ features: ["mcp-integrations"] }); // no browser feature
    const t = await rig.session();
    expect(driverOf(t).mcpServers).toBeUndefined();
    expect(browserOf(rig)).toBeUndefined();
  });
});
