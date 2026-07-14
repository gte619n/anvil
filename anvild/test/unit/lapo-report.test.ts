/**
 * The autopilot→lapo run report is pure and deterministic, so its wording and section logic can be
 * pinned here without spinning up a daemon or a lapo. Covers the three buckets a run produces —
 * started, ready-for-review, needs-more-information — plus the skipped tally and the open-questions
 * extraction that feeds the "needs more information" section from a held unit's plan.
 */
import { test, expect } from "bun:test";
import { buildAutopilotReport, renderJournalOutline, extractOpenQuestions, type ReportUnit } from "../../src/integrations/lapo-report";

const unit = (o: Partial<ReportUnit>): ReportUnit => ({ title: "Do a thing", status: "planned", taskCount: 1, ...o });

test("buckets units into started / review / needs-more-info", () => {
  const { title, markdown } = buildAutopilotReport({
    runAt: "2026-07-07T02:00:00.000Z",
    trigger: "scheduled",
    environments: ["anvil", "lapo"],
    skipped: 4,
    started: 1,
    units: [
      unit({ title: "Wire push retries", status: "building", started: true, summary: "add backoff", effort: { size: "m", filesTouched: 3 } }),
      unit({ title: "Refactor store", status: "planned", summary: "split the file" }),
      unit({ title: "Add export button", status: "needs-clarification", summary: "which format?", questions: ["CSV or JSON?", "Where does it live?"] }),
    ],
  });

  expect(title).toBe("✈️ Anvil Autopilot Report");
  // Summary counts.
  expect(markdown).toContain("**3** units planned");
  expect(markdown).toContain("**1** auto-started");
  expect(markdown).toContain("**1** need clarification");
  expect(markdown).toContain("**4** tasks skipped");
  // Sections present and each unit in the right one.
  expect(markdown).toContain("## ✅ Started");
  expect(markdown).toContain("Wire push retries");
  expect(markdown).toContain("_(M, ~3 files)_");
  expect(markdown).toContain("## 📋 Ready for review");
  expect(markdown).toContain("Refactor store");
  expect(markdown).toContain("## ❓ Needs more information");
  expect(markdown).toContain("- CSV or JSON?");
  expect(markdown).toContain("## ⏭️ Skipped");
  // A started unit must not also appear under review.
  const review = markdown.slice(markdown.indexOf("## 📋 Ready for review"), markdown.indexOf("## ❓"));
  expect(review).not.toContain("Wire push retries");
});

test("appBaseUrl adds an Open-in-Anvil link and per-plan deep links", () => {
  const base = "https://mymac.ts.net";
  const doc = buildAutopilotReport({
    runAt: "2026-07-07T02:00:00.000Z",
    trigger: "scheduled",
    environments: ["anvil"],
    skipped: 0,
    started: 1,
    appBaseUrl: base,
    units: [unit({ id: "wu_1", title: "Ship it", status: "building", started: true })],
  });
  expect(doc.markdown).toContain(`[✈️ Open in Anvil](${base}/#autopilot)`);
  expect(doc.markdown).toContain(`[**Ship it**](${base}/#p/wu_1)`);

  const outline = renderJournalOutline({
    runAt: "2026-07-07T02:00:00.000Z",
    trigger: "scheduled",
    environments: ["anvil"],
    skipped: 0,
    started: 1,
    appBaseUrl: base,
    units: [unit({ id: "wu_1", title: "Ship it", status: "building", started: true })],
  });
  expect(outline).toContain(`\t- [✈️ Open in Anvil](${base}/#autopilot)`);
  expect(outline).toContain(`\t\t- [**Ship it**](${base}/#p/wu_1)`);
});

test("without appBaseUrl there are no deep links", () => {
  const doc = buildAutopilotReport({
    runAt: "2026-07-07T02:00:00.000Z",
    trigger: "scheduled",
    environments: ["anvil"],
    skipped: 0,
    started: 1,
    units: [unit({ id: "wu_1", title: "Ship it", status: "building", started: true })],
  });
  expect(doc.markdown).not.toContain("Open in Anvil");
  expect(doc.markdown).not.toContain("#p/");
});

test("omits empty sections and notes a wholly-empty run", () => {
  const { markdown } = buildAutopilotReport({
    runAt: "2026-07-07T02:00:00.000Z",
    trigger: "manual",
    environments: ["anvil"],
    skipped: 0,
    started: 0,
    units: [],
  });
  expect(markdown).not.toContain("## ✅ Started");
  expect(markdown).not.toContain("## ⏭️ Skipped");
  expect(markdown).toContain("Nothing to plan this run");
});

test("a PR link renders when present", () => {
  const { markdown } = buildAutopilotReport({
    runAt: "2026-07-07T02:00:00.000Z",
    trigger: "scheduled",
    environments: ["anvil"],
    skipped: 0,
    started: 1,
    units: [unit({ title: "Ship it", status: "review", started: true, prUrl: "https://example.com/pr/1" })],
  });
  expect(markdown).toContain("[PR](https://example.com/pr/1)");
});

test("renderJournalOutline folds the report under one collapsed, TAB-nested node", () => {
  const md = renderJournalOutline({
    runAt: "2026-07-07T02:00:00.000Z",
    trigger: "scheduled",
    environments: ["anvil"],
    skipped: 2,
    started: 1,
    units: [
      unit({ title: "Wire push retries", status: "building", started: true, summary: "add backoff" }),
      unit({ title: "Add export button", status: "needs-clarification", summary: "which format?", questions: ["CSV or JSON?"] }),
    ],
  });
  const lines = md.split("\n");
  // Top node is a bullet at depth 0; the fold property + everything else are TAB-indented beneath it.
  expect(lines[0]).toBe("- # ✈️ Anvil Autopilot Report");
  expect(lines[1]).toBe("\tcollapsed:: true");
  // The run/timestamp line must be a real child BULLET at depth 1 (a bare `\t…` line glues onto the
  // title block and shows at the first level instead of nesting under it).
  expect(lines[2]).toBe("\t- _scheduled run · anvil · 2026-07-07_");
  expect(md).toContain("\t- ✅ Started");
  expect(md).toContain("\t\t- **Wire push retries** — add backoff");
  expect(md).toContain("\t- ❓ Needs more information");
  expect(md).toContain("\t\t\t- CSV or JSON?"); // open question nested a further level under its unit
  expect(md).toContain("\t- ⏭️ Skipped — 2 tasks already in the pipeline");
  // Nesting must use tabs, never leading spaces (spaces don't nest in lapo's outline).
  expect(md.split("\n").every((l) => !/^ +\S/.test(l))).toBe(true);
});

test("extractOpenQuestions reads the bullet list under the heading and drops the placeholder", () => {
  const plan = `# Needs clarification

This is underspecified.

## Open questions

- What is the source of truth?
- Where should it live?

---

## Draft plan

- something`;
  expect(extractOpenQuestions(plan)).toEqual(["What is the source of truth?", "Where should it live?"]);
  expect(extractOpenQuestions("no heading here")).toEqual([]);
  expect(extractOpenQuestions("## Open questions\n\n- (The task needs more detail before it can be implemented.)")).toEqual([]);
});
