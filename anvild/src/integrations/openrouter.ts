/**
 * Minimal, dependency-free client for OpenRouter's OpenAI-compatible chat endpoint
 * (`https://openrouter.ai/api/v1/chat/completions`). Auth is an OpenRouter key sent as
 * `Authorization: Bearer <key>` — a DIFFERENT provider from Anthropic, so this deliberately does NOT
 * go through the Agent SDK or the agent subprocess (both of which are governed by the §3
 * subscription-auth guard and strip API keys). It runs in the daemon process itself, mirroring the
 * fetch-based style of TodoistClient (including run-level AbortSignal support).
 *
 * Supports OpenAI-style function/tool calling so the adversarial panel can run an agent loop: the
 * model requests `tool_calls`, the daemon executes them (read-only repo tools) and replies with
 * `role:"tool"` messages, and the loop repeats until the model returns a final answer.
 */
const API_URL = "https://openrouter.ai/api/v1/chat/completions";
// A single hung request must never block an autopilot run forever (the panel fans out across models
// and awaits them); cap each call the way TodoistClient does.
const REQUEST_TIMEOUT_MS = 60_000;

export interface OpenRouterToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenRouterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** Present on an assistant message that requested tools (echoed back so the model has context). */
  tool_calls?: OpenRouterToolCall[];
  /** Present on a `role:"tool"` reply, linking it to the assistant's tool_call. */
  tool_call_id?: string;
}

/** An OpenAI-compatible function-tool definition (see `REPO_TOOLS`). */
export interface OpenRouterTool {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

export interface OpenRouterCompletion {
  content: string;
  toolCalls: OpenRouterToolCall[];
  finishReason?: string;
}

interface ChatResponse {
  choices?: {
    message?: { content?: string | null; tool_calls?: OpenRouterToolCall[] };
    finish_reason?: string;
  }[];
}

export class OpenRouterClient {
  constructor(
    private readonly apiKey: string,
    /** Optional run-level abort: when the autopilot run is cancelled/timed-out, every in-flight
     *  OpenRouter call unwinds instead of hanging. Composed with a per-request timeout below. */
    private readonly signal?: AbortSignal,
    /** Optional preferred provider slug (e.g. "deepinfra"). Sent as a routing preference (`order`) with
     *  `allow_fallbacks: true`, so a model this provider can't serve still routes normally. Pinning keeps
     *  a provider's implicit prompt cache warm across the agent loop's repeated-prefix rounds. */
    private readonly provider?: string,
  ) {}

  /**
   * Send a chat completion, returning the assistant's text plus any tool calls it requested. This is
   * the full-fidelity entry point used by the agent loop; `chat()` wraps it for the simple text case.
   */
  async complete(
    model: string,
    messages: OpenRouterMessage[],
    opts: { temperature?: number; tools?: OpenRouterTool[]; toolChoice?: "auto" | "none" } = {},
  ): Promise<OpenRouterCompletion> {
    // Honour an already-aborted run-level signal before touching the network — mirrors the
    // TodoistClient abort discipline the unit tests rely on (no network on an aborted signal).
    if (this.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    // Abort when EITHER the run is cancelled OR this call outlives REQUEST_TIMEOUT_MS.
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        // OpenRouter's recommended attribution headers (used for its rankings / dashboard).
        "HTTP-Referer": "https://github.com/anvil",
        "X-Title": "anvil",
      },
      body: JSON.stringify({
        model,
        messages,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.tools?.length ? { tools: opts.tools, tool_choice: opts.toolChoice ?? "auto" } : {}),
        // Prefer the pinned provider but allow fallbacks: a model this provider can't serve (e.g. an
        // OpenAI slug when pinned to a GLM host) routes normally instead of erroring.
        ...(this.provider ? { provider: { order: [this.provider], allow_fallbacks: true } } : {}),
      }),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenRouter ${model} → ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    const json = (await res.json()) as ChatResponse;
    const choice = json.choices?.[0];
    return {
      content: choice?.message?.content ?? "",
      toolCalls: choice?.message?.tool_calls ?? [],
      finishReason: choice?.finish_reason,
    };
  }

  /** Send a chat completion and return just the assistant's text. Throws on non-2xx (status + body). */
  async chat(model: string, messages: OpenRouterMessage[], opts: { temperature?: number } = {}): Promise<string> {
    return (await this.complete(model, messages, opts)).content;
  }
}
