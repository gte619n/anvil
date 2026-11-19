/**
 * Screening a SolidCraft design script before anything replays it.
 *
 * A `design.json` is a list of SolidCraft commands, and SolidCraft runs whatever commands it is
 * given: on 0.44.1 a script carrying `parameters.export {path}`, `file.save`, `file.export_step` or
 * `timeline.export_script {path}` wrote its target wherever it pointed, both under `eval` and when
 * loaded with `mcp --in` (the `--allow-path` sandbox does not cover a script loaded at start). A
 * design file comes from a repository, or from an agent's worktree, so it is untrusted input.
 *
 * The rule here is an allow list, not a deny list: a design script may contain ONLY the command
 * ids SolidCraft's own `timeline.export_script` writes. Those were established with the real
 * 0.44.1 binary by exporting designs with parameters, every feature of the reference plate, an
 * imported STEP reference, units, document metadata and a custom material (see `ALLOWED_COMMANDS`).
 * On top of that, no parameter may name a file or a place:
 *
 *   - a key named `path`, `dir`, `filename`, `url`, `out` or `output` (any depth, any letter case)
 *     may hold only numbers — real scripts do carry `dir: [0, 0, 1]` vectors;
 *   - no string value may be an absolute path, contain a `..` path segment, or contain a URL
 *     scheme — checked after Unicode normalisation and percent-decoding;
 *   - a key named `file` must be a bare file name (no separators).
 *
 * Two documented exceptions, both inside a `timeline.add` step whose feature is an import:
 * `feature.file` is the reference's bare file name, and `feature.step` is the embedded STEP text,
 * which is not inspected (it is data SolidCraft parses, not a place it writes to).
 *
 * DEPENDENCY-FREE on purpose: the replay gate (Track B), the CAD process manager's load and
 * `verify` (Track A) all call this one function. Do not import anything into this file.
 */

/** A design script is refused above this size (it embeds STEP references of up to 50 MB). */
export const MAX_SCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 256;

/**
 * Every command id `timeline.export_script` was seen to write (SolidCraft 0.44.1). Nothing else is
 * a design step. A SolidCraft release that exports a new id needs it added here, deliberately.
 */
export const ALLOWED_COMMANDS: readonly string[] = [
  "parameters.add", // one per user parameter
  "timeline.add", // one per feature, including an imported reference (feature.type "import")
  "document.units",
  "document.metadata.set",
  "material.create", // a material the design defines itself
  "material.assign",
  // An imported reference is a component with one grounded occurrence:
  "component.create",
  "component.metadata.set",
  "occurrence.ground",
  "occurrence.move",
];
const ALLOWED = new Set(ALLOWED_COMMANDS);

/** Keys that name a file or a place. They may hold numbers only. */
export const FORBIDDEN_KEYS: readonly string[] = ["path", "dir", "filename", "url", "out", "output"];
const FORBIDDEN = new Set(FORBIDDEN_KEYS);

export type ScreenResult =
  | { ok: true }
  | {
      ok: false;
      /** One sentence a person can act on. */
      reason: string;
      /** The index of the offending step in `commands`, or -1 for a problem with the file as a whole. */
      index: number;
      /** That step's command id, or "" when there is none. */
      command: string;
    };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Undo the disguises a path can wear: compatibility forms (fullwidth dots, dot leaders) and percent-encoding. */
function normalise(s: string): string {
  let out = s.normalize("NFKC");
  for (let i = 0; i < 3 && /%[0-9a-fA-F]{2}/.test(out); i++) {
    try {
      const next = decodeURIComponent(out);
      if (next === out) break;
      out = next.normalize("NFKC");
    } catch {
      // Not valid percent-encoding as a whole: decode the well-formed dots and separators only.
      out = out.replace(/%2e/gi, ".").replace(/%2f/gi, "/").replace(/%5c/gi, "\\");
      break;
    }
  }
  return out.replace(/\\/g, "/");
}

/** Why this string may not appear in a design script, or undefined. */
export function unsafeString(raw: string): string | undefined {
  const s = normalise(raw).trim();
  if (s.includes("\0")) return "contains a NUL character";
  if (/^\/|^~[^/\s]*(\/|$)|^[a-zA-Z]:\//.test(s)) return "is an absolute path";
  if (s.split("/").some((seg) => seg.trim() === "..")) return "contains a `..` path segment";
  if (/[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s) || /^(file|data|javascript|vbscript|mailto|ftp|sftp|smb|afp|nfs|ssh|https?):/i.test(s)) return "contains a URL";
  return undefined;
}

/** A bare file name: no separators, not `.` or `..`, nothing hidden by encoding. */
export function isBareFileName(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 255) return false;
  const s = normalise(raw);
  return !s.includes("/") && !s.includes("\0") && s !== "." && s !== ".." && s.trim() === s && unsafeString(raw) === undefined;
}

const short = (s: string): string => (s.length > 60 ? `${s.slice(0, 57)}…` : s);

