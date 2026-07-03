import { test, expect, mock, afterEach } from "bun:test";
import { OpenRouterClient } from "../../src/integrations/openrouter";

// The OpenRouter client is a plain fetch against the OpenAI-compatible endpoint — no SDK, no agent
// subprocess (it's a different provider with its own key, outside the §3 subscription-auth guard).
// These stub globalThis.fetch to assert request shape / response handling without touching the network.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("chat() posts the OpenAI-compatible request shape with auth + model + messages", async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = mock(async (url: any, init: any) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const client = new OpenRouterClient("test-key");
  await client.chat("z-ai/glm-4.6", [{ role: "user", content: "hi" }]);

  expect(captured!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(captured!.init.method).toBe("POST");
  const headers = captured!.init.headers as Record<string, string>;
  expect(headers["Authorization"]).toBe("Bearer test-key");
  expect(headers["Content-Type"]).toBe("application/json");
  const body = JSON.parse(String(captured!.init.body));
  expect(body.model).toBe("z-ai/glm-4.6");
  expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
});

test("chat() resolves to the assistant message content", async () => {
  globalThis.fetch = mock(
    async () => new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), { status: 200 }),
  ) as unknown as typeof fetch;

  const client = new OpenRouterClient("k");
  expect(await client.chat("m", [{ role: "user", content: "x" }])).toBe("hello");
});

test("chat() rejects with the status on a non-2xx response", async () => {
  globalThis.fetch = mock(
    async () => new Response("nope", { status: 401, statusText: "Unauthorized" }),
  ) as unknown as typeof fetch;

  const client = new OpenRouterClient("bad");
  await expect(client.chat("m", [{ role: "user", content: "x" }])).rejects.toThrow(/401/);
});

test("complete() forwards tools + tool_choice and returns the model's tool_calls", async () => {
  let body: any;
  globalThis.fetch = mock(async (_url: any, init: any) => {
    body = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"x"}' } }] },
            finish_reason: "tool_calls",
          },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const tools = [{ type: "function" as const, function: { name: "read_file", description: "d", parameters: {} } }];
  const client = new OpenRouterClient("k");
  const res = await client.complete("m", [{ role: "user", content: "x" }], { tools });

  expect(body.tools).toHaveLength(1);
  expect(body.tool_choice).toBe("auto");
  expect(res.toolCalls[0]!.function.name).toBe("read_file");
  expect(res.content).toBe("");
});

test("a pinned provider is sent as a routing preference with fallbacks allowed", async () => {
  let body: any;
  globalThis.fetch = mock(async (_url: any, init: any) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const client = new OpenRouterClient("k", undefined, "deepinfra");
  await client.chat("z-ai/glm-5.2", [{ role: "user", content: "x" }]);
  expect(body.provider).toEqual({ order: ["deepinfra"], allow_fallbacks: true });
});

test("no provider field is sent when the client isn't pinned", async () => {
  let body: any;
  globalThis.fetch = mock(async (_url: any, init: any) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  await new OpenRouterClient("k").chat("m", [{ role: "user", content: "x" }]);
  expect(body.provider).toBeUndefined();
});

test("complete() omits tools when none are given", async () => {
  let body: any;
  globalThis.fetch = mock(async (_url: any, init: any) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  await new OpenRouterClient("k").complete("m", [{ role: "user", content: "x" }]);
  expect(body.tools).toBeUndefined();
  expect(body.tool_choice).toBeUndefined();
});

test("chat() honours an already-aborted signal without touching the network", async () => {
  const spy = mock(async () => new Response("{}", { status: 200 }));
  globalThis.fetch = spy as unknown as typeof fetch;

  const client = new OpenRouterClient("k", AbortSignal.abort());
  await expect(client.chat("m", [{ role: "user", content: "x" }])).rejects.toMatchObject({ name: "AbortError" });
  expect(spy).not.toHaveBeenCalled();
});
