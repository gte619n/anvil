/**
 * Screening a SolidCraft design script before anything replays it.
 *
 * A `design.json` is a list of SolidCraft commands, and SolidCraft runs whatever commands it is
 * given: on 0.44.1 a script carrying `parameters.export {path}`, `file.save`, `file.export_step` or
 * `timeline.export_script {path}` wrote its target wherever it pointed, both under `eval` and when
 * loaded with `mcp --in` (the `--allow-path` sandbox does not cover a script loaded at start). A
 * script can also make SolidCraft READ a file: a sketch text's `font` is opened, with `~` and
 * `%VAR%` expanded. A design file comes from a repository, or from an agent's worktree, so it is
 * untrusted input.
 *
 * The rules:
 *
 *   1. COMMANDS are an allow list: only the ids SolidCraft's own `timeline.export_script` writes.
 *      They were enumerated with the real 0.44.1 binary (test/fixtures/solidcraft-export-ids/) and
 *      each id's parameter schema was read to confirm it takes no file, URL or code.
 *   2. A key named `path`, `dir`, `filename`, `url`, … (FORBIDDEN_KEYS; any depth, any letter case)
 *      may hold only numbers — real scripts do carry `dir: [0, 0, 1]` vectors and occurrence paths.
 *   3. A key that may name a file to open — `font`, `image`, `texture`, `source`, … (NAME_KEYS) —
 *      may hold only a plain name: letters, digits, space, `-`, `_`, `.`. A `file` key must be a
 *      bare file name.
 *   4. NO string anywhere may be an absolute path, start with `~`, contain a `..` path segment, a
 *      URL, or an environment reference (`%NAME%`, `$NAME`, `${…}`) — checked after Unicode
 *      normalisation and percent-decoding.
 *
 * Embedded data is exempt from 2–4 because it is data SolidCraft parses, not a place it goes: the
 * STEP text of an import (`feature.step`) and the vertex and triangle arrays of a mesh import
 * (`feature.meshes[].positions`, `.triangles`, which must hold numbers only).
 *
 * COST. This runs on the daemon's main thread on untrusted text, so every check is linear in the
 * input and the input is capped: no regular expression is run over a script's strings, a string is
 * at most 1 MB, the strings inspected total at most 8 MB, and a script has at most 200,000 nodes
 * nested at most 64 deep. Every fragment of the script quoted in a refusal is cut to 80 characters
 * and the refusal to 300.
 *
 * DEPENDENCY-FREE on purpose: the replay gate (Track B), the CAD process manager's load and
 * `verify` (Track A) all call this one function. Do not import anything into this file.
 */

/** A design script file is refused above this size (it may embed STEP references of up to 50 MB). */
export const MAX_SCRIPT_BYTES = 64 * 1024 * 1024;
/** One string, other than embedded data. */
export const MAX_STRING_CHARS = 1024 * 1024;
/** All inspected strings and keys together. Real scripts hold a few kilobytes outside embedded data. */
export const MAX_INSPECTED_CHARS = 8 * 1024 * 1024;
/** Objects, arrays and values, not counting embedded data. */
export const MAX_NODES = 200_000;
/** Nesting below a step's `params`. Real exports reach about 8. */
export const MAX_DEPTH = 64;
export const MAX_KEY_CHARS = 256;
const MAX_FRAGMENT = 80;
const MAX_REASON = 300;

/**
 * Every command id `timeline.export_script` was seen to write by SolidCraft 0.44.1, across the
 * scenarios in test/fixtures/solidcraft-export-ids/generate.ts (the evidence is `export-ids.json`
 * beside it, with each id's parameter schema). Nothing else is a design step. One id that export
 * DOES write is left out on purpose: `component.insert_design`, which takes a file path.
 */
