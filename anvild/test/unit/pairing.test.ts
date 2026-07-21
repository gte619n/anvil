import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ARM_TTL_MS,
  MAX_ARM_TTL_MS,
  PairedHubStore,
  PairingWindow,
  generatePairCode,
  isLoopbackAddress,
  isTailnetAddress,
  resolveCallerIdentity,
} from "../../src/server/pairing";
import { speaksPairing } from "../../src/server/fleet";

/**
 * anvil-headless-join.md §5.3, §7, §8.2/§8.5 — the joiner-side pairing gates.
 *
 * Push means a tokenless daemon exposes a route that ACCEPTS CREDENTIALS FROM THE NETWORK. Everything
 * in this file is the mitigation list from §8.2, turned into assertions: default-closed, locked to one
 * caller after first use, code AND tailnet identity both required, and — the one v1.0 of the spec got
 * wrong — a `Tailscale-User-Login` header trusted ONLY from a loopback peer.
 */

const HUB = "srv_hub";
const OTHER_HUB = "srv_other_hub";

/** A window with a controllable clock, so TTL expiry is deterministic rather than slept-on. */
function windowAt(start = 1_000_000) {
  let t = start;
  const w = new PairingWindow(() => t);
  return { w, advance: (ms: number) => (t += ms) };
}

// ── §8.2 default closed ─────────────────────────────────────────────────────────────────────────

test("unarmed: every pair attempt is rejected — even a well-formed one", () => {
  const { w } = windowAt();
  expect(w.isArmed()).toBe(false);
  expect(w.accept("123456", HUB)).toBe("not accepting pairings");
});

test("unarmed: NEVER notifies (HJ-33 — a tailnet scanner must not become a doorbell)", () => {
  const { w } = windowAt();
  w.accept("123456", HUB);
  expect(w.claimRejectionAlert()).toEqual({ notify: false, count: 0 });
});

// ── the code gate ───────────────────────────────────────────────────────────────────────────────

test("armed: the shown code is accepted; a wrong one is rejected and the window STAYS armed", () => {
  const { w } = windowAt();
  const { code } = w.arm();
  expect(w.accept("000000" === code ? "111111" : "000000", HUB)).toBe("wrong code");
  expect(w.isArmed()).toBe(true); // a typo must not force the operator to re-arm
  expect(w.accept(code, HUB)).toBeNull();
});

test("armed: rejections coalesce to ONE notification per window, with a count (HJ-33)", () => {
  const { w } = windowAt();
  w.arm();
  w.accept("000000", HUB);
  w.accept("000001", HUB);
  const first = w.claimRejectionAlert();
  expect(first.notify).toBe(true);
  expect(first.count).toBe(2);
  expect(w.claimRejectionAlert().notify).toBe(false);
});

test("expiry: a previously-valid code stops working once the window lapses", () => {
  const { w, advance } = windowAt();
  const { code } = w.arm(60_000);
  advance(60_001);
  expect(w.isArmed()).toBe(false);
  expect(w.accept(code, HUB)).toBe("not accepting pairings");
});

test("TTL is clamped — a client can't request an arbitrarily long credential-accepting window", () => {
  const { w } = windowAt();
  const start = 1_000_000;
  expect(w.arm(999 * 60_000).expiresAt - start).toBe(MAX_ARM_TTL_MS);
  expect(w.arm(1).expiresAt - start).toBe(60_000); // and not an instantly-dead one either
  expect(w.arm().expiresAt - start).toBe(DEFAULT_ARM_TTL_MS);
});

// ── HJ-16 / HJ-17 the lost-reply hole and its bound ─────────────────────────────────────────────

test("HJ-16: an accepted pair STAYS armed until the hub ACKs (so a lost reply can be retried)", () => {
  const { w } = windowAt();
  const { code } = w.arm();
  expect(w.accept(code, HUB)).toBeNull();
  expect(w.isArmed()).toBe(true);
  expect(w.accept(code, HUB)).toBeNull(); // the hub's retry still works
});

