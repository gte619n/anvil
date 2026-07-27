# Multiple Claude Accounts — Implementation Plan

**Goal:** Replace Anvil's single `CLAUDE_CODE_OAUTH_TOKEN` slot with a roster of labelled Claude
accounts, choose one per session, switch a running session's account without losing the
conversation, and replicate the roster across the fleet.

**Architecture:** A new `AccountStore` over `<stateDir>/accounts.json` becomes the source of truth;
the default account is mirrored back into `~/.config/anvil/env` *through* the existing
`setClaudeToken()` so the §3 metered-key rejection and degrade-marker clearing still apply. Sessions
carry an `accountId`; `buildAgentEnv()` resolves it per spawn. Rebinding reuses the teardown already
proven by `restartIdleSessionsForNewToken()`. Replication adds one optional `accounts` field to the
existing `/api/fleet/pair` and `/api/fleet/token` payloads, inheriting their `sameUser` +
`hubServerId` gate and capability-routed transport — no new write endpoint.

**Tech Stack:** Bun + TypeScript (`anvild/`), `bun:test`, `@anthropic-ai/claude-agent-sdk`,
vanilla-TS web client (`anvild/web/`), the wire protocol at `anvild/protocol.ts`.

**Design source:** `docs/plans/2026-07-25-multi-account-tokens-design.md` (revision 2, approved
2026-07-26).

**Branch / worktree:** all work happens in `~/anvil/.claude/worktrees/multi-account-tokens` on
`design/multi-account-tokens`, branched from `origin/main` at `507b243`.

---

## Altitude note — read before executing

This plan follows the house convention from `anvil-team-support-plan.md`:

- **Complete, paste-able code** for new pure modules and their tests (Tasks 2–6, 16, 21, 26, 29, 30).
  These have no ambiguity and no giant host file to weave into.
- **Exact anchors, real signatures, and behaviour specs** for edits landing in
  `supervisor.ts` (3066 lines) and `web/src/main.ts` (6593 lines). Implement against the live file —
  line numbers drift as you commit, so anchor on the quoted symbol, not the number.

**Verify before every commit** (all four are CI gates):

```bash
cd ~/anvil/.claude/worktrees/multi-account-tokens/anvild
bunx tsc --noEmit && bun run typecheck:web && bun run build:web && bun test
```

**Two invariants no task may break:**

1. `setClaudeToken()` is the **only** way the default token reaches the env file. Never call
   `upsertEnvLine(CLAUDE_TOKEN_KEY, …)` directly — `setClaudeToken()` also calls
   `clearBoundDegradeMarker()`, and bypassing it strands a degraded daemon.
2. Raw tokens never reach a client. Every read path returns `{ id, label, masked }`.

---

## Status

| Task | Description | Status | Tested | Pushed |
|------|-------------|--------|--------|--------|
| 1 | **Spike:** cross-account `--resume` behaviour | done | n/a | no |
| 2 | `AccountStore` — file, CRUD, `rev` | done | yes | no |
| 3 | Validation & invariants (labels, metered key, last account, default) | done | yes | no |
| 4 | Default mirroring through `setClaudeToken()` | done | yes | no |
| 5 | Boot migration from the env token + wiring | done | yes | no |
| 6 | `subscriptionAuthOk` considers a non-empty roster | done | yes | no |
| 7 | Protocol: `auth.accounts.*` commands + `AuthAccountsEvent` | done | yes | no |
| 8 | Protocol: `Session` / `Environment` / `server.hello` / fleet REST | done | yes | no |
| 9 | `"accounts"` capability + `role` derivation in `server.hello` | done | yes | no |
| 10 | Contract: bump `PROTOCOL_VERSION`, regen golden | done | yes | no |
| 11 | Supervisor: roster command handlers + `auth.accounts` broadcast | done | yes | no |
| 12 | WS routing for `auth.accounts.*` | done | yes | no |
| 13 | Web: roster list in the Models tab | done | yes | no |
| 14 | Web: Add-account dialog | done | yes | no |
| 15 | Web: rename / replace / set-default / remove + in-use confirm | done | yes | no |
| 16 | `buildAgentEnv({ accountId })` resolution | done | yes | no |
| 17 | `agentEnv(s)` threading through the supervisor | done | yes | no |
| 18 | `accountId` on `session.create`, stamped on the record | done | yes | no |
| 19 | Web: account row in the new-session dialog | done | yes | no |
| 20 | Web: account chip on the session header | done | yes | no |
| 21 | Extract `restartDriverForNewToken()` + changed-token predicate | done | yes | no |
| 22 | `session.account.set` command + supervisor method | done | yes | no |
| 23 | Resume-failure → fresh context + persisted divider | done | yes | no |
| 24 | Removal fallback + `accountMissing` badge | done | yes | no |
| 25 | Web: header switch control | done | yes | no |
| 26 | `role` / `hubServerId` derivation + test | done | yes | no |
| 27 | Web: route roster writes by `serverId`; adopt-your-hub card | done | yes | no |
| 28 | Web: replace the "Updated 0/0 Macs" toast | done | yes | no |
| 29 | `accounts?` on pair/token payloads + `adoptCredentials()` branch | done | yes | no |
| 30 | `GET /api/fleet/accounts` | done | yes | no |
| 31 | Hub auto-push + per-member `rev` + capability tiering | done | yes | no |
| 32 | Web: Servers-tab sync state + "Sync now" | done | yes | no |
| 33 | `Environment.accountId` + dialog + autopilot resolution | done | yes | no |
| 34 | **User E2E acceptance — HARD PAUSE, the user drives a real daemon** | pending | no | no |
| 35 | Fix everything Task 34 surfaced | pending | no | no |
| 36 | Docs, final gates, PR | pending | no | no |

Tasks 1–25 are a complete, shippable single-server feature. 26–33 layer the fleet on top. 34–36 are
acceptance and ship.

> **Task 34 is a hard stop.** An agent executing this plan must not proceed past it on its own. Code
> gates (`tsc`, `typecheck:web`, `build:web`, `bun test`) cannot exercise a real second subscription,
> a real mid-session switch, or a real member Mac — only the user can.

---

# Phase 0 — Spike

### Task 1: Cross-account `--resume` spike

**Gates:** Task 23's copy, not its existence. Do this before Phase 5.

This cannot be automated — it needs two real Claude subscription tokens.

**Step 1: Set up**

```bash
cd ~/anvil/.claude/worktrees/multi-account-tokens/anvild
# Terminal A: token A in ~/.config/anvil/env, start the daemon, create a session, run 2-3 turns.
# Note the session's claudeSessionId from ~/.anvil/sessions.json.
```

**Step 2: Swap and resume**

```bash
# Stop the daemon. Replace CLAUDE_CODE_OAUTH_TOKEN with token B. Restart.
# Send another turn to the SAME session.
```

**Step 3: Record the outcome in this file**

| Outcome | Consequence for Task 23 |
|---|---|
| Resume succeeds, conversation intact | Divider is the rare error path; copy stays "couldn't carry the conversation across" |
| Resume fails with an auth/ownership error | Fresh context becomes the **normal** path; reword the divider to state plainly that switching accounts starts a new context, and say so in the switch control's tooltip |
| Resume succeeds but the model has no memory | Same as failure — treat as fresh context |

**Result (2026-07-26): Resume succeeds, conversation intact.**

Ran the spike against an isolated daemon instance (fresh `ANVIL_STATE_DIR`/`ANVIL_CLONES_DIR`,
port 7799 — not the real `~/.config/anvil/env` or `~/.anvil`) using two real subscription OAuth
tokens supplied by the user:

1. Booted with token A, created a session (`sess_678fef2b…`, `existing-dir`), sent two turns
   ("reply with exactly: pineapple", then "what word did you just say? also remember 42"). The
   model correctly recalled "pineapple" within the same boot. `claudeSessionId` recorded:
   `0b672287-eba9-48fb-af10-55209e0fe994`.
2. Stopped the daemon cleanly (`SIGTERM`), restarted the **same state dir** with token B (a
   different subscription account) — no `--resume`-affecting state was touched, only the token.
3. Sent a third turn to the same session: "What word and number did I ask you to remember
   earlier?" The SDK's `--resume` against token B succeeded with **no auth/ownership error**, the
   `claudeSessionId` was unchanged, and the model answered "The word was **pineapple** and the
   number was **42**" — full conversational memory carried across the account swap.

**Consequence for Task 23:** cross-account `--resume` is not refused by the CLI/SDK (at least for
these two accounts). The fresh-context fallback in Task 23 is genuinely the **rare error path**,
not the normal case — keep the divider copy as "couldn't carry the conversation across accounts",
implement the fallback defensively (some other pairing of accounts, an expired token, or a future
CLI change could still hit it), and do not reword Task 25's tooltip to warn that switching always
starts a new context.

**Step 4: Commit the finding**

```bash
git commit -m "docs: record cross-account resume spike result (task 1)"
```

---

# Phase 1 — Store foundations (server-only, no UI)

### Task 2: `AccountStore` — file, CRUD, `rev`

**Files:**
- Create: `anvild/src/auth/accounts.ts`
- Test: `anvild/test/unit/accounts.test.ts`

**Step 1: Write failing test**