/** Numbers, booleans and null, however nested in arrays: what a forbidden key may still hold. */
function numbersOnly(v: unknown, depth = 0): boolean {
  if (v === null || typeof v === "number" || typeof v === "boolean") return true;
  if (Array.isArray(v) && depth < MAX_DEPTH) return v.every((x) => numbersOnly(x, depth + 1));
  return false;
}

/** Walk one step's params. Returns the reason it is refused, or undefined. */
function screenParams(command: string, params: Record<string, unknown>): string | undefined {
  const feature = command === "timeline.add" && isRecord(params.feature) ? params.feature : undefined;
  const importFeature = feature && feature.type === "import" ? feature : undefined;
  if (importFeature) {
    if (importFeature.file !== undefined && !isBareFileName(importFeature.file)) return "`feature.file` of an import must be a bare file name";
    if (importFeature.step !== undefined && typeof importFeature.step !== "string") return "`feature.step` of an import must be the STEP text";
  }
  const stack: { value: unknown; where: string; depth: number; owner?: Record<string, unknown>; key?: string }[] = [{ value: params, where: "params", depth: 0 }];
  while (stack.length) {
    const { value, where, depth, owner, key } = stack.pop()!;
    if (depth > MAX_DEPTH) return `\`${where}\` is nested too deeply`;
    if (typeof value === "string") {
      if (owner === importFeature && importFeature && key === "step") continue; // embedded STEP text: data, not a place
      const why = unsafeString(value);
      if (why) return `\`${where}\` ${why} (${JSON.stringify(short(value))})`;
      if (key !== undefined && key.normalize("NFKC").toLowerCase() === "file" && !isBareFileName(value)) return `\`${where}\` must be a bare file name`;
      continue;
    }
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i], where: `${where}[${i}]`, depth: depth + 1, key });
      continue;
    }
    if (isRecord(value)) {
      for (const k of Object.keys(value)) {
        const lower = k.normalize("NFKC").trim().toLowerCase();
        const at = `${where}.${k}`;
        if (FORBIDDEN.has(lower) && !numbersOnly(value[k])) return `\`${at}\` names a file or a place, which a design script may not do`;
        stack.push({ value: value[k], where: at, depth: depth + 1, owner: value, key: k });
      }
    }
  }
  return undefined;
}

/**
 * May this (already parsed) design script be replayed? `{ ok: true }`, or the first reason it may
 * not, with the index and id of the offending step.
 */
export function screenScript(script: unknown): ScreenResult {
  const whole = (reason: string): ScreenResult => ({ ok: false, reason, index: -1, command: "" });
  if (!isRecord(script)) return whole("a design script must be an object with a `commands` list");
  for (const k of Object.keys(script)) if (k !== "about" && k !== "commands") return whole(`unexpected top-level key \`${short(k)}\`; a design script has only \`about\` and \`commands\``);
  if (script.about !== undefined && !isRecord(script.about)) return whole("`about` must be an object");
  const commands = script.commands;
  if (!Array.isArray(commands)) return whole("`commands` must be a list");
  for (let index = 0; index < commands.length; index++) {
    const step: unknown = commands[index];
    const id = isRecord(step) && typeof step.command === "string" ? step.command : "";
    const refuse = (reason: string): ScreenResult => ({ ok: false, reason: `step ${index + 1}${id ? ` (${short(id)})` : ""}: ${reason}`, index, command: id });
    if (!isRecord(step)) return refuse("a step must be an object { command, params }");
    if (typeof step.command !== "string" || !step.command) return refuse("a step needs a `command` id");
    for (const k of Object.keys(step)) if (k !== "command" && k !== "params") return refuse(`unexpected key \`${short(k)}\` beside \`command\` and \`params\``);
    if (!ALLOWED.has(step.command)) return refuse("this command is not one SolidCraft writes into a design script, so it is not replayed");
    if (!isRecord(step.params)) return refuse("`params` must be an object");
    const why = screenParams(step.command, step.params);
    if (why) return refuse(why);
  }
  return { ok: true };
}

/**
 * The same check on the file's text: the size cap first, then JSON, then `screenScript`. Returns
 * the parsed script when it passes, so a caller parses once.
 */
export function screenScriptText(text: string): ({ ok: true; script: { about?: Record<string, unknown>; commands: { command: string; params: Record<string, unknown> }[] } }) | Extract<ScreenResult, { ok: false }> {
  // UTF-8 never takes fewer bytes than UTF-16 code units, so the cheap test settles most files.
  if (text.length > MAX_SCRIPT_BYTES || new TextEncoder().encode(text.length > MAX_SCRIPT_BYTES / 4 ? text : "").length > MAX_SCRIPT_BYTES) {
    return { ok: false, reason: `the design script is larger than ${MAX_SCRIPT_BYTES / (1024 * 1024)} MB`, index: -1, command: "" };
  }
  let script: unknown;
  try {
    script = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `the design script is not JSON (${e instanceof Error ? e.message.slice(0, 120) : "parse error"})`, index: -1, command: "" };
  }
  const r = screenScript(script);
  return r.ok ? { ok: true, script: script as never } : r;
}
