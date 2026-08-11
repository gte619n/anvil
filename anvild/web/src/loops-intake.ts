// ── Claude-led loop intake (loops-circuit spec §4.4, Phase 3) ───────────────────────────────────────
// The conversation that dials a loop in: a repo-aware suggestion from the daemon (loop.intake) drives a
// ≤5-question chat — check → scope → hard stops → gate → "still ambiguous" — with one-tap suggested
// answers and the circuit lighting up above the chat as each station is decided. Arming dry-runs the
// first lap in a throwaway worktree (no branch/PR) before the loop is trusted. Ported from the validated
// mock (web/preview/loops-preview.html) and wired to the real loop.save / loop.arm / loop.dryrun surface.
import { esc, icon } from "./dom";
import { toast } from "./dialogs";
import { newCid } from "./outbox";
import { HUB_URL, envServer, serverByUrl, serverSupports, servers, type Server } from "./fleet";
import { circuitSvg, type CircuitView } from "./circuit";
import type { Environment, LoopInput, LoopIntakeSuggestion, LoopRung, ServerEvent } from "../../protocol";

export interface IntakeDeps {
  environments: Map<string, Environment>;
  sendAwait(server: Server, cmd: Record<string, unknown> & { type: string; cid: string }, timeoutMs?: number): Promise<ServerEvent>;
  rootId: string; // the element the conversation renders into (#lc-root)
  onArmed(loopId: string): void; // open the new loop's detail
  onCancel(): void; // back to the home
}
let deps: IntakeDeps;
export function initIntake(d: IntakeDeps): void {
  deps = d;
}

interface Draft {
  name: string;
  environmentId?: string;
  workUnitId?: string; // set when the intake was entered from an autopilot draft (links the loop)
  prompt: string;
  checkCommand?: string;
  judgeCondition?: string; // set instead of checkCommand when the user picks a judge check
  checkLocks: string[];
  scopeAllow: string[];
  rung: LoopRung;
  maxLaps: number;
  tokenBudget: number;
  assumptions: string[];
  runnerAt: CircuitView["runnerAt"];
}

interface Step {
  claude: string;
  chips: [string, () => void][];
  final?: boolean;
}

/** Pick the server that will own the loop (the env's, else the hub) — must support the loops capability. */
function targetServer(environmentId?: string): Server | undefined {
  const url = environmentId ? envServer.get(environmentId) : HUB_URL;
  const srv = serverByUrl(url) ?? serverByUrl(HUB_URL) ?? servers.get(HUB_URL);
  return srv && serverSupports(srv, "loops") ? srv : undefined;
}

function draftCircuit(d: Draft): CircuitView {
  return {
    trigger: "Manual",
    act: d.prompt ? (d.prompt.length > 40 ? d.prompt.slice(0, 39) + "…" : d.prompt) : "…",
    check: d.checkCommand ?? "…",
    rung: d.rung,
    runnerAt: d.runnerAt ?? null,
    laps: { current: 0, max: d.maxLaps },
    ...(d.scopeAllow.length ? { scope: d.scopeAllow.join(", ") } : {}),
    status: "armed",
  };
}

/** The environment the loop will run in: the draft's, else the sole environment (auto), else the first.
 *  A session/skill body needs a repo, so we always resolve one when any exists (changeable later via Edit). */
function resolveEnv(fromDraft?: { environmentId?: string }): string | undefined {
  if (fromDraft?.environmentId) return fromDraft.environmentId;
  const ids = [...deps.environments.keys()];
  return ids[0]; // undefined when the fleet has no environments (arm is blocked with a clear message)
}