```ts
// anvild/test/unit/accounts.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../../src/auth/accounts";

function tmpStore(): AccountStore {
  return new AccountStore(mkdtempSync(join(tmpdir(), "anvil-accounts-")));
}

test("starts empty at rev 0", () => {
  const s = tmpStore();
  expect(s.list()).toEqual([]);
  expect(s.snapshot().rev).toBe(0);
  expect(s.defaultId()).toBeUndefined();
});

test("add returns a stable acct_ id, marks the first account default, bumps rev", () => {
  const s = tmpStore();
  const a = s.add("work", "sk-ant-oat01-workworkwork-1111");
  expect(a.id).toMatch(/^acct_/);
  expect(a.label).toBe("work");
  expect(s.defaultId()).toBe(a.id);
  expect(s.snapshot().rev).toBe(1);

  const b = s.add("personal", "sk-ant-oat01-personalpers-2222");
  expect(s.defaultId()).toBe(a.id); // the second account does NOT steal default
  expect(s.snapshot().rev).toBe(2);
  expect(s.list().map((x) => x.label)).toEqual(["work", "personal"]);
});

test("token() resolves by id and falls back to the default", () => {
  const s = tmpStore();
  const a = s.add("work", "sk-ant-oat01-workworkwork-1111");
  const b = s.add("personal", "sk-ant-oat01-personalpers-2222");
  expect(s.token(b.id)).toBe("sk-ant-oat01-personalpers-2222");
  expect(s.token(undefined)).toBe("sk-ant-oat01-workworkwork-1111");
  expect(s.token("acct_nope")).toBeUndefined(); // absent is NOT a silent fallback — caller decides
  expect(s.has(a.id)).toBe(true);
  expect(s.has("acct_nope")).toBe(false);
});

test("rename and replace keep the id and bump rev", () => {
  const s = tmpStore();
  const a = s.add("work", "sk-ant-oat01-workworkwork-1111");
  s.rename(a.id, "day job");
  expect(s.list()[0]!.label).toBe("day job");
  expect(s.list()[0]!.id).toBe(a.id);
  s.replace(a.id, "sk-ant-oat01-rotatedtoken-3333");
  expect(s.token(a.id)).toBe("sk-ant-oat01-rotatedtoken-3333");
  expect(s.snapshot().rev).toBe(3);
});

test("setDefault moves the marker; remove drops the entry", () => {
  const s = tmpStore();
  const a = s.add("work", "sk-ant-oat01-workworkwork-1111");
  const b = s.add("personal", "sk-ant-oat01-personalpers-2222");
  s.setDefault(b.id);
  expect(s.defaultId()).toBe(b.id);
  s.remove(a.id);
  expect(s.list().map((x) => x.id)).toEqual([b.id]);
});

test("masked() never leaks the raw token", () => {
  const s = tmpStore();
  const a = s.add("work", "sk-ant-oat01-supersecretvalue-1111");
  const pub = s.publicList();
  expect(pub[0]!.masked).toContain("…");
  expect(JSON.stringify(pub)).not.toContain("supersecretvalue");
  expect(pub[0]).not.toHaveProperty("token");
  expect(pub[0]!.id).toBe(a.id);
});

test("persists to <stateDir>/accounts.json at 0600 and reloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-accounts-"));
  const s1 = new AccountStore(dir);
  const a = s1.add("work", "sk-ant-oat01-workworkwork-1111");
  const file = join(dir, "accounts.json");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(file, "utf8")).accounts[0].label).toBe("work");

  const s2 = new AccountStore(dir);
  expect(s2.defaultId()).toBe(a.id);
  expect(s2.token(a.id)).toBe("sk-ant-oat01-workworkwork-1111");
  expect(s2.snapshot().rev).toBe(1);
});

test("a corrupt file behaves as empty rather than throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-accounts-"));
  Bun.write(join(dir, "accounts.json"), "{ not json");
  const s = new AccountStore(dir);
  expect(s.list()).toEqual([]);
});

test("replicas refuse local mutation", () => {
  const s = tmpStore();
  s.adoptReplica({ rev: 7, defaultId: "acct_x", entries: [{ id: "acct_x", label: "work", token: "sk-ant-oat01-pushedtoken-9999", createdAt: 1 }] });
  expect(s.snapshot().role).toBe("replica");
  expect(s.snapshot().rev).toBe(7);
  expect(s.token("acct_x")).toBe("sk-ant-oat01-pushedtoken-9999");
  expect(() => s.add("local", "sk-ant-oat01-nope-0000")).toThrow(/replica/i);
});
```

**Step 2: Run test, verify failure**

Run: `cd anvild && bun test test/unit/accounts.test.ts`
Expected: FAIL — `Cannot find module '../../src/auth/accounts'`

**Step 3: Implement**

```ts
// anvild/src/auth/accounts.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { mask } from "./env-file";

/**
 * The daemon's roster of Claude subscription accounts (2026-07-25 multi-account design §3).
 *
 * Source of truth for WHICH tokens exist and which is the default. The default's token is separately
 * mirrored into `~/.config/anvil/env` by the caller via `setClaudeToken()` (§3.2) — this module is
 * deliberately ignorant of the env file so it can be unit-tested without touching $HOME.
 *
 * Hub vs replica: a hub owns a writable roster. A member that has received a push holds a
 * `role: "replica"` copy and refuses local mutation, so there is exactly one writer per fleet.
 * The hub's identity is NOT stored here — `PairedHubStore` (server/pairing.ts) already persists it.
 */

export interface ClaudeAccount {
  id: string;
  label: string;
  token: string;
  createdAt: number;
}

/** What a client is allowed to see: never the raw token. */
export interface PublicAccount {
  id: string;
  label: string;
  masked: string;
  createdAt: number;
}

export interface RosterSnapshot {
  rev: number;
  defaultId?: string;
  role: "hub" | "replica";
}

/** The wire shape pushed hub → member, carried on FleetPairRequest / FleetTokenRequest (§7.3). */
export interface RosterPayload {
  rev: number;
  defaultId: string;
  entries: ClaudeAccount[];
}

interface RosterFile {
  rev: number;
  defaultId?: string;
  role: "hub" | "replica";
  accounts: ClaudeAccount[];
}

export function newAccountId(): string {
  return `acct_${randomBytes(8).toString("hex")}`;
}

export class AccountStore {
  private readonly file: string;
  private data: RosterFile = { rev: 0, role: "hub", accounts: [] };

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, "accounts.json");
    this.load();
  }

  // ── reads ────────────────────────────────────────────────────────────────────
  list(): ClaudeAccount[] {
    return this.data.accounts.map((a) => ({ ...a }));
  }

  publicList(): PublicAccount[] {
    return this.data.accounts.map(({ id, label, token, createdAt }) => ({ id, label, masked: mask(token), createdAt }));
  }

  snapshot(): RosterSnapshot {
    return { rev: this.data.rev, ...(this.data.defaultId ? { defaultId: this.data.defaultId } : {}), role: this.data.role };
  }

  defaultId(): string | undefined {
    return this.data.defaultId;
  }

  isEmpty(): boolean {
    return this.data.accounts.length === 0;
  }

  has(id: string): boolean {
    return this.data.accounts.some((a) => a.id === id);
  }

  get(id: string): ClaudeAccount | undefined {
    const a = this.data.accounts.find((x) => x.id === id);
    return a ? { ...a } : undefined;
  }

  labelOf(id: string | undefined): string | undefined {
    return id ? this.data.accounts.find((a) => a.id === id)?.label : undefined;
  }

  /**
   * The token for `id`, or the default's when `id` is undefined. An id that is PRESENT but unknown
   * returns undefined rather than falling back — a silent swap to another subscription is precisely
   * what this feature exists to prevent (§5.4). The caller decides between fallback and refusal.
   */
  token(id: string | undefined): string | undefined {
    const target = id ?? this.data.defaultId;
    if (!target) return undefined;
    return this.data.accounts.find((a) => a.id === target)?.token;
  }

  /** The full roster in push shape. Returns undefined when there is nothing to replicate. */
  payload(): RosterPayload | undefined {
    if (!this.data.defaultId || this.data.accounts.length === 0) return undefined;
    return { rev: this.data.rev, defaultId: this.data.defaultId, entries: this.list() };
  }

  // ── writes (hub only) ────────────────────────────────────────────────────────
  add(label: string, token: string, id: string = newAccountId()): ClaudeAccount {
    this.assertWritable();
    const account: ClaudeAccount = { id, label, token, createdAt: Date.now() };
    this.data.accounts.push(account);
    this.data.defaultId ??= id; // the first account is the default; later ones never steal it
    this.bump();
    return { ...account };
  }

  rename(id: string, label: string): void {
    this.assertWritable();
    const a = this.require(id);
    a.label = label;
    this.bump();
  }

  replace(id: string, token: string): void {
    this.assertWritable();
    const a = this.require(id);
    a.token = token;
    this.bump();
  }

  setDefault(id: string): void {
    this.assertWritable();
    this.require(id);
    this.data.defaultId = id;
    this.bump();
  }

  remove(id: string): void {
    this.assertWritable();
    this.require(id);
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    if (this.data.defaultId === id) this.data.defaultId = this.data.accounts[0]?.id;
    this.bump();
  }

  /** Replace this roster with one pushed by the hub (§7.3). Flips the store to replica mode. */
  adoptReplica(payload: RosterPayload): void {
    this.data = { rev: payload.rev, defaultId: payload.defaultId, role: "replica", accounts: payload.entries.map((e) => ({ ...e })) };
    this.save();
  }

  // ── internals ────────────────────────────────────────────────────────────────
  private assertWritable(): void {
    if (this.data.role === "replica") {
      throw new Error("this machine holds a replica of its hub's account roster — change accounts on the hub");
    }
  }

  private require(id: string): ClaudeAccount {
    const a = this.data.accounts.find((x) => x.id === id);
    if (!a) throw new Error(`unknown account ${id}`);
    return a;
  }

  private bump(): void {
    this.data.rev += 1;
    this.save();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<RosterFile>;
      this.data = {
        rev: typeof raw.rev === "number" ? raw.rev : 0,
        ...(raw.defaultId ? { defaultId: raw.defaultId } : {}),
        role: raw.role === "replica" ? "replica" : "hub",
        accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
      };
    } catch {
      this.data = { rev: 0, role: "hub", accounts: [] }; // corrupt — behave as empty (FleetStore's rule)
    }
  }

  private save(): void {
    writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
  }
}
```

**Step 4: Run test, verify pass**

Run: `cd anvild && bun test test/unit/accounts.test.ts`
Expected: PASS (9 tests)

**Step 5: Commit**

```bash
git commit -m "feat(auth): AccountStore — labelled Claude account roster with a rev cursor"
```

---

### Task 3: Validation & invariants

**Files:**
- Modify: `anvild/src/auth/accounts.ts`
- Test: `anvild/test/unit/accounts.test.ts` (append)

**Step 1: Write failing test**

