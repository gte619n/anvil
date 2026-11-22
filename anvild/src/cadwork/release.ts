/**
 * The release pack (agent-cad-and-browser spec §4.7). `release_part` writes, only for a part whose gate
 * passes and only after the owner approves the release card:
 *
 *   cad/<part>/release/<part>-<scriptSha7>/
 *     <part>.step                     the design bodies (references left out)
 *     <part>.3mf                      only when the process kind is `fdm`
 *     iso.png front.png top.png right.png
 *     spec-sheet.md                   headed "Not a drawing"
 *     spec-sheet.html                 the same, self-contained (the four views as data: URIs)
 *     manifest.json                   sha256 of every other file + an HMAC over them
 *
 * EXACTLY those files: `verifyRelease` refuses a folder with anything more or less — except the
 * litter a file browser drops into any folder it shows (`.DS_Store`, `._*` AppleDouble files,
 * `Thumbs.db`, see `isOsLitter`), which is ignored when verifying and never listed in a manifest.
 *
 * THE HMAC. HMAC-SHA256 with a per-machine key, `<stateDir>/cadwork/release.key` (32 random bytes,
 * created 0600 on first use), over the canonical JSON of {part, scriptSha, solidcraft, createdAt,
 * files}. The part card's "Released" badge is shown only for a pack whose HMAC this daemon verifies,
 * so a hand-assembled or edited folder is never presented as a release. (Same-user limit, §6: the
 * agent's shell could read the key; the Bash tripwire denies `<stateDir>/cadwork` by name.)
 *
 * ATOMIC (as far as POSIX allows). The pack is built in `release/.tmp-*` beside its final name and
 * renamed into place, so a reader never sees a half-written pack. A RE-release of the same script
 * takes two renames — the old folder is moved aside to `release/.old-*`, then the new one renamed in,
 * then the old one removed — because `rename(2)` cannot replace a non-empty folder and Node has no
 * atomic swap. Between those two renames the folder is briefly absent (the badge then reads "not
 * released" until the next check); if the second rename fails the old folder is put back. A failure
 * leaves nothing new behind.
 *
 * Every user-derived string (part, parameter and reference names, expressions, warnings) is escaped
 * for HTML and for Markdown table cells; the HTML also carries a CSP that allows nothing but its own
 * inline style and data: images.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { GateCheck } from "./gate";
import type { HoleRow } from "./holes";
import type { CadParamInfo } from "./manager";
import type { McpToolResult } from "./mcp-client";
import type { PartRef } from "./partfolder";

export const RELEASE_DIR = "release";
export const MANIFEST = "manifest.json";
export const RELEASE_KEY_FILE = "release.key";
export const VIEWS = ["iso", "front", "top", "right"] as const;
export const NOT_A_DRAWING = "Not a drawing";

export interface ReleaseData {
  part: string;
  scriptSha: string;
  solidcraft: string;
  process: { id: string; kind: string; generalTolerance?: string };
  material?: string;
  /** Sorted ascending, mm. */
  bbox: [number, number, number];
  volume: number;
  bodies: number;
  params: CadParamInfo[];
  /** The full hole table, with centre positions. */
  holes: HoleRow[];
  checks: GateCheck[];
  /** Advisory lines and SolidCraft warnings. */
  advisories: string[];
  references: { name: string; sha256: string }[];
  /** Who approved the numbers ("owner" / "planner"; the release itself confirms agent-initial ones). */
  approvedBy: string;
  createdAt: string;
}

export interface ReleaseManifest {
  schema: 1;
  part: string;
  scriptSha: string;
  solidcraft: string;
  createdAt: string;
  files: Record<string, string>;
  hmac: string;
}

export const releaseFolderName = (part: string, scriptSha: string): string => `${part}-${scriptSha.slice(0, 7)}`;
/** Files an OS file browser leaves in a folder it shows: never part of a pack, ignored when verifying. */
export const isOsLitter = (name: string): boolean => name === ".DS_Store" || name.startsWith("._") || name.toLowerCase() === "thumbs.db";
export const releaseFolder = (ref: PartRef, scriptSha: string): string => join(ref.dir, RELEASE_DIR, releaseFolderName(ref.part, scriptSha));

/** The files a pack must hold, by process kind (manifest.json included). */
export function expectedReleaseFiles(part: string, kind: string): string[] {
  return [`${part}.step`, ...(kind === "fdm" ? [`${part}.3mf`] : []), ...VIEWS.map((v) => `${v}.png`), "spec-sheet.md", "spec-sheet.html", MANIFEST].sort();
}