export async function openIntake(prompt: string, fromDraft?: { workUnitId: string; environmentId?: string }): Promise<void> {
  const app = document.getElementById(deps.rootId);
  if (!app) return;
  const environmentId = resolveEnv(fromDraft);
  const envName = environmentId ? deps.environments.get(environmentId)?.name : undefined;
  // Ask the daemon for a repo-aware suggestion (loops-capable server; else fall back to a local heuristic).
  const srv = targetServer(environmentId);
  let suggestion: LoopIntakeSuggestion | undefined;
  if (srv?.sock.isOpen()) {
    try {
      const res = await deps.sendAwait(srv, { type: "loop.intake", prompt, ...(environmentId ? { environmentId } : {}), cid: newCid() }, 30_000);
      if (res.type === "loop.intake.result") suggestion = res.suggestion;
    } catch {
      /* fall through to the local default */
    }
  }
  const s: LoopIntakeSuggestion = suggestion ?? localSuggestion(prompt);
  const draft: Draft = {
    name: s.name,
    ...(environmentId ? { environmentId } : {}),
    ...(fromDraft?.workUnitId ? { workUnitId: fromDraft.workUnitId } : {}),
    prompt: prompt.replace(/^\(from Todoist\)\s*/i, "") || s.name,
    checkLocks: s.checkLocks ?? [],
    scopeAllow: [],
    rung: s.rung,
    maxLaps: s.maxLaps,
    tokenBudget: s.tokenBudget,
    assumptions: [],
    runnerAt: null,
  };

  const steps: Step[] = [
    {
      claude: `Got it${fromDraft ? " — pulling this in from your draft" : ""}: <b>${esc(s.name)}</b>${envName ? ` on <b>${esc(envName)}</b>` : ""}.<br><br>A loop is only as good as its <b>check</b> — how will we <i>know</i> it's done?${s.checkCommand ? `<br>From the repo I'd verify with <code>${esc(s.checkCommand)}</code>.` : ""}`,
      chips: s.checkCommand
        ? [
            ["Use that check", () => { draft.checkCommand = s.checkCommand; draft.runnerAt = "check"; }],
            ["Judge it instead", () => { draft.judgeCondition = draft.prompt; draft.runnerAt = "check"; }],
          ]
        : [
            ["Judge that it works", () => { draft.judgeCondition = draft.prompt; draft.runnerAt = "check"; }],
            ["I'll add a check later", () => { draft.runnerAt = "check"; }],
          ],
    },
    {
      claude: `Check locked${draft.checkLocks.length ? " — and its inputs are locked too (a lap that edits them fails as check-tampering)" : ""}.<br><br><b>Scope:</b> ${s.scopeAllow.length ? `I'll stay inside <code>${esc(s.scopeAllow.join(", "))}</code> — anything else fails the lap.` : "I'll work across the repo (no scope wall)."}<br><br>Hard stops: <b>${s.maxLaps} laps</b>, <b>${Math.round(s.tokenBudget / 1000)}k tokens</b>, stop after 2 no-progress laps. Sound right?`,
      chips: [
        ["Sounds right", () => { draft.scopeAllow = s.scopeAllow; draft.runnerAt = "act"; }],
        ["Tighter budget", () => { draft.scopeAllow = s.scopeAllow; draft.tokenBudget = Math.round(s.tokenBudget / 2); draft.runnerAt = "act"; }],
      ],
    },
    {
      claude: `<b>Where do you want to sit</b> on the circuit? I'd suggest <b>${s.rung.toUpperCase()}</b> — new loops start gated and earn a longer leash.`,
      chips: [
        ["PR — I merge", () => { draft.rung = "pr"; }],
        ["Draft — I open the PR", () => { draft.rung = "draft"; }],
        ["Just suggest", () => { draft.rung = "suggest"; }],
      ],
    },
    {
      claude: `One more thing — <b>still ambiguous</b>, so you decide instead of me guessing:<br><ul>${s.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>Accept as logged assumptions, or skip?`,
      chips: [
        ["Accept — log them", () => { draft.assumptions = s.assumptions; }],
        ["Skip", () => { draft.assumptions = []; }],
      ],
    },
    {
      claude: `Here's your loop — the first lap will be a <b>dry-run</b> (throwaway worktree, no branch or PR) so you can see it work before it's trusted. <b>Trigger:</b> manual for now.`,
      chips: [
        ["Arm it — run the dry lap", () => void armLoop(draft, true)],
        ["Save as draft", () => void armLoop(draft, false)],
      ],
      final: true,
    },
  ];

  app.innerHTML = `
    <div class="lc-head"><button class="mini" id="lc-cancel">${icon("close")} Cancel</button><h2>New loop</h2></div>
    <div class="lc-circuit-card" id="lc-live-circuit">${circuitSvg(draftCircuit(draft))}</div>
    <p class="lc-sub" style="text-align:center">${icon("auto_awesome")} Claude is building the circuit with you — watch the stations light up.</p>
    <div class="lc-chat" id="lc-chat"></div>`;
  document.getElementById("lc-cancel")?.addEventListener("click", () => deps.onCancel());
  const chat = document.getElementById("lc-chat")!;
  const bubble = (cls: string, html: string): HTMLElement => {
    const d = document.createElement("div");
    d.className = "lc-bub " + cls;
    d.innerHTML = html;
    chat.appendChild(d);
    d.scrollIntoView?.({ behavior: "smooth", block: "end" });
    return d;
  };
  bubble("user", esc(prompt || s.name));
  let step = 0;
  const ask = (): void => {
    const st = steps[step];
    if (!st) return;
    bubble("bot", st.claude);
    const row = document.createElement("div");
    row.className = "lc-chips";
    for (const [label, fn] of st.chips) {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", () => {
        row.remove();
        bubble("user", esc(label));
        fn();
        const live = document.getElementById("lc-live-circuit");
        if (live) live.innerHTML = circuitSvg(draftCircuit(draft));
        if (!st.final) {
          step++;
          ask();
        }
      });
      row.appendChild(b);
    }
    chat.appendChild(row);
    row.scrollIntoView?.({ behavior: "smooth", block: "end" });
  };
  ask();
}

