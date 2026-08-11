// ── The Loop circuit renderer ────────────────────────────────────────────────────────────────────
// One idea, drawn once: Trigger → Act ⇄ Check → 🔒 gate → Ship, and the lock is where *you* sit.
// Ported verbatim (geometry + classes) from the validated mock (web/preview/loops-preview.html) so the
// shipped surface matches the concept walkthrough. Pure: (view) → SVG string, no DOM/state — unit-safe.
// Both the Phase-1 projection (loopToCircuit below) and the Phase-2 real Loop entity produce a
// CircuitView, so the same renderer draws every row.
import { esc, icon } from "./dom";
import type { LoopRung, LoopStation, LoopStatus, LoopSummary } from "../../protocol";

export interface CircuitView {
  trigger: string; // Trigger-station sublabel
  act: string; // Act-station sublabel (what the loop does)
  check: string; // Check-station sublabel (how we know it's done)
  rung: LoopRung; // gate position = autonomy
  runnerAt?: LoopStation | null; // where the glowing runner sits (null = not running)
  laps?: { current: number; max: number };
  scope?: string; // shield line under the circuit
  status: LoopStatus; // drives the mini-glyph colour
}

export const RUNGS: { k: LoopRung; name: string; gate: string; desc: string }[] = [
  { k: "suggest", name: "Suggest", gate: "reports findings only", desc: "Read-only. Each lap ends in a report." },
  { k: "draft", name: "Draft", gate: "stops before PR", desc: "Writes to a branch; you open the PR." },
  { k: "pr", name: "PR", gate: "stops before merge", desc: "Opens a verified PR; you merge." },
  { k: "ship", name: "Ship", gate: "", desc: "Merges on green. No gate." },
];
export const rung = (k: LoopRung): (typeof RUNGS)[number] => RUNGS.find((r) => r.k === k) ?? RUNGS[2]!;

// stations: trigger(70) act(240) check(410) ship(640); gate diamond between check→ship
const ST: Record<LoopStation | "gate" | "ret", { x: number; y: number }> = {
  trigger: { x: 70, y: 74 },
  act: { x: 240, y: 74 },
  check: { x: 410, y: 74 },
  ship: { x: 640, y: 74 },
  gate: { x: 522, y: 74 },
  ret: { x: 325, y: 158 },
};

