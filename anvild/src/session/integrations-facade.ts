/**
 * External-integration facade (Todoist + lapo), extracted from Supervisor as part of the P7 god-file
 * decomposition. Owns the Todoist token lifecycle and the full lapo OAuth2 handshake + status, all over
 * the persisted `IntegrationStore`. Behaviour-preserving: the methods moved verbatim from Supervisor, with
 * the two Supervisor internals they touched (`registry` broadcasts + the self-base-URL for the OAuth
 * redirect) injected. The Supervisor now delegates its public integration commands here and reuses
 * `effectiveLapoConfig`/`lapoAccessToken` for its autopilot-report posting.
 */
import {
  PROTOCOL_VERSION,
  type LapoAuthorizeEvent,
  type LapoStatusEvent,
  type TodoistProjectInfo,
  type TodoistProjectsResultEvent,
  type TodoistStatusEvent,
} from "@protocol";
import { now } from "../util/envelope";
import { newId } from "../util/ids";
import { resolveLapoConfig } from "../config";
import type { ConnectionRegistry } from "../server/registry";
import type { IntegrationStore } from "../integrations/store";
import { TodoistClient } from "../integrations/todoist";
import { LapoClient, tokenNeedsRefresh, type LapoConfig, type LapoTokens } from "../integrations/lapo";
import { BadCommand } from "./errors";

export interface IntegrationsFacadeDeps {
  integrations: IntegrationStore;
  registry: ConnectionRegistry;
  /** This daemon's externally-reachable base URL (async, tailscale-shelling; used for the OAuth redirect). */
  selfBaseUrl: () => Promise<string | undefined>;
  /** The cached self base URL, read synchronously for the callback-URL hint (undefined until discovered). */
  cachedSelfBaseUrl: () => string | undefined;
}

export class IntegrationsFacade {
  constructor(private readonly deps: IntegrationsFacadeDeps) {}

  private get integrations(): IntegrationStore {
    return this.deps.integrations;
  }
  private get registry(): ConnectionRegistry {
    return this.deps.registry;
  }

  todoistStatusEvent(cid?: string): TodoistStatusEvent {
    const state = this.integrations.todoist();
    return {
      v: PROTOCOL_VERSION,
      type: "todoist.status",
      ts: now(),
      ...(cid ? { cid } : {}),
      connected: !!state?.accessToken,
      ...(state?.account ? { account: state.account } : {}),
    };
  }