test("HJ-17: after first use the window locks to that hub — hub B can't replay hub A's code", () => {
  const { w } = windowAt();
  const { code } = w.arm();
  w.accept(code, HUB);
  expect(w.accept(code, OTHER_HUB)).toBe("locked to another hub");
});

test("ACK: the locked hub with the right code disarms the window", () => {
  const { w } = windowAt();
  const { code } = w.arm();
  w.accept(code, HUB);
  expect(w.ack(code, HUB)).toBe(true);
  expect(w.isArmed()).toBe(false);
});

test("ACK: an unrelated peer canNOT disarm someone else's window mid-flow (§5.3)", () => {
  const { w } = windowAt();
  const { code } = w.arm();
  w.accept(code, HUB);
  expect(w.ack(code, OTHER_HUB)).toBe(false); // wrong hub
  expect(w.ack("000000", HUB)).toBe(false); // right hub, wrong code
  expect(w.isArmed()).toBe(true); // still open for the real hub
});

test("ACK: an ACK before any code was accepted is refused (nothing to confirm)", () => {
  const { w } = windowAt();
  const { code } = w.arm();
  expect(w.ack(code, HUB)).toBe(false);
  expect(w.isArmed()).toBe(true);
});

test("ACK: idempotent — a re-sent ACK after disarm returns ok, not an error", () => {
  const { w } = windowAt();
  const { code } = w.arm();
  w.accept(code, HUB);
  expect(w.ack(code, HUB)).toBe(true);
  expect(w.ack(code, HUB)).toBe(true); // the hub retries an ACK whose reply it lost
});

test("TTL expiry disarms without an ACK", () => {
  const { w, advance } = windowAt();
  const { code } = w.arm(60_000);
  w.accept(code, HUB);
  advance(60_001);
  expect(w.isArmed()).toBe(false);
});

// ── the code itself ─────────────────────────────────────────────────────────────────────────────

test("codes are 6 digits, zero-padded, and not obviously constant", () => {
  const codes = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const c = generatePairCode();
    expect(c).toMatch(/^\d{6}$/);
    codes.add(c);
  }
  expect(codes.size).toBeGreaterThan(150); // drawn from a CSPRNG, not a counter
});

// ── §7 / HJ-37 caller identity ──────────────────────────────────────────────────────────────────

const selfLogin = async (): Promise<string | null> => "me@example.com";
const noWhois = async (): Promise<string | null> => null;

test("address classification", () => {
  expect(isLoopbackAddress("127.0.0.1")).toBe(true);
  expect(isLoopbackAddress("::1")).toBe(true);
  expect(isTailnetAddress("100.64.0.1")).toBe(true);
  expect(isTailnetAddress("100.127.255.254")).toBe(true);
  expect(isTailnetAddress("fd7a:115c:a1e0::1")).toBe(true);
  expect(isTailnetAddress("10.0.0.5")).toBe(false); // a LAN peer is NOT the tailnet
  expect(isTailnetAddress("100.200.0.1")).toBe(false); // 100.x outside the CGNAT /10
});

test("serve mode: loopback WITH the injected header, matching this node's owner → sameUser", async () => {
  const r = await resolveCallerIdentity({ peerAddress: "127.0.0.1", headerLogin: "me@example.com", selfLogin, whois: noWhois });
  expect(r.trust).toBe("sameUser");
});

test("serve mode: loopback with NO header is REJECTED, not auto-trusted (§7 branch 1)", async () => {
  // Not "unknown identity" — that's what an unauthenticated local process presents. It's a caller that
  // bypassed the proxy, so it gets nothing.
  const r = await resolveCallerIdentity({ peerAddress: "127.0.0.1", headerLogin: null, selfLogin, whois: noWhois });
  expect(r.trust).toBe("otherUser");
  expect(r.reject).toBeTruthy();
});

