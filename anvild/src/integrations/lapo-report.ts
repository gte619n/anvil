/**
 * Turns the outcome of one autopilot run into a well-formatted markdown "information entry" for lapo:
 * what was done, what's waiting for review, what needs more information, and what was skipped.
 *
 * Pure and deterministic (no clock, no I/O) so it's unit-testable — the caller stamps `runAt` and maps
 * its WorkUnits into `ReportUnit`s. The Supervisor posts the result via LapoClient.createEntry after a
 * run finishes (see runAutopilot). Kept separate from the client so the wording can evolve without
 * touching auth/transport.
 */
import type { AnvilStatus, AutopilotEffort } from "@protocol";

/** One planned/started unit, projected to just what the report renders. */
export interface ReportUnit {
  /** WorkUnit id — used to build a `#p/<id>` deep link to the plan reader when `appBaseUrl` is set. */
  id?: string;
  title: string;
  status: AnvilStatus;
  summary?: string;
  effort?: AutopilotEffort;
  taskCount: number;
  source?: "project" | "label";
  /** Whether this run auto-started a build/pipeline for the unit. */
  started?: boolean;
  /** PR opened for the unit, if any (rare at plan time; present if a fast build already landed one). */
  prUrl?: string;
  /** Open questions for a `needs-clarification` unit (extracted from its plan). */
  questions?: string[];
}

export interface AutopilotReportInput {
  /** ISO timestamp the run finished — stamped by the caller. */
  runAt: string;
  /** How the run was triggered (scheduled nightly vs. a manual "Run autopilot"). */
  trigger: "scheduled" | "manual";
  /** Environments (repo names) the run planned against. */
  environments: string[];
  /** Every unit the run created this pass. */
  units: ReportUnit[];
  /** Tasks skipped because they were already in the pipeline. */
  skipped: number;
  /** How many units were auto-started (build/pipeline). */
  started: number;
  /** This daemon's base URL (self-discovered). When set, the report links back into the Autopilot view
   *  (`<base>/#autopilot` grid + `<base>/#p/<id>` per plan). Omit to render without links. */
  appBaseUrl?: string;
}

export interface AutopilotReport {
  title: string;
  markdown: string;
}

const SIZE_LABEL: Record<string, string> = { xs: "XS", s: "S", m: "M", l: "L", xl: "XL" };

function effortText(e?: AutopilotEffort): string {
  if (!e) return "";
  const size = SIZE_LABEL[e.size] ?? e.size;
  const files = e.filesTouched ? `, ~${e.filesTouched} file${e.filesTouched === 1 ? "" : "s"}` : "";
  return ` _(${size}${files})_`;
}

/** The "open the Autopilot view" links: the daemon's web URL (browser / installed PWA) plus the
 *  `anvil://` custom scheme so an installed native app (iOS/macOS/Android) opens directly — a private
 *  tailnet can't verify Universal/App Links, so the scheme is the reliable native path. */
function openInAnvil(base: string): string {
  return `[✈️ Open in Anvil](${base}/#autopilot) · [app](anvil://autopilot)`;
}

/** Deep link into a specific plan's reader (`<base>/#p/<id>`), or undefined when we can't build one. */
function planLink(base: string | undefined, id: string | undefined): string | undefined {
  return base && id ? `${base}/#p/${encodeURIComponent(id)}` : undefined;
}

/** The inline description of a unit: `**Title** — summary _(effort)_ · N tasks · [PR]` (no leading bullet).
 *  When `base` is set the title links to the plan's reader in Anvil. */
function unitInline(u: ReportUnit, base?: string): string {
  const link = planLink(base, u.id);
  const bits = [link ? `[**${u.title}**](${link})` : `**${u.title}**`];
  const detail = u.summary?.trim();
  if (detail) bits.push(` — ${detail}`);
  bits.push(effortText(u.effort));
  if (u.taskCount > 0) bits.push(` · ${u.taskCount} task${u.taskCount === 1 ? "" : "s"}`);
  if (u.prUrl) bits.push(` · [PR](${u.prUrl})`);
  return bits.join("");
}

/** One `- **Title** — summary _(effort)_` markdown line, with optional PR + plan links. */
function unitLine(u: ReportUnit, base?: string): string {
  return `- ${unitInline(u, base)}`;
}

function section(heading: string, lines: string[]): string {
  return lines.length ? `## ${heading}\n\n${lines.join("\n")}\n` : "";
}

/** The report's H1 / outline top-node title. Fixed, with a plane mark. */
export const REPORT_TITLE = "✈️ Anvil Autopilot Report";

/** `<repos> · <date>` context shown just under the title (the run's who/when lives in the header). */
function reportContext(input: AutopilotReportInput): string {
  const date = input.runAt.slice(0, 10);
  const envLabel = input.environments.length ? input.environments.join(", ") : "no linked environments";
  return `${envLabel} · ${date}`;
}

/** The bolded count fragments (`**3** units planned`, `**1** auto-started`, …), already filtered. */
function reportCounts(input: AutopilotReportInput): string[] {
  const needsInfo = input.units.filter((u) => u.status === "needs-clarification").length;
  return [
    `**${input.units.length}** unit${input.units.length === 1 ? "" : "s"} planned`,
    input.started ? `**${input.started}** auto-started` : null,
    needsInfo ? `**${needsInfo}** need clarification` : null,
    input.skipped ? `**${input.skipped}** task${input.skipped === 1 ? "" : "s"} skipped` : null,
  ].filter((s): s is string => !!s);
}