  /** Validate a personal API token against the API, then persist it and broadcast the new status. */
  async connectTodoist(token: string, cid?: string): Promise<TodoistStatusEvent> {
    const trimmed = token.trim();
    if (!trimmed) throw new BadCommand("A Todoist API token is required");
    let user;
    try {
      user = await new TodoistClient(trimmed).whoami(); // throws on a bad/revoked token
    } catch (e) {
      throw new BadCommand(`Todoist rejected that token: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.integrations.setTodoistToken(trimmed, user.email ?? user.full_name);
    this.registry.toAll(this.todoistStatusEvent()); // refresh every connected client
    return this.todoistStatusEvent(cid);
  }

  /** The raw stored token, for hub→member fleet replication ONLY. Never sent to a client. */
  todoistTokenForFleet(): string | undefined {
    return this.integrations.todoist()?.accessToken;
  }

  /** Clear the stored token and broadcast the disconnected status. */
  disconnectTodoist(cid?: string): TodoistStatusEvent {
    this.integrations.disconnectTodoist();
    this.registry.toAll(this.todoistStatusEvent());
    return this.todoistStatusEvent(cid);
  }

  async listTodoistProjects(cid?: string): Promise<TodoistProjectsResultEvent> {
    const state = this.integrations.todoist();
    if (!state?.accessToken) throw new BadCommand("Todoist is not connected");
    const client = new TodoistClient(state.accessToken);
    const [projects, tasks] = await Promise.all([client.projects(), client.tasks()]);
    const counts = new Map<string, number>();
    for (const t of tasks) counts.set(t.project_id, (counts.get(t.project_id) ?? 0) + 1);
    const infos: TodoistProjectInfo[] = projects.map((p) => ({
      id: p.id,
      name: p.name,
      ...(p.parent_id ? { parentId: p.parent_id } : {}),
      ...(p.is_inbox_project ? { isInbox: true } : {}),
      ...(p.is_favorite ? { isFavorite: true } : {}),
      taskCount: counts.get(p.id) ?? 0,
    }));
    return { v: PROTOCOL_VERSION, type: "todoist.projects.result", ts: now(), ...(cid ? { cid } : {}), projects: infos };
  }

  // ── lapo integration (OAuth2 information-entry reports) ────────────────────
  /** Current lapo connection state. `configured` is true unless lapo is explicitly disabled — a client
   *  id is no longer required (the daemon dynamically registers one). `callbackUrl` is the OAuth redirect
   *  the daemon will use (its own tailnet URL), shown in the UI so the user can register it if needed. */
  lapoStatusEvent(cid?: string): LapoStatusEvent {
    const state = this.integrations.lapo();
    const callback = this.cachedCallbackUrl();
    return {
      v: PROTOCOL_VERSION,
      type: "lapo.status",
      ts: now(),
      ...(cid ? { cid } : {}),
      connected: !!state?.accessToken,
      configured: !!resolveLapoConfig(),
      ...(state?.account ? { account: state.account } : {}),
      ...(callback ? { callbackUrl: callback } : {}),
    };
  }

  /** The OAuth callback URL from the cached self base URL (or ANVIL_BASE_URL). Sync — reads the cache
   *  populated by `selfBaseUrl()`; undefined until discovery has run once. */
  private cachedCallbackUrl(): string | undefined {
    const override = process.env.ANVIL_BASE_URL?.trim();
    const base = override ? override.replace(/\/+$/, "") : this.deps.cachedSelfBaseUrl();
    return base ? `${base}${LapoClient.callbackPath()}` : undefined;
  }

  /** The lapo config with the effective client id/secret filled in: from ANVIL_LAPO_CLIENT_ID if set,
   *  else the dynamically-registered client. `undefined` only when lapo is disabled. */
  effectiveLapoConfig(): LapoConfig | undefined {
    const base = resolveLapoConfig();
    if (!base || base.clientId) return base;
    const reg = this.integrations.lapoRegistration();
    return reg ? { ...base, clientId: reg.clientId, ...(reg.clientSecret ? { clientSecret: reg.clientSecret } : {}) } : base;
  }

  /** Begin the OAuth authorization-code handshake. Uses the daemon's OWN self-discovered URL for the
   *  redirect (the native shells' page origin is a local asset host, not reachable), discovers lapo's
   *  endpoints (RFC 8414), dynamically registers a client (RFC 7591) if none is configured, picks PKCE,
   *  stashes the handshake, and returns the authorize URL. The browser lands on the daemon's callback. */
  async beginLapoAuth(redirectBase: string, cid?: string): Promise<LapoAuthorizeEvent> {
    const baseCfg = resolveLapoConfig();
    if (!baseCfg) throw new BadCommand("lapo is disabled on this server (ANVIL_LAPO_DISABLE).");
    // The redirect MUST be the daemon's own URL — a client page origin is a local asset host in the
    // native shells (appassets.androidplatform.net / anvil-app://), which lapo can't reach.
    const self = (await this.deps.selfBaseUrl()) ?? redirectBase.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(self)) throw new BadCommand("couldn't determine this server's URL for the OAuth redirect — set ANVIL_BASE_URL.");
    const redirectUri = `${self}${LapoClient.callbackPath()}`;

    const disco = new LapoClient(baseCfg);
    const meta = await disco.discover();

    // Resolve a client id: env → stored registration (matching this redirect) → dynamic registration.
    let cfg = this.effectiveLapoConfig()!;
    const reg = this.integrations.lapoRegistration();
    if (!baseCfg.clientId && (!reg || reg.redirectUri !== redirectUri)) {
      const regEndpoint = meta?.registrationEndpoint;
      if (!regEndpoint) throw new BadCommand("this lapo doesn't advertise dynamic registration — set ANVIL_LAPO_CLIENT_ID.");
      const registered = await disco.registerClient({ registrationEndpoint: regEndpoint, redirectUri, scope: baseCfg.scope });
      this.integrations.setLapoRegistration({ ...registered, redirectUri });
      cfg = { ...baseCfg, clientId: registered.clientId, ...(registered.clientSecret ? { clientSecret: registered.clientSecret } : {}) };
    }
    if (!cfg.clientId) throw new BadCommand("lapo has no client id.");

    const client = new LapoClient(cfg);
    const usePkce = (meta?.codeChallengeMethodsSupported?.includes("S256") ?? false) || !cfg.clientSecret;
    const pkce = usePkce ? LapoClient.generatePkce() : undefined;
    const state = newId("lapoauth");
    this.integrations.setLapoPendingAuth(state, redirectUri, {
      ...(pkce ? { codeVerifier: pkce.verifier } : {}),
      ...(meta?.tokenEndpoint ? { tokenEndpoint: meta.tokenEndpoint } : {}),
    });
    const url = client.authorizeUrl({
      redirectUri,
      state,
      ...(meta?.authorizationEndpoint ? { authorizationEndpoint: meta.authorizationEndpoint } : {}),
      ...(pkce ? { codeChallenge: pkce.challenge } : {}),
    });
    return { v: PROTOCOL_VERSION, type: "lapo.authorize", ts: now(), ...(cid ? { cid } : {}), url };
  }

  /** Complete the handshake from the OAuth callback: validate `state`, exchange the code (reusing the
   *  discovered token endpoint + PKCE verifier the authorize step used), persist the tokens, and
   *  broadcast the connected status. Throws BadCommand on a bad/expired handshake or a rejected
   *  exchange. Returns the account label for the callback page. */
  async completeLapoAuth(code: string, state: string): Promise<{ account?: string }> {
    const cfg = this.effectiveLapoConfig();
    if (!cfg?.clientId) throw new BadCommand("lapo isn't ready — start again from Settings → Integrations.");
    const pending = this.integrations.consumeLapoPendingAuth(state);
    if (!pending) throw new BadCommand("this lapo authorization link has expired or didn't match — start again from Settings → Integrations.");
    const client = new LapoClient(cfg);
    let tokens: LapoTokens;
    try {
      tokens = await client.exchangeCode({
        code,
        redirectUri: pending.redirectUri,
        ...(pending.tokenEndpoint ? { tokenEndpoint: pending.tokenEndpoint } : {}),
        ...(pending.codeVerifier ? { codeVerifier: pending.codeVerifier } : {}),
      });
    } catch (e) {
      throw new BadCommand(`lapo rejected the authorization: ${e instanceof Error ? e.message : String(e)}`);
    }
    const [{ account }, entry] = await Promise.all([client.whoami(tokens.accessToken), client.discoverResource()]);
    this.integrations.setLapoTokens(tokens, account, pending.tokenEndpoint, entry);
    this.registry.toAll(this.lapoStatusEvent());
    return account ? { account } : {};
  }

  /** Clear the stored lapo tokens and broadcast the disconnected status. */
  disconnectLapo(cid?: string): LapoStatusEvent {
    this.integrations.disconnectLapo();
    this.registry.toAll(this.lapoStatusEvent());
    return this.lapoStatusEvent(cid);
  }

  /** A valid access token, refreshing (and persisting) proactively when it's within the expiry skew. */
  async lapoAccessToken(client: LapoClient): Promise<string> {
    const state = this.integrations.lapo();
    if (!state?.accessToken) throw new BadCommand("lapo is not connected");
    if (!tokenNeedsRefresh({ accessToken: state.accessToken, expiresAt: state.expiresAt }, Date.now()) || !state.refreshToken) return state.accessToken;
    const next = await client.refresh(state.refreshToken, { tokenEndpoint: state.tokenEndpoint });
    this.integrations.patchLapoTokens(next);
    return next.accessToken;
  }
}