```ts
test("rejects a metered API key on add and on replace (§3)", () => {
  const s = tmpStore();
  expect(() => s.add("bad", "sk-ant-api03-leak")).toThrow(/metered/i);
  const a = s.add("work", "sk-ant-oat01-workworkwork-1111");
  expect(() => s.replace(a.id, "sk-ant-api03-leak")).toThrow(/metered/i);
  expect(s.token(a.id)).toBe("sk-ant-oat01-workworkwork-1111"); // unchanged
});

test("rejects empty and duplicate labels, case-insensitively", () => {
  const s = tmpStore();
  s.add("work", "sk-ant-oat01-workworkwork-1111");
  expect(() => s.add("  ", "sk-ant-oat01-aaaa-1111")).toThrow(/label/i);
  expect(() => s.add("WORK", "sk-ant-oat01-bbbb-2222")).toThrow(/already/i);
  const b = s.add("personal", "sk-ant-oat01-cccc-3333");
  expect(() => s.rename(b.id, "Work")).toThrow(/already/i);
  s.rename(b.id, "personal"); // renaming to its own label is a no-op, not a conflict
});

test("rejects a label over 32 chars and an empty token", () => {
  const s = tmpStore();
  expect(() => s.add("x".repeat(33), "sk-ant-oat01-dddd-4444")).toThrow(/32/);
  expect(() => s.add("ok", "   ")).toThrow(/token/i);
});

test("refuses to remove the last account", () => {
  const s = tmpStore();
  const a = s.add("work", "sk-ant-oat01-workworkwork-1111");
  expect(() => s.remove(a.id)).toThrow(/last account/i);
});

test("labels and tokens are trimmed", () => {
  const s = tmpStore();
  const a = s.add("  work  ", "  sk-ant-oat01-workworkwork-1111  ");
  expect(a.label).toBe("work");
  expect(s.token(a.id)).toBe("sk-ant-oat01-workworkwork-1111");
});
```

**Step 2: Run test, verify failure**

Run: `cd anvild && bun test test/unit/accounts.test.ts`
Expected: FAIL — `expect(received).toThrow()` on the metered-key case

**Step 3: Implement**

Add the import and helpers to `accounts.ts`:

```ts
import { looksLikeMeteredKey, mask } from "./env-file";

export const MAX_LABEL_LENGTH = 32;

function cleanToken(token: string): string {
  const t = token.trim();
  if (!t) throw new Error("a Claude OAuth token is required");
  if (looksLikeMeteredKey(t)) {
    throw new Error(
      "that looks like a metered ANTHROPIC_API_KEY, not a subscription OAuth token — run `claude setup-token` and paste that token instead (arch §3)",
    );
  }
  return t;
}
```

Add these two private methods to the class:

```ts
  private cleanLabel(label: string, exceptId?: string): string {
    const l = label.trim();
    if (!l) throw new Error("a label is required");
    if (l.length > MAX_LABEL_LENGTH) throw new Error(`labels are limited to ${MAX_LABEL_LENGTH} characters`);
    const clash = this.data.accounts.find((a) => a.id !== exceptId && a.label.toLowerCase() === l.toLowerCase());
    if (clash) throw new Error(`an account called "${clash.label}" already exists`);
    return l;
  }
```

Then thread them through the three mutators (replacing the bodies from Task 2):

```ts
  add(label: string, token: string, id: string = newAccountId()): ClaudeAccount {
    this.assertWritable();
    const clean = { label: this.cleanLabel(label), token: cleanToken(token) };
    const account: ClaudeAccount = { id, ...clean, createdAt: Date.now() };
    this.data.accounts.push(account);
    this.data.defaultId ??= id;
    this.bump();
    return { ...account };
  }

  rename(id: string, label: string): void {
    this.assertWritable();
    const a = this.require(id);
    a.label = this.cleanLabel(label, id);
    this.bump();
  }

  replace(id: string, token: string): void {
    this.assertWritable();
    const a = this.require(id);
    a.token = cleanToken(token);
    this.bump();
  }
```

And guard `remove()`:

```ts
  remove(id: string): void {
    this.assertWritable();
    this.require(id);
    if (this.data.accounts.length === 1) {
      throw new Error("this is the last account — add another before removing it");
    }
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    if (this.data.defaultId === id) this.data.defaultId = this.data.accounts[0]?.id;
    this.bump();
  }
```

**Step 4: Run test, verify pass**

Run: `cd anvild && bun test test/unit/accounts.test.ts`
Expected: PASS (14 tests)

**Step 5: Commit**

```bash
git commit -m "feat(auth): roster validation — metered keys, label rules, last-account guard"
```

---

### Task 4: Default mirroring through `setClaudeToken()`

**Files:**
- Create: `anvild/src/auth/account-mirror.ts`
- Test: `anvild/test/unit/accounts-mirror.test.ts`

Mirroring lives in its own module, not in `AccountStore`, so the store stays `$HOME`-free and
unit-testable. This module is the **only** place the two are joined.

**Step 1: Write failing test**

```ts
// anvild/test/unit/accounts-mirror.test.ts
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../../src/auth/accounts";
import { mirrorDefault } from "../../src/auth/account-mirror";
import { CLAUDE_TOKEN_KEY } from "../../src/auth/store";

const ORIGINAL = process.env[CLAUDE_TOKEN_KEY];
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[CLAUDE_TOKEN_KEY];
  else process.env[CLAUDE_TOKEN_KEY] = ORIGINAL;
});

function tmp(): { store: AccountStore; envFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "anvil-mirror-"));
  return { store: new AccountStore(dir), envFile: join(dir, "env") };
}

test("mirrors the default account's token into the env file and process.env", () => {
  const { store, envFile } = tmp();
  store.add("work", "sk-ant-oat01-workworkwork-1111");
  mirrorDefault(store, envFile);
  expect(readFileSync(envFile, "utf8")).toContain("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-workworkwork-1111");
  expect(process.env[CLAUDE_TOKEN_KEY]).toBe("sk-ant-oat01-workworkwork-1111");
});

test("follows the default when it moves", () => {
  const { store, envFile } = tmp();
  store.add("work", "sk-ant-oat01-workworkwork-1111");
  const b = store.add("personal", "sk-ant-oat01-personalpers-2222");
  mirrorDefault(store, envFile);
  store.setDefault(b.id);
  mirrorDefault(store, envFile);
  expect(process.env[CLAUDE_TOKEN_KEY]).toBe("sk-ant-oat01-personalpers-2222");
  expect(readFileSync(envFile, "utf8")).not.toContain("workworkwork");
});

test("an empty roster clears the mirrored token rather than leaving a stale one", () => {
  const { store, envFile } = tmp();
  store.add("work", "sk-ant-oat01-workworkwork-1111");
  mirrorDefault(store, envFile);
  store.adoptReplica({ rev: 1, defaultId: "", entries: [] });
  mirrorDefault(store, envFile);
  expect(process.env[CLAUDE_TOKEN_KEY]).toBeUndefined();
});

test("an unwritable env file is reported, not thrown", () => {
  const { store } = tmp();
  store.add("work", "sk-ant-oat01-workworkwork-1111");
  const result = mirrorDefault(store, "/proc/definitely/not/writable/env");
  expect(result.persisted).toBe(false);
  expect(result.error).toBeTruthy();
  expect(process.env[CLAUDE_TOKEN_KEY]).toBe("sk-ant-oat01-workworkwork-1111"); // live value still applied
});
```

**Step 2: Run test, verify failure**

Run: `cd anvild && bun test test/unit/accounts-mirror.test.ts`
Expected: FAIL — `Cannot find module '../../src/auth/account-mirror'`

**Step 3: Implement**

```ts
// anvild/src/auth/account-mirror.ts
import type { AccountStore } from "./accounts";
import { authEnvFile, clearClaudeToken, setClaudeToken } from "./store";

/**
 * Mirror the roster's default account into `~/.config/anvil/env` (multi-account design §3.2).
 *
 * ALWAYS routes through `setClaudeToken()` rather than writing the env line directly. That function
 * is what rejects a metered key (§3), writes `process.env` and the file together, and — crucially —
 * calls `clearBoundDegradeMarker()`. A direct `upsertEnvLine()` here would leave an auto-degraded
 * daemon degraded after the user had visibly fixed the credential (auth/degrade.ts).
 *
 * Never throws: a roster mutation must still succeed on a box whose env file is read-only. The caller
 * surfaces `persisted: false` as "won't survive a restart", matching the existing `persistWarn` card.
 */
export interface MirrorResult {
  persisted: boolean;
  error?: string;
}

export function mirrorDefault(store: AccountStore, file: string = authEnvFile()): MirrorResult {
  const token = store.token(undefined);
  try {
    if (!token) {
      clearClaudeToken(file);
      return { persisted: true };
    }
    setClaudeToken(token, file);
    return { persisted: true };
  } catch (e) {
    return { persisted: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

**Step 4: Run test, verify pass**

Run: `cd anvild && bun test test/unit/accounts-mirror.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git commit -m "feat(auth): mirror the default account into the launcher env via setClaudeToken"
```

---

### Task 5: Boot migration + wiring

**Files:**
- Modify: `anvild/src/auth/account-mirror.ts` (add `seedFromEnv`)
- Modify: `anvild/src/main.ts` (after `loadConfig()`, before `assertSubscriptionAuth()`)
- Modify: `anvild/src/server/http.ts` (construct the store beside `PairedHubStore`)
- Test: `anvild/test/unit/accounts-migration.test.ts`

**Step 1: Write failing test**

```ts
// anvild/test/unit/accounts-migration.test.ts
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../../src/auth/accounts";
import { seedFromEnv } from "../../src/auth/account-mirror";
import { CLAUDE_TOKEN_KEY } from "../../src/auth/store";

const ORIGINAL = process.env[CLAUDE_TOKEN_KEY];
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[CLAUDE_TOKEN_KEY];
  else process.env[CLAUDE_TOKEN_KEY] = ORIGINAL;
});

const dir = (): string => mkdtempSync(join(tmpdir(), "anvil-seed-"));