/** This machine's release key: created (0600, 32 random bytes) the first time it is needed. */
export function releaseKey(stateDir: string): Buffer {
  const dir = join(stateDir, "cadwork");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, RELEASE_KEY_FILE);
  if (!existsSync(path)) {
    try {
      writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  chmodSync(path, 0o600);
  const key = readFileSync(path);
  if (key.length < 32) throw new Error(`${path} is not a release key (it holds ${key.length} bytes)`);
  return key;
}

const sha256 = (b: string | Uint8Array): string => createHash("sha256").update(b).digest("hex");
const canonical = (m: Omit<ReleaseManifest, "hmac" | "schema">): string =>
  JSON.stringify({ part: m.part, scriptSha: m.scriptSha, solidcraft: m.solidcraft, createdAt: m.createdAt, files: Object.keys(m.files).sort().map((k) => [k, m.files[k]]) });
const hmacOf = (key: Buffer, m: Omit<ReleaseManifest, "hmac" | "schema">): string => createHmac("sha256", key).update(canonical(m)).digest("hex");

export type ReleaseVerdict = { ok: true; manifest: ReleaseManifest } | { ok: false; reason: string };

/**
 * Does this folder hold a release pack this machine made, unaltered? Exactly the manifest's files,
 * each a regular file whose sha256 matches, the folder named for the manifest's part and script, and
 * an HMAC that verifies with this machine's key.
 */
export function verifyRelease(dir: string, key: Buffer): ReleaseVerdict {
  const no = (reason: string): ReleaseVerdict => ({ ok: false, reason });
  let m: ReleaseManifest;
  try {
    if (lstatSync(dir).isSymbolicLink()) return no("the folder is a symbolic link");
    m = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
  } catch (e) {
    return no(`no readable ${MANIFEST}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!m || m.schema !== 1 || typeof m.part !== "string" || typeof m.scriptSha !== "string" || typeof m.hmac !== "string" || !m.files || typeof m.files !== "object") return no(`${MANIFEST} is not a release manifest`);
  if (basename(dir) !== releaseFolderName(m.part, m.scriptSha)) return no("the folder is not named for the part and script the manifest describes");
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return no(`the folder cannot be read: ${e instanceof Error ? e.message : String(e)}`);
  }
  const listed = Object.keys(m.files).sort();
  if (listed.some(isOsLitter)) return no(`${MANIFEST} lists a file a pack never holds`);
  const real = entries.filter((e) => !isOsLitter(e.name));
  const present = real.filter((e) => e.name !== MANIFEST).map((e) => e.name).sort();
  if (JSON.stringify(listed) !== JSON.stringify(present)) return no("the folder's files are not exactly the ones the manifest lists");
  for (const e of real) if (!e.isFile()) return no(`${e.name} is not a regular file`);
  for (const name of listed) {
    if (sha256(readFileSync(join(dir, name))) !== m.files[name]) return no(`${name} does not match its sha256 in the manifest`);
  }
  const want = Buffer.from(hmacOf(key, m), "hex");
  const got = Buffer.from(/^[0-9a-f]{64}$/.test(m.hmac) ? m.hmac : "", "hex");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return no("the manifest's HMAC does not verify on this machine");
  return { ok: true, manifest: m };
}

// ── the spec sheet ────────────────────────────────────────────────────────────────────────────────

const num = (v: number): string => String(Math.round(v * 1e4) / 1e4);
const show = (v: number | string): string => (typeof v === "number" ? num(v) : v);
/** Escape for HTML text and attribute values. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
/** One Markdown table cell (or inline text): no raw HTML, no pipe, no line break, no code fence. */
export function mdText(s: string): string {
  // Backslashes first, so an input ending in "\" cannot turn the escape of a following "|" or "`" into a literal.
  return escapeHtml(s).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/`/g, "\\`").replace(/[\r\n]+/g, " ");
}

/** One row per distinct diameter (the spec's hole table): count, kinds, counterbores and centres. */
export function holeRowsByDiameter(holes: HoleRow[]): { diameter: number; count: number; kinds: string; counterbore: string; positions: string }[] {
  const by = new Map<number, HoleRow[]>();
  for (const h of holes) by.set(h.diameter, [...(by.get(h.diameter) ?? []), h]);
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([diameter, rows]) => ({
      diameter,
      count: rows.reduce((s, r) => s + r.count, 0),
      kinds: [...new Set(rows.map((r) => `${r.kind}, depth ${num(r.depth)}`))].join("; "),
      counterbore: [...new Set(rows.flatMap((r) => (r.counterbore ?? []).map((c) => `⌀${num(c.diameter)} × ${num(c.depth)}`)))].join("; ") || "—",
      positions: rows.flatMap((r) => r.positions ?? []).map((p) => `(${p.map(num).join(", ")})`).join(" ") || "—",
    }));
}

interface Sheet {
  facts: [string, string][];
  params: string[][];
  holes: string[][];
  checks: string[][];
  advisories: string[];
  references: string[][];
}
function sheetOf(d: ReleaseData): Sheet {
  return {
    facts: [
      ["Part", d.part],
      ["Script sha", d.scriptSha],
      ["SolidCraft version", d.solidcraft],
      ["Process", `${d.process.id} (${d.process.kind})`],
      ["Material", d.material ?? "not specified"],
      ["General tolerance", d.process.generalTolerance ?? "not specified"],
      ["Overall dimensions (mm, sorted)", d.bbox.map(num).join(" × ")],
      ["Volume (mm³)", num(d.volume)],
      ["Bodies", String(d.bodies)],
      ["Numbers approved by", d.approvedBy],
      ["Released", d.createdAt],
    ],
    params: d.params.map((p) => [p.name, p.expression, num(p.value), p.unit || "—"]),
    holes: holeRowsByDiameter(d.holes).map((h) => [num(h.diameter), String(h.count), h.kinds, h.counterbore, h.positions]),
    checks: d.checks.filter((c) => c.hard).map((c) => [c.id, show(c.expected), show(c.measured), c.ok ? "ok" : "FAIL"]),
    advisories: d.advisories,
    references: d.references.map((r) => [r.name, r.sha256]),
  };
}

export function specSheetMarkdown(d: ReleaseData): string {
  const s = sheetOf(d);
  const table = (head: string[], rows: string[][]): string =>
    rows.length ? [`| ${head.join(" | ")} |`, `|${head.map(() => " --- |").join("")}`, ...rows.map((r) => `| ${r.map(mdText).join(" | ")} |`)].join("\n") : "_none_";
  return [
    `# ${NOT_A_DRAWING}`,
    "",
    `Release spec sheet for **${mdText(d.part)}**. The numbers below were measured from the model by the daemon; this sheet is not a manufacturing drawing.`,
    "",
    table(["", ""], s.facts.map(([k, v]) => [k, v])),
    "",
    "## Parameters",
    "",
    table(["Name", "Expression", "Value", "Unit"], s.params),
    "",
    "## Holes",
    "",
    table(["Diameter (mm)", "Count", "Kind", "Counterbore", "Centre positions (x, y, z mm)"], s.holes),
    "",
    "## Gate checks",
    "",
    table(["Check", "Expected", "Measured", "Result"], s.checks),
    "",
    "## Advisory warnings",
    "",
    s.advisories.length ? s.advisories.map((a) => `- ${mdText(a)}`).join("\n") : "_none_",
    "",
    "## References",
    "",
    table(["File", "sha256"], s.references),
    "",
    "## Views",
    "",
    ...VIEWS.map((v) => `![${v}](${v}.png)`),
    "",
  ].join("\n");
}

export function specSheetHtml(d: ReleaseData, views: Record<(typeof VIEWS)[number], Buffer>): string {
  const s = sheetOf(d);
  const e = escapeHtml;
  const table = (head: string[], rows: string[][]): string =>
    rows.length ? `<table><thead><tr>${head.map((h) => `<th>${e(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${e(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>` : "<p><em>none</em></p>";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(NOT_A_DRAWING)} — ${e(d.part)}</title>
<style>
body{font:14px/1.45 -apple-system,system-ui,sans-serif;margin:24px;color:#111}
h1{font-size:28px;margin:0 0 4px;color:#b00020}
h2{font-size:17px;margin:22px 0 8px}
table{border-collapse:collapse;width:100%;margin:6px 0}
th,td{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
th{background:#f3f3f3}
.views{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.views figure{margin:0}.views img{width:100%;border:1px solid #ddd}
@media print{body{margin:10mm}}
</style></head><body>
<h1>${e(NOT_A_DRAWING)}</h1>
<p>Release spec sheet for <b>${e(d.part)}</b>. The numbers below were measured from the model by the daemon; this sheet is not a manufacturing drawing.</p>
${table(["", ""], s.facts.map(([k, v]) => [k, v]))}
<h2>Parameters</h2>
${table(["Name", "Expression", "Value", "Unit"], s.params)}
<h2>Holes</h2>
${table(["Diameter (mm)", "Count", "Kind", "Counterbore", "Centre positions (x, y, z mm)"], s.holes)}
<h2>Gate checks</h2>
${table(["Check", "Expected", "Measured", "Result"], s.checks)}
<h2>Advisory warnings</h2>
${s.advisories.length ? `<ul>${s.advisories.map((a) => `<li>${e(a)}</li>`).join("")}</ul>` : "<p><em>none</em></p>"}
<h2>References</h2>
${table(["File", "sha256"], s.references)}
<h2>Views</h2>
<div class="views">${VIEWS.map((v) => `<figure><img alt="${e(v)}" src="data:image/png;base64,${views[v].toString("base64")}"><figcaption>${e(v)}</figcaption></figure>`).join("")}</div>
</body></html>
`;
}

// ── writing a pack ────────────────────────────────────────────────────────────────────────────────

type Call = (tool: string, args: Record<string, unknown>) => Promise<McpToolResult>;
let seq = 0;

/**
 * Write the pack through the part's own process (call this inside its queue slot, so nothing changes
 * between the STEP and the pictures). Returns the folder and its files (absolute). Throws, leaving
 * nothing behind, when any file cannot be made.
 */
export async function writeReleasePack(call: Call, ref: PartRef, data: ReleaseData, designBodies: string[], key: Buffer): Promise<{ dir: string; files: string[] }> {
  if (designBodies.length === 0) throw new Error("the design has no bodies to release");
  const root = join(ref.dir, RELEASE_DIR);
  if (existsSync(root)) {
    if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) throw new Error(`cad/${ref.part}/${RELEASE_DIR} is a symbolic link; it must be a real folder in the part`);
  } else mkdirSync(root, { recursive: true });
  const final = releaseFolder(ref, data.scriptSha);
  const tmp = join(root, `.tmp-${process.pid}-${Date.now()}-${++seq}`);
  mkdirSync(tmp);
  try {
    const need = async (what: string, tool: string, args: Record<string, unknown>, path: string): Promise<void> => {
      const r = await call(tool, { ...args, path });
      if (r.isError || !existsSync(path) || lstatSync(path).size === 0) throw new Error(`${what} could not be written: ${r.text.slice(0, 300) || "no file"}`);
    };
    await need("the STEP", "export", { format: "step", bodies: designBodies }, join(tmp, `${ref.part}.step`));
    if (data.process.kind === "fdm") await need("the 3MF", "export", { format: "3mf", bodies: designBodies }, join(tmp, `${ref.part}.3mf`));
    const views = {} as Record<(typeof VIEWS)[number], Buffer>;
    // iso last: a headless process starts at iso, so the agent's next screenshot is where it began.
    for (const v of ["front", "top", "right", "iso"] as const) {
      const p = join(tmp, `${v}.png`);
      await need(`the ${v} view`, "screenshot", { view: v, width: 960, height: 600, grid: false, axes: false }, p);
      views[v] = readFileSync(p);
    }
    writeFileSync(join(tmp, "spec-sheet.md"), specSheetMarkdown(data));
    writeFileSync(join(tmp, "spec-sheet.html"), specSheetHtml(data, views));
    const files: Record<string, string> = {};
    for (const name of readdirSync(tmp).sort()) if (!isOsLitter(name)) files[name] = sha256(readFileSync(join(tmp, name)));
    const body = { part: ref.part, scriptSha: data.scriptSha, solidcraft: data.solidcraft, createdAt: data.createdAt, files };
    const manifest: ReleaseManifest = { schema: 1, ...body, hmac: hmacOf(key, body) };
    writeFileSync(join(tmp, MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
    // Into place: an earlier pack of the same script is moved aside, the new one renamed in, the old
    // one removed (two renames — see the header; a failed second rename puts the old one back).
    let old: string | undefined;
    if (existsSync(final)) {
      old = join(root, `.old-${process.pid}-${Date.now()}-${++seq}`);
      renameSync(final, old);
    }
    try {
      renameSync(tmp, final);
    } catch (e) {
      if (old) renameSync(old, final);
      throw e;
    }
    if (old) rmSync(old, { recursive: true, force: true });
    return { dir: final, files: readdirSync(final).filter((n) => !isOsLitter(n)).sort().map((n) => join(final, n)) };
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}
