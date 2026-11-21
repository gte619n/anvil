/**
 * Fleet skill library end-to-end (docs/plans/2026-11-19-fleet-skills.md): two real daemons, a hub whose
 * fleet.json lists the other as a member. A skill saved on the hub over the WS lands on the member's disk
 * via /api/skills/replica; removing it propagates; the member refuses local edits; and a daemon that
 * has members of its own refuses to adopt anyone else's library.
 */
import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bootServer } from "../helpers";

const md = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`;

/** A minimal WS client: send a correlated command and resolve on its ack / command.error. */
async function openWs(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const events: any[] = [];
  ws.addEventListener("message", (ev) => events.push(JSON.parse(String((ev as MessageEvent).data))));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
  let n = 0;
  const call = (cmd: Record<string, unknown>, timeoutMs = 15_000): Promise<any> => {
    const cid = `c${++n}`;
    ws.send(JSON.stringify({ v: 4, ...cmd, cid }));
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        const hit = events.find((e) => e.cid === cid && (e.type === "ack" || e.type === "command.error"));
        if (hit) return resolve(hit);
        if (Date.now() - started > timeoutMs) return reject(new Error(`timeout on ${String(cmd.type)}`));
        setTimeout(tick, 20);
      };
      tick();
    });
  };
  return { ws, events, call };
}

test("a skill saved on the hub replicates to the member, and removal propagates", async () => {
  const member = await bootServer();
  const memberHealth = (await (await fetch(`${member.base}/api/health`)).json()) as { serverId: string };
  const hub = await bootServer({
    fleetMembers: [{ serverId: memberHealth.serverId, serverName: "member", host: "127.0.0.1", url: `http://127.0.0.1:${member.port}/` }],
  });
  const h = await openWs(hub.port);
  const m = await openWs(member.port);
  try {
    const ack = await h.call({ type: "skill.save", name: "ship-it", body: md("ship-it", "Ship the release") });
    expect(ack.type).toBe("ack");
    // The save itself kicks a push; `skill.sync` waits for a sweep to finish (coalesced with that one).
    expect((await h.call({ type: "skill.sync" })).type).toBe("ack");

    const skillMd = join(member.dir, "fleet-skills", "skills", "ship-it", "SKILL.md");
    expect(readFileSync(skillMd, "utf8")).toContain("Body of ship-it.");
    const hubHash = ((await (await fetch(`${hub.base}/api/skills/replica`)).json()) as { hash: string }).hash;
    const rep = (await (await fetch(`${member.base}/api/skills/replica`)).json()) as { hash: string; role: string };
    expect(rep).toMatchObject({ hash: hubHash, role: "replica" });

    // The hub's `skills` event reports the member in sync.
    await h.call({ type: "skill.list" });
    const last = [...h.events].reverse().find((e) => e.type === "skills");
    expect(last.role).toBe("hub");
    expect(last.members).toEqual([expect.objectContaining({ serverId: memberHealth.serverId, inSync: true })]);

    // A replica refuses local edits — they belong on the hub.
    const denied = await m.call({ type: "skill.save", name: "nope", body: md("nope", "x") });
    expect(denied.type).toBe("command.error");
    expect(denied.message).toMatch(/hub/);

    // Removal propagates.
    await h.call({ type: "skill.remove", name: "ship-it" });
    await h.call({ type: "skill.sync" });
    expect(existsSync(skillMd)).toBe(false);
  } finally {
    h.ws.close();
    m.ws.close();
    hub.cleanup();
    member.cleanup();
  }
}, 30_000);

test("a daemon with members of its own refuses a replica push", async () => {
  const hub = await bootServer({ fleetMembers: [{ serverId: "srv_x", serverName: "x", host: "127.0.0.1", url: "http://127.0.0.1:1/" }] });
  try {
    const res = await fetch(`${hub.base}/api/skills/replica`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hubServerId: "srv_other", hash: "", skills: [] }),
    });
    expect(res.status).toBe(409);
  } finally {
    hub.cleanup();
  }
});