/**
 * Build the report. Structure:
 *   summary counts → Started → Ready for review → Needs more information → Skipped.
 * Empty sections are omitted. A run with nothing at all still produces a valid (short) entry — the
 * caller decides whether an empty run is worth posting.
 */
export function buildAutopilotReport(input: AutopilotReportInput): AutopilotReport {
  const started = input.units.filter((u) => u.started);
  const needsInfo = input.units.filter((u) => u.status === "needs-clarification");
  // "Ready for review": planned units that weren't auto-started and aren't held for clarification.
  const review = input.units.filter((u) => !u.started && u.status !== "needs-clarification");

  const envLabel = input.environments.length ? input.environments.join(", ") : "no linked environments";

  const openLink = input.appBaseUrl ? openInAnvil(input.appBaseUrl) : "";
  const header = [
    `> Autopilot ${input.trigger} run · ${input.runAt}`,
    `> Environments: ${envLabel}`,
    "",
    reportCounts(input).join(" · ") + ".",
    ...(openLink ? ["", openLink] : []),
    "",
  ].join("\n");

  const needsInfoLines = needsInfo.map((u) => {
    const qs = (u.questions ?? []).map((q) => `  - ${q}`).join("\n");
    const head = `- **${u.title}**${u.summary ? ` — ${u.summary}` : ""}`;
    return qs ? `${head}\n${qs}` : head;
  });

  const body = [
    header,
    section("✅ Started", started.map((u) => unitLine(u, input.appBaseUrl))),
    section("📋 Ready for review", review.map((u) => unitLine(u, input.appBaseUrl))),
    section("❓ Needs more information", needsInfoLines),
    input.skipped
      ? `## ⏭️ Skipped\n\n${input.skipped} task${input.skipped === 1 ? "" : "s"} already in the pipeline (left untouched).\n`
      : "",
    input.units.length === 0 && input.skipped === 0 ? "_Nothing to plan this run — no new candidate tasks._\n" : "",
  ]
    .filter(Boolean)
    .join("\n")
    .trimEnd();

  return { title: REPORT_TITLE, markdown: `${body}\n` };
}

/**
 * Render the same run report as a Logseq-style OUTLINE for lapo's journal (`POST /v1/journal/append`).
 * Journal pages are outlines: every line is a `- ` node and children are TAB-indented (spaces don't
 * nest). The whole report hangs off a single top node folded with a `collapsed:: true` property, so a
 * run adds exactly ONE collapsible bullet to the day's journal rather than a wall of headings.
 *
 *   - Autopilot run — <repos> — <date>
 *   \tcollapsed:: true
 *   \t- <counts>
 *   \t- ✅ Started
 *   \t\t- <unit>
 *   \t- ❓ Needs more information
 *   \t\t- <unit>
 *   \t\t\t- <open question>
 */
export function renderJournalOutline(input: AutopilotReportInput): string {
  const started = input.units.filter((u) => u.started);
  const needsInfo = input.units.filter((u) => u.status === "needs-clarification");
  const review = input.units.filter((u) => !u.started && u.status !== "needs-clarification");

  const lines: string[] = [];
  const node = (depth: number, text: string): void => void lines.push(`${"\t".repeat(depth)}- ${text}`);
  const prop = (depth: number, text: string): void => void lines.push(`${"\t".repeat(depth)}${text}`);

  node(0, `# ${REPORT_TITLE}`); // H1 heading node (Logseq renders `# …` in a block as a title)
  prop(1, "collapsed:: true"); // fold the whole report under the top node
  prop(1, `_${input.trigger} run · ${reportContext(input)}_`);
  if (input.appBaseUrl) node(1, openInAnvil(input.appBaseUrl));
  node(1, reportCounts(input).join(" · ") + ".");

  const group = (label: string, units: ReportUnit[]): void => {
    if (!units.length) return;
    node(1, label);
    for (const u of units) {
      node(2, unitInline(u, input.appBaseUrl));
      if (u.status === "needs-clarification") for (const q of u.questions ?? []) node(3, q);
    }
  };
  group("✅ Started", started);
  group("📋 Ready for review", review);
  group("❓ Needs more information", needsInfo);
  if (input.skipped) node(1, `⏭️ Skipped — ${input.skipped} task${input.skipped === 1 ? "" : "s"} already in the pipeline`);
  if (!input.units.length && !input.skipped) node(1, "Nothing to plan this run — no new candidate tasks.");

  return lines.join("\n") + "\n";
}

/** Extract the bullet list under an `## Open questions` heading from a held unit's plan markdown.
 *  Mirrors `clarificationDoc` in autopilot.ts, which is where those questions are written. */
export function extractOpenQuestions(plan?: string): string[] {
  if (!plan) return [];
  const lines = plan.split("\n");
  const start = lines.findIndex((l) => /^#{1,6}\s+open questions/i.test(l.trim()));
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const t = line.trim();
    if (/^#{1,6}\s/.test(t) || t === "---") break; // next section / rule ends the list
    const m = /^[-*]\s+(.*)$/.exec(t);
    if (m && m[1]!.trim()) out.push(m[1]!.trim());
  }
  // Drop the placeholder line clarificationDoc emits when there are no real questions.
  return out.filter((q) => !/needs (more )?detail before it can be (built|implemented)/i.test(q));
}