test("serve mode: loopback with a header naming a DIFFERENT user → rejected", async () => {
  const r = await resolveCallerIdentity({ peerAddress: "127.0.0.1", headerLogin: "someone@else.com", selfLogin, whois: noWhois });
  expect(r.trust).toBe("otherUser");
});

test("direct bind: whois says same user → sameUser", async () => {
  const r = await resolveCallerIdentity({ peerAddress: "100.64.1.5", headerLogin: null, selfLogin, whois: async () => "me@example.com" });
  expect(r.trust).toBe("sameUser");
});

test("direct bind: whois says a DIFFERENT user → rejected, even with a correct code", async () => {
  const r = await resolveCallerIdentity({ peerAddress: "100.64.1.5", headerLogin: null, selfLogin, whois: async () => "intruder@other.com" });
  expect(r.trust).toBe("otherUser");
});

test("direct bind: whois unresolvable → `unknown`, i.e. code-only (matches Pairing.swift's notOtherUser)", async () => {
  const r = await resolveCallerIdentity({ peerAddress: "100.64.1.5", headerLogin: null, selfLogin, whois: noWhois });
  expect(r.trust).toBe("unknown");
  expect(r.reject).toBeUndefined();
});

test("HJ-37: a FORGED header on a non-loopback peer is IGNORED — whois decides", async () => {
  // The v1.0 spec checked the header first. On a direct tailnet bind the header is caller-controlled,
  // so that would have let anyone claim to be the owner and defeat the identity check entirely.
  const asOwner = { headerLogin: "me@example.com" as string | null };

  // (a) whois says a different user → the forged header must NOT rescue it.
  const impostor = await resolveCallerIdentity({ peerAddress: "100.64.9.9", ...asOwner, selfLogin, whois: async () => "intruder@other.com" });
  expect(impostor.trust).toBe("otherUser");

  // (b) whois can't resolve → falls to code-only, NOT to trusted.
  const unresolved = await resolveCallerIdentity({ peerAddress: "100.64.9.9", ...asOwner, selfLogin, whois: noWhois });
  expect(unresolved.trust).toBe("unknown");
  expect(unresolved.trust).not.toBe("sameUser");
});

test("a caller that is neither loopback nor on the tailnet is rejected outright (§7 branch 3)", async () => {
  const r = await resolveCallerIdentity({ peerAddress: "192.168.1.20", headerLogin: "me@example.com", selfLogin, whois: async () => "me@example.com" });
  expect(r.trust).toBe("otherUser");
});

test("an unknown peer address is rejected (we can't tell who it is, so we don't guess)", async () => {
  const r = await resolveCallerIdentity({ peerAddress: undefined, headerLogin: "me@example.com", selfLogin, whois: noWhois });
  expect(r.trust).toBe("otherUser");
});

// ── HJ-26 the recorded hub ──────────────────────────────────────────────────────────────────────

test("PairedHubStore: records and reloads the joining hub across a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-pairhub-"));
  try {
    const a = new PairedHubStore(dir);
    expect(a.get()).toBeNull(); // unpaired ⇒ rotation has nothing to accept
    a.record(HUB, "Home fleet");
    expect(new PairedHubStore(dir).get()?.hubServerId).toBe(HUB);
    // Re-pairing to a different hub is allowed (HJ-14) — the joiner warns, then detaches.
    a.record(OTHER_HUB);
    expect(new PairedHubStore(dir).get()?.hubServerId).toBe(OTHER_HUB);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── HJ-32 the capability tag ────────────────────────────────────────────────────────────────────

test("speaksPairing: absent capabilities (a pre-capability daemon) means NO", () => {
  expect(speaksPairing(undefined)).toBe(false);
  expect(speaksPairing([])).toBe(false);
  expect(speaksPairing(["autopilot", "auth"])).toBe(false);
  expect(speaksPairing(["auth", "pairing"])).toBe(true);
});
