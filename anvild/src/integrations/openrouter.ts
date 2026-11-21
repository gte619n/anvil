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
import { retryAsync, parseRetryAfterMs } from "../util/retry";

const API_URL = "https://openrouter.ai/api/v1/chat/completions";
/** Google's OpenAI-compatible endpoint for the Gemini API (Bearer = a Gemini API key). Same wire shape
 *  as OpenRouter, so the one client below drives both — see {@link geminiClient}. */
export const GEMINI_OPENAI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
// A single hung request must never block an autopilot run forever (the panel fans out across models
// and awaits them); cap each call the way TodoistClient does.
const REQUEST_TIMEOUT_MS = 60_000;

export interface OpenRouterToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Gemini 3+ returns its thought signature here (`{google:{thought_signature}}`) and REQUIRES it back
   *  on the next turn, or tool calls 400. The agent loop echoes tool calls verbatim, which preserves it. */
  extra_content?: unknown;
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
    /** The chat-completions URL. Defaults to OpenRouter; {@link geminiClient} points it at Google. Any
     *  non-OpenRouter URL drops the OpenRouter-only extras (attribution headers, `provider` routing). */
    private readonly url: string = API_URL,
  ) {}

  private get isOpenRouter(): boolean {
    return this.url === API_URL;
  }

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
    // [BE-5] Retry transient 429/5xx (the panel fans out across models and can rate-limit the key),
    // honoring Retry-After. 401/4xx (auth/bad request) are not retried.
    return retryAsync(() => this.doComplete(model, messages, opts), {
      isRetryable: (e) => {
        const s = (e as { status?: number })?.status;
        return s === 429 || (s ?? 0) >= 500;
      },
      retryAfterMs: (e) => (e as { retryAfterMs?: number })?.retryAfterMs,
      signal: this.signal,
    });
  }

  private async doComplete(
    model: string,
    messages: OpenRouterMessage[],
    opts: { temperature?: number; tools?: OpenRouterTool[]; toolChoice?: "auto" | "none" } = {},
  ): Promise<OpenRouterCompletion> {
    // Abort when EITHER the run is cancelled OR this call outlives REQUEST_TIMEOUT_MS.
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        // OpenRouter's recommended attribution headers (used for its rankings / dashboard).
        ...(this.isOpenRouter ? { "HTTP-Referer": "https://github.com/anvil", "X-Title": "anvil" } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.tools?.length ? { tools: opts.tools, tool_choice: opts.toolChoice ?? "auto" } : {}),
        // Prefer the pinned provider but allow fallbacks: a model this provider can't serve (e.g. an
        // OpenAI slug when pinned to a GLM host) routes normally instead of erroring.
        ...(this.provider && this.isOpenRouter ? { provider: { order: [this.provider], allow_fallbacks: true } } : {}),
      }),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(
        `${this.isOpenRouter ? "OpenRouter" : "Gemini"} ${model} → ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`,
      ) as Error & { status?: number; retryAfterMs?: number };
      err.status = res.status;
      err.retryAfterMs = parseRetryAfterMs(res);
      throw err;
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

/** A direct-to-Google Gemini client (OpenAI-compatible endpoint, Gemini API key). Model ids are Google's
 *  own (`gemini-4-argon`), not OpenRouter slugs. */
export function geminiClient(apiKey: string, signal?: AbortSignal): OpenRouterClient {
  return new OpenRouterClient(apiKey, signal, undefined, GEMINI_OPENAI_URL);
}

/** What the adversarial panel needs from a client — satisfied by {@link OpenRouterClient} and
 *  {@link PanelClient}. */
export type ChatClient = Pick<OpenRouterClient, "complete" | "chat">;

/** Panel model ids with this prefix are Gemini models called DIRECTLY on Google's API when a Gemini key
 *  is set (`gemini/gemini-4-argon`), falling back to the same model via OpenRouter (`google/…`). */
export const DIRECT_GEMINI_PREFIX = "gemini/";

/**
 * Routes each panel model to the right provider: `gemini/<id>` goes to Google directly when a Gemini key
 * is present (else to OpenRouter as `google/<id>`); everything else goes to OpenRouter. A model whose
 * provider has no key fails with a clear message — the panel records it as an `error` critique.
 */
export class PanelClient implements ChatClient {
  private readonly openRouter?: OpenRouterClient;
  private readonly gemini?: OpenRouterClient;

  constructor(keys: { openRouter?: string; gemini?: string }, signal?: AbortSignal, provider?: string) {
    if (keys.openRouter?.trim()) this.openRouter = new OpenRouterClient(keys.openRouter.trim(), signal, provider);
    if (keys.gemini?.trim()) this.gemini = geminiClient(keys.gemini.trim(), signal);
  }

  /** True when at least one provider key is present (the panel can run at all). */
  get usable(): boolean {
    return !!(this.openRouter || this.gemini);
  }

  private route(model: string): { client: OpenRouterClient; model: string } {
    if (model.startsWith(DIRECT_GEMINI_PREFIX)) {
      const id = model.slice(DIRECT_GEMINI_PREFIX.length);
      if (this.gemini) return { client: this.gemini, model: id };
      if (this.openRouter) return { client: this.openRouter, model: `google/${id}` };
      throw new Error("no Gemini or OpenRouter key set — add one in Settings → Models");
    }
    if (this.openRouter) return { client: this.openRouter, model };
    throw new Error("no OpenRouter key set — add one in Settings → Models");
  }

  complete(...[model, messages, opts]: Parameters<OpenRouterClient["complete"]>): ReturnType<OpenRouterClient["complete"]> {
    const r = this.route(model);
    return r.client.complete(r.model, messages, opts);
  }

  chat(...[model, messages, opts]: Parameters<OpenRouterClient["chat"]>): ReturnType<OpenRouterClient["chat"]> {
    const r = this.route(model);
    return r.client.chat(r.model, messages, opts);
  }
}