export const ALLOWED_COMMANDS: readonly string[] = [
  "parameters.add", // one per user parameter
  "timeline.add", // one per feature, of every kind, including imports
  "document.units",
  "document.metadata.set",
  "material.create", // a material the design defines itself
  "material.assign",
  "sheet.manage_rules", // a sheet-metal rule the design defines
  "plastic.manage_rules",
  "plastic.assign_rule",
  // Assemblies: components and where they are placed…
  "component.create",
  "component.metadata.set",
  "occurrence.copy",
  "occurrence.ground",
  "occurrence.move",
  // …and how they are joined.
  "joint.origin",
  "joint.create",
  "joint.limits",
  "joint.motion_link", // also what gears, screws and racks are written as
  // Configurations.
  "config.column",
  "config.row",
  "config.activate",
];
const ALLOWED = new Set(ALLOWED_COMMANDS);

/** Keys that name a file or a place. They may hold numbers only. */
export const FORBIDDEN_KEYS: readonly string[] = ["path", "dir", "filename", "url", "out", "output", "uri", "href", "src", "folder", "directory", "cwd"];
const FORBIDDEN = new Set(FORBIDDEN_KEYS);
/** Keys whose text SolidCraft may use to open a file. Their strings must be plain names. */
export const NAME_KEYS: readonly string[] = ["font", "image", "texture", "template", "source", "icon", "plugin", "script", "module", "include", "shader"];
const NAMES = new Set(NAME_KEYS);

export type ScreenResult =
  | { ok: true }
  | {
      ok: false;
      /** One sentence a person can act on. At most 300 characters. */
      reason: string;
      /** The index of the offending step in `commands`, or -1 for a problem with the file as a whole. */
      index: number;
      /** That step's command id (at most 80 characters), or "" when there is none. */
      command: string;
    };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A piece of the script, safe to show: cut to 80 characters. */
const frag = (s: string): string => (s.length > MAX_FRAGMENT ? `${s.slice(0, MAX_FRAGMENT - 1)}…` : s);
const cut = (s: string): string => (s.length > MAX_REASON ? `${s.slice(0, MAX_REASON - 1)}…` : s);

const isLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const hexValue = (c: number): number => (isDigit(c) ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1);

/** Does the string need a closer look? One pass; plain names and numbers return false. */
function interesting(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // NUL, $, %, ., /, :, \, ~, and anything outside ASCII.
    if (c === 0 || c === 36 || c === 37 || c === 46 || c === 47 || c === 58 || c === 92 || c === 126 || c > 126) return true;
  }
  return false;
}

/** `%XX` → the character, for ASCII only, in one pass. Returns the input when nothing decodes. */
function percentDecodeOnce(s: string): string {
  let at = s.indexOf("%");
  if (at < 0) return s;
  const out: string[] = [];
  let from = 0;
  while (at >= 0) {
    const hi = at + 2 < s.length ? hexValue(s.charCodeAt(at + 1)) : -1;
    const lo = hi >= 0 ? hexValue(s.charCodeAt(at + 2)) : -1;
    if (hi >= 0 && lo >= 0 && hi * 16 + lo < 128) {
      out.push(s.slice(from, at), String.fromCharCode(hi * 16 + lo));
      from = at + 3;
      at = s.indexOf("%", from);
    } else {
      at = s.indexOf("%", at + 1);
    }
  }
  if (from === 0) return s;
  out.push(s.slice(from));
  return out.join("");
}

/** `%NAME%`, `$NAME`, `${…}`, `$(…)`: something a program may expand into a path. One pass. */
function hasEnvReference(s: string): boolean {
  for (let i = s.indexOf("$"); i >= 0; i = s.indexOf("$", i + 1)) {
    const c = s.charCodeAt(i + 1);
    if (isLetter(c) || c === 95 || c === 123 || c === 40) return true;
  }
  for (let i = s.indexOf("%"); i >= 0; i = s.indexOf("%", i + 1)) {
    // An identifier of at most 64 characters, then the closing `%`.
    let j = i + 1;
    const first = s.charCodeAt(j);
    if (!(isLetter(first) || first === 95)) continue;
    const stop = Math.min(s.length, j + 64);
    while (j < stop) {
      const c = s.charCodeAt(j);
      if (!(isLetter(c) || isDigit(c) || c === 95)) break;
      j++;
    }
    if (s.charCodeAt(j) === 37) return true;
  }
  return false;
}