/** The full circuit SVG (detail page + intake live-build). `laps` drives the return-loop caption. */
export function circuitSvg(l: CircuitView): string {
  const r = rung(l.rung);
  const gated = l.rung !== "ship";
  const runner = l.runnerAt
    ? `<g class="lc-runner-g" id="runner" transform="translate(${ST[l.runnerAt].x},${ST[l.runnerAt].y})"><circle class="lc-runner" r="7"/></g>`
    : "";
  const st = (k: LoopStation, ic: string, lbl: string, sub: string, cls: string): string => `
    <g class="lc-st ${cls}">
      <circle class="lc-st-circle" cx="${ST[k].x}" cy="${ST[k].y}" r="24"/>
      <text class="lc-st-ico" x="${ST[k].x}" y="${ST[k].y + 7}" text-anchor="middle">${ic}</text>
      <text class="lc-st-lbl" x="${ST[k].x}" y="${ST[k].y + 44}" text-anchor="middle">${esc(lbl)}</text>
      ${sub ? `<text class="lc-st-sub" x="${ST[k].x}" y="${ST[k].y + 58}" text-anchor="middle">${esc(sub.length > 30 ? sub.slice(0, 29) + "…" : sub)}</text>` : ""}
    </g>`;
  const active = (k: LoopStation): string => (l.runnerAt === k ? "on" : "");
  const lapCaption = l.laps
    ? `lap ${l.laps.current} of ${l.laps.max} · until check passes`
    : "Act ⇄ Check until the check passes";
  return `<svg class="lc-circuit" viewBox="0 0 710 190" xmlns="http://www.w3.org/2000/svg">
    <line class="lc-track" x1="94" y1="74" x2="216" y2="74"/>
    <line class="lc-track" x1="264" y1="74" x2="386" y2="74"/>
    <line class="lc-track" x1="434" y1="74" x2="${gated ? 506 : 616}" y2="74"/>
    ${gated ? `<line class="lc-track" x1="538" y1="74" x2="616" y2="74"/>` : ""}
    <path class="lc-return" d="M 410 100 L 410 158 L 240 158 L 240 100"/>
    <text class="lc-lap" x="${ST.ret.x}" y="150" text-anchor="middle">${esc(lapCaption)}</text>
    ${st("trigger", "bolt", "Trigger", l.trigger, active("trigger"))}
    ${st("act", "construction", "Act", l.act, active("act"))}
    ${st("check", "verified", "Check", l.check, active("check"))}
    ${
      gated
        ? `<g class="lc-st ${active("gate")}">
      <rect class="lc-gate-d" x="${ST.gate.x - 14}" y="${ST.gate.y - 14}" width="28" height="28" rx="6" transform="rotate(45 ${ST.gate.x} ${ST.gate.y})"/>
      <text class="lc-gate-ico" x="${ST.gate.x}" y="${ST.gate.y + 5}" text-anchor="middle">lock</text>
      <text class="lc-gate-lbl" x="${ST.gate.x}" y="${ST.gate.y + 44}" text-anchor="middle">you · ${esc(r.gate)}</text>
    </g>`
        : ""
    }
    ${st("ship", "rocket_launch", "Ship", r.k === "ship" ? "merges on green" : "", active("ship"))}
    ${runner}
  </svg>${l.scope ? `<div class="lc-scope">${icon("shield")}<span><b>Scope:</b> ${esc(l.scope)}</span></div>` : ""}`;
}

/** The compact mini-glyph for a list row: track + runner dot + gate lock, coloured by status. */
export function miniSvg(l: CircuitView): string {
  const dot = l.runnerAt ? ({ trigger: 14, act: 44, check: 74, gate: 89, ship: 104 } as Record<LoopStation, number>)[l.runnerAt] : null;
  const col =
    l.status === "running"
      ? "#f2c037"
      : l.status === "gated"
        ? "#b07cc3"
        : l.status === "paused"
          ? "var(--muted)"
          : "#2196c9";
  return `<svg class="lc-mini" width="118" height="34" viewBox="0 0 118 34">
    <line x1="14" y1="14" x2="104" y2="14" stroke="var(--border)" stroke-width="2"/>
    <path d="M 74 18 L 74 27 L 44 27 L 44 18" stroke="${col}" stroke-width="1.5" fill="none" stroke-dasharray="3 3" opacity=".7"/>
    ${[14, 44, 74, 104].map((x) => `<circle cx="${x}" cy="14" r="4.5" fill="var(--bg)" stroke="var(--border)" stroke-width="1.5"/>`).join("")}
    ${l.rung !== "ship" ? `<rect x="85" y="10" width="8" height="8" rx="2" transform="rotate(45 89 14)" fill="none" stroke="#b07cc3" stroke-width="1.5"/>` : ""}
    ${dot !== null ? `<circle cx="${dot}" cy="14" r="5" fill="${col}"/>` : ""}
  </svg>`;
}

/** Map a projected/real loop row to a circuit view, filling display defaults the daemon may have omitted. */
export function loopToCircuit(l: LoopSummary): CircuitView {
  const rungK: LoopRung = l.rung ?? (l.kind === "goal" || l.kind === "pipeline" ? "pr" : "suggest");
  return {
    trigger: l.trigger,
    act: l.act ?? l.title,
    check: l.stopCondition,
    rung: rungK,
    runnerAt: l.runnerAt ?? (l.status === "running" ? "act" : l.status === "gated" ? "gate" : null),
    ...(l.iteration ? { laps: l.iteration } : {}),
    ...(l.scope ? { scope: l.scope } : {}),
    status: l.status,
  };
}
