/**
 * [P7] IntegrationsFacade — the Todoist/lapo domain extracted from Supervisor. Pins the local/sync
 * surface + broadcast wiring (the network paths — connectTodoist/whoami, the OAuth exchange — are covered
 * by lapo-client + the dispatch integration tests, which exercise this via Supervisor delegation). This
 * is the coverage the extraction creates: the facade is now unit-constructible with injected deps.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@protocol";
import { IntegrationStore } from "../../src/integrations/store";
import { IntegrationsFacade } from "../../src/session/integrations-facade";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "anvil-intfacade-"));
  const store = new IntegrationStore(dir);
  const broadcasts: ServerEvent[] = [];
  const facade = new IntegrationsFacade({
    integrations: store,
    registry: { toAll: (e: ServerEvent) => broadcasts.push(e) } as never,
    selfBaseUrl: async () => "https://host.ts.net:7701",
    cachedSelfBaseUrl: () => "https://host.ts.net:7701",
  });
  return { store, facade, broadcasts, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("[P7] todoistStatusEvent reflects the store; disconnect broadcasts + clears", () => {
  const { store, facade, broadcasts, cleanup } = harness();
  try {
    expect(facade.todoistStatusEvent().connected).toBe(false);
    store.setTodoistToken("tok_abc", "me@ex.com");
    const ev = facade.todoistStatusEvent("c1");
    expect(ev.type).toBe("todoist.status");
    expect(ev.connected).toBe(true);
    expect(ev.account).toBe("me@ex.com");
    expect(ev.cid).toBe("c1");
    expect(facade.todoistTokenForFleet()).toBe("tok_abc"); // raw token for fleet replication only

    const result = facade.disconnectTodoist("c2");
    expect(result.connected).toBe(false);
    expect(broadcasts.at(-1)?.type).toBe("todoist.status"); // refreshed every client
    expect(facade.todoistStatusEvent().connected).toBe(false);
  } finally {
    cleanup();
  }
});

test("[P7] lapoStatusEvent carries the callback URL derived from the self base URL", () => {
  const { facade, cleanup } = harness();
  try {
    const ev = facade.lapoStatusEvent("c9");
    expect(ev.type).toBe("lapo.status");
    expect(ev.connected).toBe(false);
    expect(ev.cid).toBe("c9");
    // callbackUrl (when present) must be anchored on the injected self base URL, not a client origin.
    if (ev.callbackUrl) expect(ev.callbackUrl.startsWith("https://host.ts.net:7701")).toBe(true);
  } finally {
    cleanup();
  }
});

test("[P7] listTodoistProjects rejects when Todoist isn't connected (no network hit)", async () => {
  const { facade, cleanup } = harness();
  try {
    await expect(facade.listTodoistProjects()).rejects.toThrow(/not connected/i);
  } finally {
    cleanup();
  }
});