const SCHEMES = ["file:", "data:", "javascript:", "vbscript:", "mailto:", "ftp:", "sftp:", "smb:", "afp:", "nfs:", "ssh:", "http:", "https:"];

/**
 * Why this string may not appear in a design script, or undefined. Linear in the string's length:
 * a fixed number of passes, none of them a regular expression.
 */
export function unsafeString(raw: string): string | undefined {
  if (raw.length > MAX_STRING_CHARS) return `is longer than ${MAX_STRING_CHARS / (1024 * 1024)} MB`;
  if (!interesting(raw)) return undefined;
  // Undo the disguises a path can wear: compatibility forms (fullwidth dots and slashes, dot
  // leaders), then percent-encoding, at most three layers deep.
  let s = raw.normalize("NFKC");
  if (hasEnvReference(s)) return "contains an environment reference";
  for (let i = 0; i < 3; i++) {
    const next = percentDecodeOnce(s);
    if (next === s) break;
    s = next;
  }
  if (s.includes("\\")) s = s.replaceAll("\\", "/");
  s = s.trim();
  if (s.includes("\0")) return "contains a NUL character";
  if (hasEnvReference(s)) return "contains an environment reference";
  const first = s.charCodeAt(0);
  if (first === 47) return "is an absolute path";
  if (first === 126) return "starts with `~`";
  if (isLetter(first) && s.charCodeAt(1) === 58 && s.charCodeAt(2) === 47) return "is an absolute path";
  if (s.includes("..")) {
    for (const seg of s.split("/")) if (seg === ".." || (seg.length > 2 && seg.trim() === "..")) return "contains a `..` path segment";
  }
  if (s.includes(":")) {
    // `scheme://` anywhere: the character before it is the end of a scheme name.
    for (let i = s.indexOf("://"); i >= 0; i = s.indexOf("://", i + 1)) {
      const before = i > 0 ? s.charCodeAt(i - 1) : 0;
      if (isLetter(before) || isDigit(before)) return "contains a URL";
    }
    const head = s.slice(0, 12).toLowerCase();
    if (SCHEMES.some((p) => head.startsWith(p))) return "contains a URL";
  }
  return undefined;
}

/** Letters, digits, space, `-`, `_`, `.` only: a font family or a file's own name, never a place. */
export function isPlainName(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 255 || raw === "." || raw === "..") return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!(isLetter(c) || isDigit(c) || c === 32 || c === 45 || c === 95 || c === 46)) return false;
  }
  return raw.trim() === raw;
}

/** A bare file name: no separators, not `.` or `..`, nothing hidden by encoding. */
export function isBareFileName(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 255) return false;
  if (unsafeString(raw) !== undefined) return false;
  const s = percentDecodeOnce(raw.normalize("NFKC"));
  return !s.includes("/") && !s.includes("\\") && !s.includes("\0") && s !== "." && s !== ".." && s.trim() === s;
}

/** Numbers, booleans and null, however nested in arrays: what a forbidden key may still hold. */
function numbersOnly(v: unknown, budget: { n: number }, depth = 0): boolean {
  if (--budget.n < 0) return false;
  if (v === null || typeof v === "number" || typeof v === "boolean") return true;
  if (Array.isArray(v) && depth < MAX_DEPTH) {
    for (const x of v) if (!numbersOnly(x, budget, depth + 1)) return false;
    return true;
  }
  return false;
}

/** Embedded mesh data: an array of numbers, or of arrays of numbers. Not counted against the node cap. */
function isNumberData(v: unknown): boolean {
  if (!Array.isArray(v)) return false;
  for (const x of v) {
    if (typeof x === "number") continue;
    if (!Array.isArray(x)) return false;
    for (const y of x) if (typeof y !== "number") return false;
  }
  return true;
}

interface Budget {
  nodes: number;
  chars: number;
}