test("seeds an existing env token as the 'default' account", () => {
  const s = new AccountStore(dir());
  expect(seedFromEnv(s, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-existingtoken-1111" })).toBe(true);
  expect(s.list()).toHaveLength(1);
  expect(s.list()[0]!.label).toBe("default");
  expect(s.token(undefined)).toBe("sk-ant-oat01-existingtoken-1111");
});

test("is idempotent — a populated roster is never re-seeded", () => {
  const d = dir();
  const s1 = new AccountStore(d);
  seedFromEnv(s1, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-existingtoken-1111" });
  const s2 = new AccountStore(d);
  expect(seedFromEnv(s2, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-differentone-2222" })).toBe(false);
  expect(s2.list()).toHaveLength(1);
  expect(s2.token(undefined)).toBe("sk-ant-oat01-existingtoken-1111");
});

test("no env token → nothing seeded, no throw (a fresh headless box)", () => {
  const s = new AccountStore(dir());
  expect(seedFromEnv(s, {})).toBe(false);
  expect(s.list()).toEqual([]);
});

test("never seeds a metered key", () => {
  const s = new AccountStore(dir());
  expect(seedFromEnv(s, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-api03-leak" })).toBe(false);
  expect(s.list()).toEqual([]);
});

test("never seeds into a replica", () => {
  const s = new AccountStore(dir());
  s.adoptReplica({ rev: 3, defaultId: "acct_x", entries: [{ id: "acct_x", label: "work", token: "sk-ant-oat01-pushed-9999", createdAt: 1 }] });
  expect(seedFromEnv(s, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-local-1111" })).toBe(false);
  expect(s.list()).toHaveLength(1);
});
```

**Step 2: Run test, verify failure**

Run: `cd anvild && bun test test/unit/accounts-migration.test.ts`
Expected: FAIL — `seedFromEnv is not a function`

**Step 3: Implement**

Append to `anvild/src/auth/account-mirror.ts`:

```ts
import { AccountStore } from "./accounts";
import { looksLikeMeteredKey } from "./env-file";

/**
 * One-way boot migration (§3.3): an install that predates the roster has its token only in
 * `~/.config/anvil/env`. Seed it as the `default` account so the upgrade is zero-touch.
 *
 * Idempotent — returns false and does nothing once the roster is non-empty, so it is safe to call on
 * every boot. Never seeds a metered key (the §3 guard would refuse that token anyway) and never
 * writes into a replica, whose contents belong to its hub.
 */
export function seedFromEnv(store: AccountStore, env: Record<string, string | undefined> = process.env): boolean {
  if (!store.isEmpty() || store.snapshot().role === "replica") return false;
  const tok = (env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim();
  if (!tok || looksLikeMeteredKey(tok)) return false;
  store.add("default", tok);
  return true;
}
```

Modify `anvild/src/main.ts` — insert after the `applyDegradeMarkerAtBoot` block (anchor on
`assertSubscriptionAuth();`, immediately **before** it):

```ts
// Multi-account (§3.3): an install predating the roster keeps its token only in the launcher env
// file. Seed it as the "default" account so upgrading is zero-touch. Idempotent — a populated roster
// is never re-seeded, and a replica is never written to.
const accounts = new AccountStore(config.stateDir);
if (seedFromEnv(accounts)) console.log("[anvild] migrated the existing Claude token into the account roster as \"default\"");
```

with imports:

```ts
import { AccountStore } from "./auth/accounts";
import { seedFromEnv } from "./auth/account-mirror";
```

Pass it into `createServer({ … })` alongside the existing options, and in
`anvild/src/server/http.ts` accept it on the options interface (beside `stateDir` at `:150`) rather
than constructing a second instance — two `AccountStore`s over one file would each hold stale state:

```ts
  /** The Claude account roster (multi-account §3). Constructed in main.ts so the boot migration runs
   *  before the §3 guard; passed in so there is exactly one instance per process. */
  accounts: AccountStore;
```

**Step 4: Run test, verify pass**

Run: `cd anvild && bun test test/unit/accounts-migration.test.ts && bunx tsc --noEmit`
Expected: PASS (5 tests), no type errors

**Step 5: Commit**

```bash
git commit -m "feat(auth): seed the account roster from an existing env token at boot"
```

---

### Task 6: `subscriptionAuthOk` considers a non-empty roster

**Files:**
- Modify: `anvild/src/server/http.ts` (the `/api/health` `checkAuth()` call site)
- Test: `anvild/test/unit/auth.test.ts` (append)

Per design §4.2 this is a **no-op in every reachable state** — the mirroring rule guarantees a
non-empty roster always has a mirrored env line. It exists so a hand-edited or unwritable env file
doesn't make a good roster look unauthenticated. Keep it out of `guard.ts` itself: the guard is a
pure env check with no store dependency, and it must stay importable from `degrade.ts` without a
cycle.

**Step 1: Write failing test**

```ts
test("health reports authed when the roster has an account but the env line was lost", () => {
  const store = new AccountStore(mkdtempSync(join(tmpdir(), "anvil-guard-")));
  store.add("work", "sk-ant-oat01-workworkwork-1111");
  const status = resolveAuthStatus({ env: {}, accounts: store });
  expect(status.subscriptionAuthOk).toBe(true);
  expect(status.fatal).toBe(false);
});

test("a metered key is still fatal regardless of the roster", () => {
  const store = new AccountStore(mkdtempSync(join(tmpdir(), "anvil-guard-")));
  store.add("work", "sk-ant-oat01-workworkwork-1111");
  const status = resolveAuthStatus({ env: { ANTHROPIC_API_KEY: "sk-ant-api03-x" }, accounts: store });
  expect(status.fatal).toBe(true);
});

test("an empty roster and no env token is still non-fatal (degraded boot, HJ §4.1)", () => {
  const store = new AccountStore(mkdtempSync(join(tmpdir(), "anvil-guard-")));
  const status = resolveAuthStatus({ env: {}, accounts: store });
  expect(status.subscriptionAuthOk).toBe(false);
  expect(status.fatal).toBe(false);
});
```

**Step 2: Run test, verify failure**

Run: `cd anvild && bun test test/unit/auth.test.ts`
Expected: FAIL — `resolveAuthStatus is not exported`

**Step 3: Implement**

Add to `anvild/src/auth/accounts.ts` (it may import the guard; the guard must not import it):

```ts
import { checkAuth, type GuardStatus } from "./guard";

/**
 * `checkAuth()` widened by the roster (multi-account §4.2). A fatal §3 violation always wins. A
 * non-empty roster satisfies the positive condition even when the mirrored env line is missing, so a
 * read-only or hand-edited env file can't make a perfectly good roster look unauthenticated.
 */
export function resolveAuthStatus(opts: { env?: Record<string, string | undefined>; accounts: AccountStore }): GuardStatus {
  const base = checkAuth(opts.env ?? process.env);
  if (base.fatal || base.subscriptionAuthOk) return base;
  if (!opts.accounts.isEmpty()) return { subscriptionAuthOk: true, fatal: false };
  return base;
}
```

Then at the `/api/health` handler in `http.ts` (anchor: `const auth = checkAuth();`), swap to
`const auth = resolveAuthStatus({ accounts: opts.accounts });`.

**Step 4: Run test, verify pass**

Run: `cd anvild && bun test test/unit/auth.test.ts && bunx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git commit -m "feat(auth): health reports authed from the roster, not only the env line"
```

---

# Phase 2 — Protocol

### Task 7: `auth.accounts.*` commands + `AuthAccountsEvent`

**Files:**
- Modify: `docs/plans/anvil-protocol.ts` (the auth block, near the existing `auth.status` /
  `auth.set` / `auth.clear` definitions)

**Step 1: Implement** (protocol is types-only; the contract test in Task 10 is its test)

Add beside the existing auth commands, keeping `auth.status` / `auth.set` / `auth.clear` **intact** —
they now operate on the default account so an old client keeps working:

```ts
// ── Claude account roster (Settings → Models). Hub-authoritative; members hold replicas (§7). ──
export interface AuthAccountsGetCmd extends Envelope, Correlated { type: "auth.accounts.get" }
export interface AuthAccountAddCmd extends Envelope, Correlated { type: "auth.account.add"; label: string; token: string }
export interface AuthAccountRenameCmd extends Envelope, Correlated { type: "auth.account.rename"; accountId: string; label: string }
export interface AuthAccountReplaceCmd extends Envelope, Correlated { type: "auth.account.replace"; accountId: string; token: string }
export interface AuthAccountRemoveCmd extends Envelope, Correlated { type: "auth.account.remove"; accountId: string }
export interface AuthAccountDefaultCmd extends Envelope, Correlated { type: "auth.account.default"; accountId: string }

/** A roster entry as clients see it — masked preview only, NEVER the raw token (§11). */
export interface AccountInfo {
  id: string;
  label: string;
  masked: string;
  createdAt: number;
}

/** Broadcast on every roster mutation, like `auth.status`. */
export interface AuthAccountsEvent extends Envelope {
  type: "auth.accounts";
  rev: number;
  defaultId?: string;
  role: "hub" | "replica";
  /** Set on a replica: the hub that owns this roster, from PairedHubStore (§7.2). */
  hubServerId?: string;
  accounts: AccountInfo[];
  /** False when the default couldn't be written to the launcher env file — "won't survive a restart". */
  persisted: boolean;
  /** Active sessions bound to each account, so the removal confirm can name them without a
   *  second round trip (§9.1). Keyed by accountId; absent keys mean "none". */
  inUse?: Record<string, { sessionId: SessionId; title: string }[]>;
}
```

Add all six commands to the client-command union and `AuthAccountsEvent` to `ServerEvent`.

**Step 2: Verify**

Run: `cd anvild && bunx tsc --noEmit`
Expected: no errors (the contract golden fails until Task 10 — expected)

**Step 3: Commit**

```bash
git commit -m "feat(protocol): auth.accounts.* commands and the auth.accounts event"
```

---

### Task 8: `Session` / `Environment` / `server.hello` / fleet REST additions

**Files:**
- Modify: `docs/plans/anvil-protocol.ts`

**Step 1: Implement**

On `Session`:

```ts
  /** The Claude account this session's agent spawns under (multi-account §5). Absent = the default. */
  accountId?: string;
  /** Denormalised for display; refreshed on rename and on load. */
  accountLabel?: string;
  /** The bound account no longer resolves; the session fell back to the default (§5.4). */
  accountMissing?: boolean;
```

On `SessionCreateCmd`:

```ts
  accountId?: string; // defaults to the environment's account, else the roster default
```

On `Environment`:

```ts
  /** Default account for new sessions here and for scheduled autopilot runs (§6). */
  accountId?: string;
```

On `ServerHelloEvent`:

```ts
  /** Fleet position (§7.2). `member` wins when a daemon is both paired and holds members — the
   *  question the client is asking is "should I send roster writes here?". */
  role: "hub" | "member" | "standalone";
  /** Present when role === "member": the hub that owns this machine's roster (PairedHubStore). */
  hubServerId?: string;
```

New session command:

```ts
export interface SessionAccountSetCmd extends Envelope, Correlated {
  type: "session.account.set";
  sessionId: SessionId;
  accountId: string;
}
```

In the `rest` namespace:

```ts
  /** Optional roster carried on a credential push (§7.3). Absent from an older hub → today's
   *  behaviour exactly; ignored by an older joiner. */
  export interface RosterPush {
    rev: number;
    defaultId: string;
    entries: { id: string; label: string; token: string; createdAt: number }[];
  }
  /** GET /api/fleet/accounts — read-only, masked previews only. */
  export interface FleetAccountsResponse {
    rev: number;
    defaultId?: string;
    role: "hub" | "replica";
    hubServerId?: string;
    accounts: { id: string; label: string; masked: string; createdAt: number }[];
  }
```

Add `accounts?: RosterPush` to **both** `FleetPairRequest` and `FleetTokenRequest`, and
`accountsRev?: number` to `FleetMember`.

**Step 2: Verify**

Run: `cd anvild && bunx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git commit -m "feat(protocol): accountId on sessions/environments, role on server.hello, roster push"
```

---

### Task 9: `"accounts"` capability + `role` derivation

**Files:**
- Modify: `anvild/src/server/identity.ts`
- Modify: `anvild/src/server/http.ts` (pass `role` / `hubServerId` into `serverHelloEvent`)
- Test: `anvild/src/server/identity.test.ts`

**Step 1: Write failing test**

```ts
test("advertises the accounts capability", () => {
  expect(SERVER_CAPABILITIES).toContain("accounts");
});

test("role is standalone with no hub and no members", () => {
  const hello = serverHelloEvent(id, { pairedHubId: null, memberCount: 0 });
  expect(hello.role).toBe("standalone");
  expect(hello.hubServerId).toBeUndefined();
});

test("role is hub when it has members and no paired hub", () => {
  expect(serverHelloEvent(id, { pairedHubId: null, memberCount: 2 }).role).toBe("hub");
});

test("role is member when paired — even if it also holds members", () => {
  const hello = serverHelloEvent(id, { pairedHubId: "srv_hub", memberCount: 3 });
  expect(hello.role).toBe("member");
  expect(hello.hubServerId).toBe("srv_hub");
});
```

**Step 2: Run test, verify failure**

Run: `cd anvild && bun test src/server/identity.test.ts`
Expected: FAIL — `serverHelloEvent` takes one argument

**Step 3: Implement**

In `identity.ts`, add `"accounts"` to `SERVER_CAPABILITIES` and widen `serverHelloEvent`:

```ts
export interface FleetPosition {
  /** `PairedHubStore.get()?.hubServerId ?? null`. */
  pairedHubId: string | null;
  /** `fleet.list().length`. */
  memberCount: number;
}

export function serverHelloEvent(id: ServerIdentity, pos: FleetPosition = { pairedHubId: null, memberCount: 0 }): ServerHelloEvent {
  // `member` wins over `hub`: the client uses this to decide where roster WRITES go, and a paired
  // machine is never the writer even if it has members of its own (§7.2).
  const role = pos.pairedHubId ? "member" : pos.memberCount > 0 ? "hub" : "standalone";
  return {
    …existing fields…,
    role,
    ...(pos.pairedHubId ? { hubServerId: pos.pairedHubId } : {}),
  };
}
```

At the `serverHelloEvent(identity)` call site in `http.ts`, pass
`{ pairedHubId: pairedHub.get()?.hubServerId ?? null, memberCount: fleet.list().length }`.

**Step 4: Run test, verify pass**

Run: `cd anvild && bun test src/server/identity.test.ts && bunx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git commit -m "feat(fleet): server.hello carries role + hubServerId; advertise the accounts capability"
```

---

### Task 10: Contract — bump `PROTOCOL_VERSION`, regen golden

**Files:**
- Modify: `docs/plans/anvil-protocol.ts` (`PROTOCOL_VERSION`)
- Modify: `anvild/test/contract/protocol-surface.golden.json`

**Step 1: Confirm the contract test is red**

Run: `cd anvild && bun test test/contract/`
Expected: FAIL — the surface no longer matches the golden

**Step 2: Bump and regenerate**

Bump `PROTOCOL_VERSION` (minor: additive), then:

```bash
cd anvild && bun run test/contract/regen-golden.ts
```

**Step 3: Verify**

Run: `cd anvild && bun test test/contract/ && bunx tsc --noEmit && bun run typecheck:web`
Expected: PASS

**Step 4: Commit**

```bash
git commit -m "chore(protocol): bump PROTOCOL_VERSION and regenerate the contract golden"
```

---

# Phase 3 — Hub-side CRUD + Models UI

### Task 11: Supervisor roster handlers + broadcast

**Files:**
- Modify: `anvild/src/session/supervisor.ts`

**Anchors:** the existing auth handling — `broadcastAuthState()` and the `authDegrade` field.
Construct nothing new; the `AccountStore` arrives via the supervisor's options (Task 5).

**Signatures to add:**

```ts
  /** Roster snapshot for clients — masked previews only (§11). */
  accountsEvent(): AuthAccountsEvent;

  /** Every mutator: apply → mirror the default → broadcast. Throws are surfaced to the caller's cid. */
  accountAdd(label: string, token: string): AuthAccountsEvent;
  accountRename(accountId: string, label: string): AuthAccountsEvent;
  accountReplace(accountId: string, token: string): AuthAccountsEvent;
  accountRemove(accountId: string): AuthAccountsEvent;
  accountSetDefault(accountId: string): AuthAccountsEvent;

  /** Active (non-terminal) sessions bound to an account — drives the removal confirm (§10). */
  sessionsUsingAccount(accountId: string): { sessionId: string; title: string }[];
```

**Behaviour spec:**

1. Every mutator calls the store, then `mirrorDefault(this.accounts)`, then broadcasts
   `auth.accounts` to all clients, then returns the same event to the caller's `cid`.
2. `persisted` on the event is `mirrorDefault()`'s result — `false` renders the existing
   "won't survive a restart" warning.
3. `accountRemove` additionally: for each session in `sessionsUsingAccount(id)`, clear `accountId`,
   set `accountMissing: true`, set `accountLabel` to the new default's label, `persist()` and
   `broadcastUpdated()`. This is Task 24's fallback; wire the call here and implement it there.
4. `accountRename` refreshes `accountLabel` on every session bound to that id.
5. A mutation on a replica throws `AccountStore`'s "change accounts on the hub" message unchanged.
6. After any mutation that changes the **default's token**, call the Task 21 restart predicate.

**Verify:** `bunx tsc --noEmit && bun test`

**Commit:** `feat(auth): supervisor roster mutators with mirroring and broadcast`

---

### Task 12: WS routing for `auth.accounts.*`

**Files:**
- Modify: `anvild/src/server/http.ts` (the WS command switch, beside `auth.set` / `auth.clear`)

**Behaviour spec:** six cases mapping 1:1 to the Task 11 methods. Each wraps in try/catch and replies
on the `cid` with the existing error-envelope shape used by `auth.set`. `auth.accounts.get` replies
with `accountsEvent()` and broadcasts nothing.

Send `auth.accounts` alongside `auth.status` in the initial frame burst so a connecting client has the
roster before it renders anything.

**Verify:** `bunx tsc --noEmit && bun test`

**Commit:** `feat(server): route auth.accounts.* commands`

---

### Task 13: Web — roster list in the Models tab

**Files:**
- Modify: `anvild/web/src/main.ts`

**Anchors:** `renderModelsPanel()` (search the symbol), and the `serverSupports(hub(), "auth")`
capability gate at its head. Add module state `let claudeAccounts: AuthAccountsEvent | undefined;`
beside the existing `claudeAuth` / `openRouterAuth`, and an `onAuthAccounts()` handler beside
`onLapoStatus`'s pattern.

**Behaviour spec:** replace the single Claude card's body with the roster list from design §9.1 when
`serverSupports(srv, "accounts")`; otherwise render today's single-token card unchanged. Each row:
radio-style default marker, label, `masked` in a `<code>`, and a `⋯` menu. Below the list, the
"Managed on **mac-mini** (the hub). Changes sync to every Mac." note when `role === "replica"`.

The OpenRouter card and `pipelineMetricsCard()` below are untouched.

**Verify:** `bun run typecheck:web && bun run build:web`

**Commit:** `feat(web): render the Claude account roster in Settings → Models`

---

### Task 14: Web — Add-account dialog

**Files:**
- Modify: `anvild/web/src/main.ts`

**Anchors:** model it on `showAddMac()` — a `div.modal` with a `.modal-box`, `showModal()`,
`closeModal()`, and an inline status line rather than a toast.

**Behaviour spec:** the design §9.1 dialog — Label input, the host-specific
`claude setup-token` line with a copy button (host = the hub's `serverName`), password-type Token
input, Cancel/Add. Add sends `auth.account.add` via `sendAwait(…, 20_000)` and renders a server-side
error inline (duplicate label, metered key) without closing.

**Verify:** `bun run typecheck:web && bun run build:web`

**Commit:** `feat(web): add-account dialog with a copyable setup-token command`

---

### Task 15: Web — rename / replace / set-default / remove

**Files:**
- Modify: `anvild/web/src/main.ts`

**Behaviour spec:** the `⋯` menu's four actions. Rename and Replace reuse the Task 14 dialog with one
field. Set default sends `auth.account.default`. Remove reads the
`inUse[accountId]` map already carried on the `auth.accounts` event (Task 7) — no extra round trip —
and renders the design §9.1 confirm listing those sessions before sending `auth.account.remove`.

**Verify:** `bun run typecheck:web && bun run build:web`

**Commit:** `feat(web): rename, replace, set-default and remove accounts`

---

# Phase 4 — Session binding

### Task 16: `buildAgentEnv({ accountId })`

**Files:**
- Modify: `anvild/src/agent/env.ts`
- Test: `anvild/test/unit/agent-env.test.ts` (append)

**Step 1: Write failing test**

```ts
test("resolves the token for an explicit accountId", () => {
  const store = new AccountStore(mkdtempSync(join(tmpdir(), "anvil-env-")));
  const a = store.add("work", "sk-ant-oat01-workworkwork-1111");
  const b = store.add("personal", "sk-ant-oat01-personalpers-2222");
  expect(buildAgentEnv({ accounts: store, accountId: b.id }).CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-personalpers-2222");
  expect(buildAgentEnv({ accounts: store, accountId: a.id }).CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-workworkwork-1111");
});

test("no accountId resolves the default", () => {
  const store = new AccountStore(mkdtempSync(join(tmpdir(), "anvil-env-")));
  store.add("work", "sk-ant-oat01-workworkwork-1111");
  expect(buildAgentEnv({ accounts: store }).CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-workworkwork-1111");
});

test("an unknown accountId throws rather than silently using another subscription", () => {
  const store = new AccountStore(mkdtempSync(join(tmpdir(), "anvil-env-")));
  store.add("work", "sk-ant-oat01-workworkwork-1111");
  expect(() => buildAgentEnv({ accounts: store, accountId: "acct_gone" })).toThrow(/acct_gone/);
});

test("no store at all falls back to the env var (dev run, pre-migration)", () => {
  expect(buildAgentEnv({ src: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-fromenv-1111" } }).CLAUDE_CODE_OAUTH_TOKEN)
    .toBe("sk-ant-oat01-fromenv-1111");
});

test("the glm profile still carries no Claude token even with a roster", () => {
  const store = new AccountStore(mkdtempSync(join(tmpdir(), "anvil-env-")));
  store.add("work", "sk-ant-oat01-workworkwork-1111");
  const env = buildAgentEnv({ accounts: store, profile: "glm", src: { OPENROUTER_API_KEY: "sk-or-x" } });
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-or-x");
});

test("requireToken:false still yields a shell env on a tokenless box", () => {
  const store = new AccountStore(mkdtempSync(join(tmpdir(), "anvil-env-")));
  expect(() => buildAgentEnv({ accounts: store, requireToken: false })).not.toThrow();
});
```

**Step 2: Run test, verify failure**

Run: `cd anvild && bun test test/unit/agent-env.test.ts`
Expected: FAIL — `accounts` is not a known option

**Step 3: Implement**

Add `accounts?: AccountStore; accountId?: string;` to the options, and replace the `else` branch:

```ts
  } else {
    // Roster-aware resolution (§4.1). An accountId that is PRESENT but unknown throws — falling back
    // would silently bill another subscription, the exact failure this feature exists to prevent.
    let tok: string;
    if (opts.accounts) {
      if (opts.accountId && !opts.accounts.has(opts.accountId)) {
        throw new Error(`unknown Claude account ${opts.accountId} — it may have been removed; pick another in Settings → Models`);
      }
      tok = (opts.accounts.token(opts.accountId) ?? "").trim();
    } else {
      tok = (src.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim();
    }
    if (!tok && opts.requireToken !== false) throw new Error(NO_CLAUDE_TOKEN_ERROR);
    if (tok) out.CLAUDE_CODE_OAUTH_TOKEN = tok;
  }
```

**Step 4: Run test, verify pass**

Run: `cd anvild && bun test test/unit/agent-env.test.ts && bunx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git commit -m "feat(agent): resolve the spawn token from the account roster"
```

---

### Task 17: `agentEnv(s)` threading

**Files:**
- Modify: `anvild/src/session/supervisor.ts`
- Modify: `anvild/src/agent/query.ts`
- Modify: `anvild/src/integrations/autopilot.ts`

**Anchor:** `private agentEnv(): Record<string, string>` (search the symbol).

```ts
  private agentEnv(s?: SessionHandle, opts: { requireToken?: boolean } = {}): Record<string, string> {
    return buildAgentEnv({ accounts: this.accounts, ...(s?.data.accountId ? { accountId: s.data.accountId } : {}), ...opts });
  }
```

Call-site changes, all mechanical:

| Anchor | Change |
|---|---|
| `new AgentDriver(s, …, this.agentEnv(), …)` | `this.agentEnv(s)` |
| `TerminalManager` factory `() => this.agentEnv()` | `(sessionId) => this.agentEnv(this.sessions.get(sessionId), { requireToken: false })` — note the manager's existing callback already receives the id |
| `pickIcon(…, this.agentEnv())` / `classifyBranchKind(…, this.agentEnv())` | leave as `this.agentEnv()` — default account, short utility spawns |
| `query.ts` `env: buildAgentEnv({ profile: opts.model.profile })` | thread an optional `accounts` + `accountId` through `QueryOpts` |
| `autopilot.ts` `env: buildAgentEnv()` | Task 33 |

**Verify:** `bunx tsc --noEmit && bun test`

**Commit:** `refactor(session): resolve each spawn's token from its session's account`

---

### Task 18: `accountId` on `session.create`

**Files:**
- Modify: `anvild/src/session/supervisor.ts` (the create path)

**Behaviour spec:** resolve in order — the command's `accountId`, else the environment's `accountId`
(Task 33), else the roster default. Stamp `accountId` + `accountLabel` on the record before the first
`persist()`. An `accountId` that doesn't resolve is rejected with the command's `cid` rather than
silently defaulted.

**Verify:** `bunx tsc --noEmit && bun test`

**Commit:** `feat(session): stamp the chosen account on new sessions`

---

### Task 19: Web — account row in the new-session dialog

**Files:**
- Modify: `anvild/web/src/main.ts`

**Anchor:** the `createBtn?.addEventListener("click", …)` handler and the `const common = { … }`
object it builds.

**Behaviour spec:** an Account `<select>` beneath Environment, built with `enhanceSelect()` like the
existing `#ns-auto`. Hidden entirely when the roster has ≤1 account. Pre-selects the environment's
account, else the default. Adds `accountId` to `common`.

**Verify:** `bun run typecheck:web && bun run build:web`

**Commit:** `feat(web): choose the Claude account when starting a session`

---

### Task 20: Web — account chip on the session header

**Files:**
- Modify: `anvild/web/src/main.ts`

**Behaviour spec:** render `● <accountLabel>` in the session header beside the environment/branch.
Omit entirely when the roster has ≤1 account. When `accountMissing`, render
`● <default label> ⚠ was <old label>` with a title explaining the account was removed.

**Verify:** `bun run typecheck:web && bun run build:web`

**Commit:** `feat(web): show a session's Claude account on its header`

---

# Phase 5 — Rebinding

### Task 21: Extract `restartDriverForNewToken()` + the changed-token predicate

**Files:**
- Modify: `anvild/src/session/supervisor.ts`
- Test: `anvild/test/unit/accounts-restart.test.ts`

**Anchor:** `async restartIdleSessionsForNewToken(): Promise<void>` (search the symbol).

**Step 1: Write failing test** — assert the predicate:

```ts
test("adding a NON-default account restarts no drivers", async () => { /* … */ });
test("changing the default's token restarts idle sessions on the default", async () => { /* … */ });
test("a session pinned to an untouched account is not restarted", async () => { /* … */ });
test("a mid-turn session is left running and gets the existing message", async () => { /* … */ });
```

**Step 2: Run test, verify failure**

Run: `cd anvild && bun test test/unit/accounts-restart.test.ts`

**Step 3: Implement**

```ts
  /**
   * Drop one session's live driver so the next prompt rebuilds it with a fresh env. `claudeSessionId`
   * is KEPT, so `ensureDriver()`'s `resume` rejoins the same conversation on the new token (§5.3).
   * Returns false when the session is mid-turn and was left alone.
   */
  private async restartDriverForNewToken(id: string): Promise<boolean> {
    const status = this.sessions.get(id)?.data.status;
    if (status && status !== "idle") return false;
    const driver = this.drivers.get(id);
    if (!driver) return true;
    this.drivers.delete(id);
    await driver.stop().catch(() => {}); // best-effort — a dead driver is already what we want
    return true;
  }
```

Then rewrite the existing method in terms of it, adding the predicate:

```ts
  /**
   * A credential push landed. Restart only sessions whose RESOLVED token actually changed — with a
   * roster, adding a non-default account changes nothing for anyone (§5.3 knock-on).
   */
  async restartIdleSessionsForNewToken(before?: Map<string, string | undefined>): Promise<void> {
    const busy: string[] = [];
    for (const [id] of [...this.drivers]) {
      const s = this.sessions.get(id);
      if (!s) continue;
      if (before) {
        const prev = before.get(id);
        const now = this.accounts.token(s.data.accountId);
        if (prev === now) continue; // this session's token is unchanged — leave it running
      }
      if (!(await this.restartDriverForNewToken(id))) busy.push(id);
    }
    if (busy.length) { /* …existing emitError loop + console.log, unchanged… */ }
  }

  /** Snapshot each live session's resolved token, to diff against after a roster change. */
  tokensBySession(): Map<string, string | undefined> {
    return new Map([...this.drivers.keys()].map((id) => [id, this.accounts.token(this.sessions.get(id)?.data.accountId)]));
  }
```

Callers take a `before` snapshot: in `adoptCredentials()` (Task 29) and in the Task 11 mutators.

**Step 4: Run test, verify pass**

**Step 5: Commit**

```bash
git commit -m "refactor(session): per-session driver restart + only restart on a real token change"
```

---

### Task 22: `session.account.set`

**Files:**
- Modify: `anvild/src/session/supervisor.ts`, `anvild/src/server/http.ts`

**Behaviour spec:**

```ts
  async setSessionAccount(id: string, accountId: string): Promise<void> {
    const s = this.require(id);
    const acct = this.accounts.get(accountId);
    if (!acct) throw new Error(`unknown Claude account ${accountId}`);
    if (s.data.status !== "idle") {
      throw new Error("this session is mid-turn — finish or interrupt the turn, and the new login applies from the next one");
    }
    s.data.accountId = accountId;
    s.data.accountLabel = acct.label;
    delete s.data.accountMissing;
    await this.restartDriverForNewToken(id);
    this.persist();
    this.broadcastUpdated(s.data);
    s.emit({ type: "assistant.message", blocks: [{ kind: "markdown", rendered: this.renderer.render(`🔑 _Switched to **${acct.label}**._`) }] });
  }
```

The mid-turn wording deliberately mirrors `restartIdleSessionsForNewToken()`'s existing message so
both paths read as one behaviour.

**Verify:** `bunx tsc --noEmit && bun test`

**Commit:** `feat(session): session.account.set rebinds an idle session to another account`

---

### Task 23: Resume-failure → fresh context + divider

**Files:**
- Modify: `anvild/src/agent/driver.ts`, `anvild/src/session/supervisor.ts`

**Anchor:** `ensureStarted()` in `driver.ts` (`resume: s.data.claudeSessionId`).

**Behaviour spec:** on an SDK error that indicates the resume was rejected, do what `newTopic()` does
— `claudeSessionId = undefined`, `context = undefined` — and emit a persisted divider. Reuse
`newTopic()`'s divider machinery rather than a new event type.

Copy depends on Task 1's spike result:

- Resume works across accounts → "Couldn't carry the conversation across accounts — started a fresh
  context. Your worktree and files are untouched."
- Resume never works across accounts → make it the expected path: "Switching accounts starts a fresh
  context. Your worktree and files are untouched." Also add it to the Task 25 control's tooltip.

**Verify:** `bunx tsc --noEmit && bun test`

**Commit:** `feat(session): fall back to a fresh context when a cross-account resume fails`

---

### Task 24: Removal fallback + `accountMissing`

**Files:**
- Modify: `anvild/src/session/supervisor.ts`

**Behaviour spec:** implements the hook left in Task 11 §3. Distinguish the two §5.4 cases:

| Case | Detection | Behaviour |
|---|---|---|
| Account removed | roster is `role: "hub"` and the id is absent | clear `accountId`, set `accountMissing: true`, keep the old `accountLabel` for the badge, fall back to the default |
| Not yet replicated | roster is `role: "replica"` and `rev` < the hub's | refuse the spawn with "This Mac hasn't received the *personal* login yet. Open Settings → Servers and press Sync now." |

**Verify:** `bunx tsc --noEmit && bun test`

**Commit:** `feat(session): visible fallback when a session's account is removed`

---

### Task 25: Web — header switch control

**Files:**
- Modify: `anvild/web/src/main.ts`

**Behaviour spec:** turn the Task 20 chip into a dropdown. Disabled unless `status === "idle"`, with
the tooltip "finish or interrupt the current turn first". Sends `session.account.set`. Hidden when the
roster has ≤1 account.

**Verify:** `bun run typecheck:web && bun run build:web`

**Commit:** `feat(web): switch a session's Claude account from its header`

---

# Phase 6 — Hub identity (client-side)

### Task 26: Consume `role` / `hubServerId` in the client

**Files:**
- Modify: `anvild/web/src/main.ts`

**Anchors:** `const HUB_URL = daemonBase();` and the `server.hello` handler.

**Behaviour spec:** store `role` and `hubServerId` on the `Server` record. Add:

```ts
/** The server that owns the account roster: the connected server whose serverId matches this
 *  machine's paired hub, else the hub-role server, else the origin (a standalone daemon). */
function rosterServer(): Server;
```

`HUB_URL` keeps its current meaning (the origin) — this is deliberately a **new** notion, not a
redefinition, so nothing that legitimately means "the origin" changes behaviour.

**Verify:** `bun run typecheck:web && bun run build:web`

**Commit:** `feat(web): track each server's fleet role and its paired hub`

---

### Task 27: Route roster writes; adopt-your-hub card

**Files:**
- Modify: `anvild/web/src/main.ts`

**Behaviour spec:** every `auth.account*` command goes to `rosterServer().sock`, not `hub().sock`.
When the origin is a `member` and its `hubServerId` isn't among the connected servers, render a card
on the Servers tab: "This Mac is part of **<hub>**'s fleet" with an Add button that adopts the hub by
URL. Discover the URL from the hub's own `/api/fleet/members` once connected; until then prompt for
it, as `showAddMac()` already does for a peer.

**Verify:** `bun run typecheck:web && bun run build:web`

**Commit:** `feat(web): send roster writes to the hub and offer to adopt it from a member origin`

---

### Task 28: Replace the "Updated 0/0 Macs" toast

**Files:**
- Modify: `anvild/web/src/main.ts` (`rotateFleetToken()`)

**Behaviour spec:** before posting, if the origin server's `role !== "hub"`, toast
"This Mac isn't the hub — **<hub name>** is" and return. If it is the hub and `results` is empty,
toast "No other Macs in this fleet yet." Only report `Updated n/m` when `m > 0`.

**Verify:** `bun run typecheck:web && bun run build:web`

**Commit:** `fix(web): stop reporting a silent success when a non-hub is asked to fan out`

---

# Phase 7 — Replication

### Task 29: `accounts?` on the pair/token payloads

**Files:**
- Modify: `anvild/src/server/http.ts` (`adoptCredentials`)
- Test: `anvild/test/unit/accounts-replication.test.ts`

**Step 1: Write failing test**

```ts
test("a push carrying accounts persists a replica and sets the default", () => { /* … */ });
test("a push WITHOUT accounts leaves today's behaviour bit-for-bit unchanged", () => { /* … */ });
test("a pushed metered key is still rejected (adoptCredentials routes through setClaudeToken)", () => { /* … */ });
test("adopting a replica takes a token snapshot first so only changed sessions restart", () => { /* … */ });
```

**Step 2: Run test, verify failure**

**Step 3: Implement** — extend `adoptCredentials`:

```ts
      const adoptCredentials = (body: { token?: string; todoistToken?: string; openRouterKey?: string; accounts?: rest.RosterPush }): string | null => {
        const before = supervisor.tokensBySession();
        if (body.accounts) {
          try {
            opts.accounts.adoptReplica(body.accounts);
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
        }
        try {
          setClaudeToken(String(body.token ?? "")); // also clears the degrade marker + failure counter
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
        …existing sibling-secret handling, unchanged…
        supervisor.authDegrade.recover();
        supervisor.broadcastAuthState();
        supervisor.broadcastAccounts();
        void supervisor.restartIdleSessionsForNewToken(before);
        return null;
      };
```

Order matters: adopt the roster **before** `setClaudeToken()`, so the token being set is already
consistent with the roster the sessions will resolve against.

**Step 4: Run test, verify pass**

**Step 5: Commit**

```bash
git commit -m "feat(fleet): carry the account roster on pair and token pushes"
```

---

### Task 30: `GET /api/fleet/accounts`

**Files:**
- Modify: `anvild/src/server/http.ts`

**Implement** (beside the other `/api/fleet/*` routes):

```ts
      // Read-only roster for the session-start picker, readable from ANY origin so a member's client
      // can render it. Masked previews only — never a raw token (§11).
      if (url.pathname === "/api/fleet/accounts" && req.method === "GET") {
        const snap = opts.accounts.snapshot();
        const hub = pairedHub.get();
        return Response.json({
          rev: snap.rev,
          ...(snap.defaultId ? { defaultId: snap.defaultId } : {}),
          role: snap.role,
          ...(hub ? { hubServerId: hub.hubServerId } : {}),
          accounts: opts.accounts.publicList(),
        } satisfies rest.FleetAccountsResponse);
      }
```

**Verify:** `bunx tsc --noEmit && bun test`

**Commit:** `feat(fleet): GET /api/fleet/accounts returns masked roster previews`

---

### Task 31: Hub auto-push + per-member `rev` + capability tiering

**Files:**
- Modify: `anvild/src/server/fleet.ts`, `anvild/src/server/http.ts`, `anvild/src/fleet/store.ts`

**Behaviour spec:**

1. `rotateToken()` gains `accounts?: RosterPush`, passed straight into the `pushCredential` body.
   Include it only for peers advertising `"accounts"` — re-probe per member exactly as
   `speaksPairing()` already is.
2. On success, record `accountsRev` on the member's `FleetMember` via `fleet.upsert()`.
3. Every Task 11 mutator fires a background push to all members (fire-and-forget, logged).
4. `/api/fleet/invite` includes the roster in the pair body.

**Verify:** `bunx tsc --noEmit && bun test`

**Commit:** `feat(fleet): push the roster on every change and track each member's rev`

---

### Task 32: Web — Servers-tab sync state + "Sync now"

**Files:**
- Modify: `anvild/web/src/main.ts`

**Behaviour spec:** per-card state from `accountsRev` vs the hub's `rev` — "in sync · N accounts",
"⚠ out of date", or "Update Anvil to use multiple accounts" when the member lacks the `accounts`
capability. Rename the header button to **Sync now**.

**Verify:** `bun run typecheck:web && bun run build:web`

**Commit:** `feat(web): show per-Mac roster sync state and a Sync now retry`

---

# Phase 8 — Environments

### Task 33: `Environment.accountId` + autopilot

**Files:**
- Modify: `anvild/src/env/store.ts`, `anvild/src/integrations/autopilot.ts`,
  `anvild/web/src/main.ts` (environment dialog)

**Behaviour spec:** optional `accountId` on the environment record and its edit dialog, described as
"used for scheduled autopilot runs and pre-selected for new sessions". `autopilot.ts`'s
`buildAgentEnv()` becomes `buildAgentEnv({ accounts, accountId: env.accountId })`. Add the resolved
account's label to the autopilot report header.

**Verify:** `bunx tsc --noEmit && bun run typecheck:web && bun run build:web && bun test`

**Commit:** `feat(autopilot): bill scheduled runs to the environment's account`

---

# Phase 9 — Acceptance

### Task 34: User E2E acceptance — **HARD PAUSE**

**Do not start Task 35 until the user reports back.** Everything up to here is verified by unit
tests and type checks against fakes. None of that can prove the feature works, because the three
things most likely to be wrong all need real infrastructure: a second live subscription, a real
mid-session account switch, and a real member Mac receiving a push.

**Step 1: Deploy to the canonical checkout**

The daemon runs from the canonical checkout, not the worktree:

```bash
cd /home/stonelyd/anvil
git fetch origin && git log --oneline -1 design/multi-account-tokens
anvild/scripts/service.sh restart
curl -fsS http://127.0.0.1:7701/api/health | jq
```

**Step 2: Hand the user this checklist**

Post it in chat and stop. Each line is a thing only a human with two subscriptions can confirm.

*Roster (Settings → Models)*
- [ ] The existing token appears as `default` after upgrading — nothing was lost, nothing was retyped
- [ ] Add a second account with a label; the copyable `claude setup-token` command names the right host
- [ ] Pasting an `sk-ant-api…` key is refused with the §3 message
- [ ] A duplicate label is refused, case-insensitively
- [ ] Rename, replace-token, and set-default all work; removing the last account is refused
- [ ] Restart the daemon (`service.sh restart`) — the roster and the default survive

*Sessions*
- [ ] The new-session dialog offers the account picker and pre-selects the right one
- [ ] The session header shows the chosen account
- [ ] Start a session on account A, run 2–3 turns, confirm usage lands on A's subscription
- [ ] **Switch that session to B from the header, mid-conversation.** Does the thread carry over, or
      does it restart with the divider? *This is Task 1's spike run for real — record the answer.*
- [ ] The switch control is disabled mid-turn and the tooltip explains why
- [ ] Remove an account 2+ active sessions are using: the confirm names them, and afterwards their
      headers show the `⚠ was <label>` badge

*Fleet* (needs a second Mac)
- [ ] Adding an account on the hub reaches the member without pressing anything
- [ ] Take the member offline, add a third account, bring it back — the Servers tab shows it out of
      date, and **Sync now** repairs it
- [ ] Load the UI from the **member's** URL: the roster renders, the picker works, and it says the
      hub manages it — no empty fleet, no `Updated 0/0 Macs`
- [ ] Start a session on the member pinned to an account, confirm it spawns on the right token

*Unattended*
- [ ] Set an environment's account; the nightly autopilot report names it

**Step 3: Record the outcome**

### Run 1 — 2026-07-26, live two-machine fleet

Hub: WSL2 (`wsl-hub`, 100.109.254.54) · Member: Proxmox LXC (`lxc-member`, 100.65.227.81), both on
port 7711, same tailnet, same Tailscale user. Two real subscription tokens (`work`, `personal`).

**Verified working**

- Boot migration seeded the env token as `default`, and was correctly idempotent across a restart.
- Roster CRUD, masking, `rev` increments, persistence across restart.
- Pair carries the roster: member went `rev 0 / role hub / 0 accounts` → `rev 3 / role replica /
  2 accounts` with the right `hubServerId`, and `subscriptionAuthOk` flipped false → true.
- Replica refuses local writes with AccountStore's message, verbatim.
- Auto-push on mutation: a rename on the hub reached the member within seconds; both revs moved together.
- Per-member `accountsRev` recorded after a rotation.

**Bugs found and fixed** (neither reachable by unit tests)

1. **The test suite overwrote the developer's real Claude credential.** `afterAccountMutation()`
   called `mirrorDefault()` with no file argument, defaulting to the real `~/.config/anvil/env`, so
   any test building a Supervisor and adding an account replaced a working token with a fixture
   string. Would have hit CI and every contributor. Fixed by an `envFile` override on
   `SupervisorConfig`/`ServerOptions`, pinned in every test; verified by deleting the real file and
   confirming a full run no longer recreates it.
2. **A freshly-paired member read as out of sync.** `/api/fleet/invite` sent the roster (the member
   adopted it fine) but recorded the `FleetMember` with no `accountsRev` — only the rotation path set
   it. The Servers tab therefore said "out of date — press Sync now" about a member that was fully in
   sync. Fixed by having `invitePeer` report the rev it actually delivered, which also collapses a
   duplicated capability gate into one place. Confirmed on the live fleet: `accountsRev: 4` now lands
   at pair time.

**Environment artifacts — NOT defects in this feature** (recorded so they aren't re-diagnosed)

- Port 7701 was held by a VS Code port-forward on Windows; WSL2 mirrored networking shares Windows'
  port space, so the bind collided. Moved the whole fleet to 7711 — hub and member must share a port
  because the fleet dials `<member-host>:<hub's port>`.
- Windows Firewall blocks inbound to a WSL tailnet-IP bind, so the hub needed `ANVIL_HOST=127.0.0.1`
  (WSL loopback IS reachable from Windows). Pairing is unaffected — it is all hub→member outbound.
- WSL cannot resolve MagicDNS, and the "Add a machine" picker only ever offers names
  (`host: p.dnsName || p.ipv4`), so the invite had to be driven by IP. See the follow-up below.
- The member's `Host` is a bare IP, so `tailnetDomainOf()` yields nothing and the WS origin gate 403s
  a cross-origin hub page; needed `ANVIL_ALLOWED_ORIGINS`. A Mac hub with MagicDNS gets same-tailnet
  trust for free. Gate confirmed still enforcing (a control Origin was rejected).

**Still unverified**

- That a session pinned to `personal` bills token B's subscription. The daemon demonstrably resolves
  and spawns with the right token; only the Anthropic usage dashboard can confirm where the charge
  lands.

### Run 2 — 2026-07-26, driven through a real browser

Windows Chrome over CDP (WSLg's X surface is a 640x480 vestige that parks windows at -32730,-32709 —
run the browser on the Windows side and reach it over mirrored networking).

**Verified in the UI, end to end**

- Models tab renders the roster: default marker, labels, masked previews, per-row menu, Add account.
- Add-account dialog: host-specific `claude setup-token` hint naming the hub; a metered `sk-ant-api03-`
  key is refused INLINE with the §3 message and the dialog stays open with values intact; a duplicate
  label is refused case-insensitively ("an account called \"work\" already exists").
- New-session dialog shows the Account row under Environment, pre-selected to the roster default.
- Creating a session pinned to `personal` stamps `accountId`/`accountLabel` server-side; the header
  chip reads `* personal` with a "tap to switch" tooltip.
- The chip's menu switches the session (`* seiraiyu`), rebinds it server-side, and drops
  "Switched to seiraiyu." into the transcript.
- Removing an in-use account: the confirm names the session ("in use by 1 session: acct-demo") from
  the event's `inUse` map with no extra round trip; afterwards the session falls back to the default
  and the header shows `work ! was seiraiyu`, because `accountLabel` deliberately keeps the REMOVED
  name (see bug 3 above — this is the payoff for that fix).

**Bug 5, found here** — see the fix list above: `/api/fleet/rotate` could never answer while a member
was offline (Bun's 10s `idleTimeout` vs postPairing's 12s), so "Sync now" hung and the UI blamed the
hub. Confirmed fixed: with the member down it now returns `200` in ~14s with a real per-member error.

**Follow-up worth its own PR (pre-existing, outside this change)**

`invitePeer`/`resolveMember` dial only the MagicDNS name when a peer has one, so on any hub where
those names don't resolve, "Add a machine" fails against a peer that is perfectly reachable by IP.
The codebase already cares about this class of failure (`healFleetUrlsByDiscovery` exists to recover
members stranded when MagicDNS is switched off), so falling back to the tailnet IP looks right.

Then commit:

```bash
git commit -m "docs: record multi-account E2E acceptance findings (task 34)"
```

---

# Phase 10 — Fix and ship

### Task 35: Fix everything Task 34 surfaced

**Files:** wherever the findings point.

One commit per finding, each with its own test where a test is possible. Re-run the full gates after
each. If a finding invalidates a design decision rather than an implementation detail, amend
`2026-07-25-multi-account-tokens-design.md` in the same commit — do not let the doc and the code
diverge, which is the failure that cost this feature a whole revision already.

Re-run the affected parts of Task 34's checklist with the user before moving on.

**Verify:** `cd anvild && bunx tsc --noEmit && bun run typecheck:web && bun run build:web && bun test`

**Commit:** one per fix, `fix(...): …`

---

### Task 36: Docs, final gates, PR

**Files:**
- Modify: `SECURITY.md`, `docs/plans/anvil-multi-server.md`, `README.md`, `anvild/README.md`
- Modify: `docs/plans/2026-07-25-multi-account-tokens-design.md` (flip §15 statuses)

**Gated on Tasks 34 and 35 being green.** Do not open the PR against un-accepted work.

**Steps:**

1. `SECURITY.md` — the §7.4 paragraph: every member holds every token; the push is gated on
   `sameUser` + `hubServerId`; `GET /api/fleet/accounts` is masked-only.
2. `anvil-multi-server.md` — mark **MS-2** superseded, pointing at this design.
3. `README.md` / `anvild/README.md` — token setup now describes the roster.
4. Flip every row of the design's §15 table to `done`.
5. Full gates:
   ```bash
   cd anvild && bunx tsc --noEmit && bun run typecheck:web && bun run build:web && bun test
   ```
6. Open the PR:
   ```bash
   gh pr create --base main --title "feat: multiple Claude accounts (token roster)" --body "…"
   ```

**Merge with the worktree-safe script, never `gh pr merge --delete-branch`:**

```bash
anvild/scripts/merge-session.sh --squash
```

**Commit:** `docs: record the multi-account rollout; flip the phase table`

---

## Open risks

| Risk | Mitigation |
|---|---|
| Cross-account `--resume` is refused by the CLI | Task 1 spike gates only Task 23's *copy*; the fresh-context path ships either way |
| A hub and a member disagree about `rev` after a partial push | `rev` is advisory for display; the member's roster is whatever last landed. Sync now re-pushes the full payload — no merge, no conflict |
| Two `AccountStore` instances over one file drift | Constructed once in `main.ts` and passed in (Task 5). Do not `new AccountStore` anywhere else |
| A rename orphans sessions | Sessions bind to `id`, never `label`; `accountLabel` is denormalised display refreshed on rename (Task 11 §4) |
| Usage split across accounts is invisible | Accepted and documented as a non-goal (design §1); `budget/tracker.ts` untouched |