async function armLoop(draft: Draft, dryRun: boolean): Promise<void> {
  const srv = targetServer(draft.environmentId);
  if (!srv?.sock.isOpen()) {
    toast("This server doesn't support loops yet — update it");
    return;
  }
  // A session body needs a repo. If the fleet has no environment, arming would fail at the first lap —
  // block it here with a clear message rather than a hidden dry-run error.
  if (dryRun && !draft.environmentId) {
    toast("Add an environment (Settings → Servers) before running a loop");
    return;
  }
  const checks: LoopInput["checks"] = draft.checkCommand
    ? [{ kind: "command", command: draft.checkCommand, ...(draft.checkLocks.length ? { locks: draft.checkLocks } : {}) }]
    : draft.judgeCondition
      ? [{ kind: "judge", condition: draft.judgeCondition }]
      : [];
  const input: LoopInput = {
    name: draft.name,
    ...(draft.environmentId ? { environmentId: draft.environmentId } : {}),
    trigger: { kind: "manual" },
    act: { kind: "session-prompt", prompt: draft.prompt },
    checks,
    checksMode: "all",
    ...(draft.scopeAllow.length ? { scope: { allow: draft.scopeAllow } } : {}),
    rung: draft.rung,
    hardStops: { maxLaps: draft.maxLaps, tokenBudget: draft.tokenBudget },
    assumptions: draft.assumptions,
    ...(draft.workUnitId ? { workUnitId: draft.workUnitId } : {}),
  };
  try {
    const res = await deps.sendAwait(srv, { type: "loop.save", loop: input, cid: newCid() }, 30_000);
    if (res.type === "command.error") return void toast(res.message);
    if (res.type !== "loop.updated") return;
    const loopId = res.loop.id;
    if (dryRun) {
      const armRes = await deps.sendAwait(srv, { type: "loop.arm", loopId, cid: newCid() }, 20_000);
      if (armRes.type === "command.error") return void toast(armRes.message); // don't dry-run a loop that failed to arm
      // Fire the dry-run first lap (report only; leaves no branch/PR). Surface a real failure, don't swallow it.
      void deps
        .sendAwait(srv, { type: "loop.dryrun", loopId, cid: newCid() }, 600_000)
        .then((r) => { if (r.type === "command.error") toast(`Dry run: ${r.message}`); })
        .catch((e) => toast(`Dry run failed: ${e instanceof Error ? e.message : String(e)}`));
      toast("Loop armed — dry lap running");
    } else {
      toast("Saved as draft");
    }
    deps.onArmed(loopId);
  } catch (err) {
    toast(`Couldn't create the loop: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Offline / no-loops-server fallback: a client-side heuristic mirroring the daemon's intakeSuggest. */
function localSuggestion(prompt: string): LoopIntakeSuggestion {
  const p = prompt.trim();
  const isFeature = !/\b(fix|flak|bug|broke|broken|fail|regress)/i.test(p) && /\b(add|export|feature|build|create|new|implement)/i.test(p);
  return {
    isFeature,
    name: p.replace(/^\(from Todoist\)\s*/i, "").slice(0, 60) || "New loop",
    checkCommand: "bun test",
    scopeAllow: [],
    maxLaps: isFeature ? 12 : 10,
    tokenBudget: isFeature ? 400_000 : 300_000,
    rung: "pr",
    assumptions: isFeature ? ["Sensible defaults where the spec is silent"] : ["The failure is deterministic, not environment-specific"],
  };
}