/** Walk one step's params. Returns the reason it is refused, or undefined. */
function screenParams(command: string, params: Record<string, unknown>, budget: Budget): string | undefined {
  const feature = command === "timeline.add" && isRecord(params.feature) ? params.feature : undefined;
  const importFeature = feature && feature.type === "import" ? feature : undefined;
  const meshFeature = feature && feature.type === "mesh_import" ? feature : undefined;
  const meshes = meshFeature && Array.isArray(meshFeature.meshes) ? new Set<unknown>(meshFeature.meshes) : undefined;
  if (importFeature && importFeature.step !== undefined && typeof importFeature.step !== "string") return "`feature.step` of an import must be the STEP text";
  const fileOwner = importFeature ?? meshFeature;
  if (fileOwner && fileOwner.file !== undefined && !isBareFileName(fileOwner.file)) return "`feature.file` of an import must be a bare file name";

  // `key` is the nearest object key above the value (array items inherit it), lowercased.
  const stack: { value: unknown; where: string; depth: number; owner?: unknown; key?: string }[] = [{ value: params, where: "params", depth: 0 }];
  while (stack.length) {
    const { value, where, depth, owner, key } = stack.pop()!;
    if (--budget.nodes < 0) return `the script has more than ${MAX_NODES} values`;
    if (typeof value === "string") {
      if (owner === importFeature && importFeature && key === "step") continue; // embedded STEP text: data, not a place
      if ((budget.chars -= value.length) < 0) return `the script's text outside embedded data is larger than ${MAX_INSPECTED_CHARS / (1024 * 1024)} MB`;
      const why = unsafeString(value);
      if (why) return `\`${frag(where)}\` ${why} (${JSON.stringify(frag(value))})`;
      if (key === "file" && !isBareFileName(value)) return `\`${frag(where)}\` must be a bare file name (${JSON.stringify(frag(value))})`;
      if (key !== undefined && NAMES.has(key) && !isPlainName(value)) return `\`${frag(where)}\` may hold only a plain name: letters, digits, space, - _ . (${JSON.stringify(frag(value))})`;
      continue;
    }
    if (Array.isArray(value)) {
      if (depth >= MAX_DEPTH) return `\`${frag(where)}\` is nested more than ${MAX_DEPTH} deep`;
      for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i], where: `${where}[${i}]`, depth: depth + 1, owner, key });
      continue;
    }
    if (isRecord(value)) {
      if (depth >= MAX_DEPTH) return `\`${frag(where)}\` is nested more than ${MAX_DEPTH} deep`;
      const mesh = meshes?.has(value) ?? false;
      for (const k of Object.keys(value)) {
        if (k.length > MAX_KEY_CHARS) return `a key under \`${frag(where)}\` is longer than ${MAX_KEY_CHARS} characters (${JSON.stringify(frag(k))})`;
        if ((budget.chars -= k.length) < 0) return `the script's text outside embedded data is larger than ${MAX_INSPECTED_CHARS / (1024 * 1024)} MB`;
        const lower = (interesting(k) ? k.normalize("NFKC") : k).trim().toLowerCase();
        const at = `${where}.${k}`;
        if (mesh && (lower === "positions" || lower === "triangles") && Array.isArray(value[k])) {
          if (!isNumberData(value[k])) return `\`${frag(at)}\` of a mesh import must hold numbers only`;
          continue; // embedded mesh data, verified
        }
        if (FORBIDDEN.has(lower) && !numbersOnly(value[k], { n: budget.nodes })) return `\`${frag(at)}\` names a file or a place, which a design script may not do`;
        stack.push({ value: value[k], where: at, depth: depth + 1, owner: value, key: lower });
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
  const whole = (reason: string): ScreenResult => ({ ok: false, reason: cut(reason), index: -1, command: "" });
  if (!isRecord(script)) return whole(NOT_A_SCRIPT_REASON);
  for (const k of Object.keys(script)) if (k !== "about" && k !== "commands") return whole(`unexpected top-level key \`${frag(k)}\`; a design script has only \`about\` and \`commands\``);
  if (script.about !== undefined && !isRecord(script.about)) return whole("`about` must be an object");
  const commands = script.commands;
  if (!Array.isArray(commands)) return whole(script.commands === undefined ? NOT_A_SCRIPT_REASON : "`commands` must be a list");
  if (commands.length > MAX_NODES) return whole(`the script has more than ${MAX_NODES} values`);
  const budget: Budget = { nodes: MAX_NODES, chars: MAX_INSPECTED_CHARS };
  for (let index = 0; index < commands.length; index++) {
    const step: unknown = commands[index];
    const id = isRecord(step) && typeof step.command === "string" ? frag(step.command) : "";
    const refuse = (reason: string): ScreenResult => ({ ok: false, reason: cut(`step ${index + 1}${id ? ` (${id})` : ""}: ${reason}`), index, command: id });
    if (!isRecord(step)) return refuse("a step must be an object { command, params }");
    if (typeof step.command !== "string" || !step.command) return refuse("a step needs a `command` id");
    for (const k of Object.keys(step)) if (k !== "command" && k !== "params") return refuse(`unexpected key \`${frag(k)}\` beside \`command\` and \`params\``);
    if (!ALLOWED.has(step.command)) return refuse("this command is not on Anvil's list of commands allowed in a design script (extend ALLOWED_COMMANDS in script-screen.ts if it is legitimate)");
    if (!isRecord(step.params)) return refuse("`params` must be an object");
    const why = screenParams(step.command, step.params, budget);
    if (why) return refuse(why);
  }
  return { ok: true };
}

/** UTF-8 length without building the bytes. One pass. */
function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** The refusal reasons that mean "this file is not a design script at all" (nothing could replay it). */
export const NOT_JSON_REASON = "the design script is not valid JSON";
export const NOT_A_SCRIPT_REASON = "a design script must be an object with a `commands` list";

/**
 * Before JSON.parse: count the objects and strings outside any string, in one pass with no
 * allocation. Every object and every string value of a script that can pass `screenScript` is a
 * node, and every key holds a node, so a script that passes has at most about 2 × MAX_NODES of them
 * (embedded STEP text is one string; embedded mesh data is numbers and arrays, which are not
 * counted here). A file packed with tiny objects or strings is refused here instead of after a
 * multi-gigabyte parse (B2 review, decision 115). Arrays of numbers are not caught by this; they
 * are bounded by the 64 MB size cap and cheap to parse by comparison.
 */
export function prescanScriptText(text: string): string | undefined {
  const limit = 2 * MAX_NODES + 1024;
  let count = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92) i++; // backslash: skip the escaped character
      else if (c === 34) inString = false;
      continue;
    }
    if (c === 34) {
      inString = true;
      count++;
    } else if (c === 123) count++;
    else continue;
    if (count > limit) return `the script has more than ${MAX_NODES} values`;
  }
  return undefined;
}

/**
 * The same check on the file's text: the size cap first, then a structural pre-scan, then JSON, then `screenScript`. Returns
 * the parsed script when it passes, so a caller parses once. A parse failure never quotes the
 * file: what could not be parsed may be something that is not a design at all.
 */
export function screenScriptText(text: string): ({ ok: true; script: { about?: Record<string, unknown>; commands: { command: string; params: Record<string, unknown> }[] } }) | Extract<ScreenResult, { ok: false }> {
  // A character is at least one byte and at most three, so only the middle band needs counting.
  if (text.length > MAX_SCRIPT_BYTES || (text.length * 3 > MAX_SCRIPT_BYTES && utf8Length(text) > MAX_SCRIPT_BYTES)) {
    return { ok: false, reason: `the design script is larger than ${MAX_SCRIPT_BYTES / (1024 * 1024)} MB`, index: -1, command: "" };
  }
  const packed = prescanScriptText(text);
  if (packed) return { ok: false, reason: packed, index: -1, command: "" };
  let script: unknown;
  try {
    script = JSON.parse(text);
  } catch {
    return { ok: false, reason: NOT_JSON_REASON, index: -1, command: "" };
  }
  const r = screenScript(script);
  return r.ok ? { ok: true, script: script as never } : r;
}
