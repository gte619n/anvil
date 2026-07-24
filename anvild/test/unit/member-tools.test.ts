import { test, expect } from "bun:test";
import { memberTools, MEMBER_TOOL_IDS, type MemberToolDeps } from "../../src/agent/member-tools";

test("MEMBER_TOOL_IDS is the single message_lead tool", () => {
  expect(MEMBER_TOOL_IDS).toEqual(["mcp__anvil_member__message_lead"]);
});

test("message_lead forwards the member's text to the relay dep", async () => {
  const sent: string[] = [];
  const deps: MemberToolDeps = { memberId: "m1", messageLead: (t) => { sent.push(t); return "relayed"; } };
  const tool = memberTools(deps).find((t) => t.name === "message_lead")!;
  const r = await tool.handler({ text: "blocked on the API schema — which version?" }, {});
  expect(sent).toEqual(["blocked on the API schema — which version?"]);
  expect((r as any).content[0].text).toContain("relayed");
});

test("a throwing relay surfaces as an isError result, not an exception", async () => {
  const deps: MemberToolDeps = { memberId: "m1", messageLead: () => { throw new Error("relay limit reached"); } };
  const tool = memberTools(deps).find((t) => t.name === "message_lead")!;
  const r = await tool.handler({ text: "hi" }, {});
  expect((r as any).isError).toBe(true);
  expect((r as any).content[0].text).toContain("relay limit reached");
});
