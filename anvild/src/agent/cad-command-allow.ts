/**
 * Which SolidCraft commands the agent's `execute` / `batch` may run (agent-cad-and-browser spec
 * §4.4: "the daemon owns paths and files"). DEFAULT-DENY: a command id that is not in the table below
 * is refused with a message naming it — including every id a future SolidCraft release adds.
 *
 * The table was built from the real binary's own list (`list_commands`, 673 ids on SolidCraft
 * 0.44.1). A family is listed only when it is modeling or inspection, and each allowed id was
 * checked to (a) take no file path or URL, (b) run no code, (c) leave the daemon's bookkeeping
 * (undo stack, parameter routing, script write) intact.
 *
 * HOW TO EXTEND IT. Read the command's `describe_command` output on the pinned build. Add it only
 * when all three hold. A whole family is `"*"` with the ids that fail the test under `except`; a
 * family with few safe members lists them under `only`. Then run the real suite
 * (`test/real/cad-a1.test.ts`): it walks every id the binary reports and fails on any id that is
 * neither allowed here nor refused.
 *
 * Deliberately absent (refused by default): `file.*`, `doc.*`, `plugin.*` (native code),
 * `diagnostics.*` (files tickets on an external site, crash test), `settings.*`, `library.*`,
 * `canvas.*`, `pointcloud.*`, `render.*`, `motion.*`, `engine.*` (use list_commands /
 * describe_command), `edit.*` (use the undo / redo tools), every UI family (`ui`, `panel`, `layout`,
 * `tab`, `browser`, `select`, `selection`, `appearance`, `note`), and the assembly families
 * (`joint`, `assembly`, `contact`, `explode`, `config`, `parts`) a single part does not need.
 */
export type CommandFamily = { family: string; allow: "*"; except?: readonly string[] } | { family: string; only: readonly string[] };

export const CAD_COMMAND_ALLOW: readonly CommandFamily[] = [
  // Sketching. Not: file/text imports and exports, the clipboard, interactive drags, UI preferences.
  {
    family: "sketch",
    allow: "*",
    except: ["insert_dxf", "insert_svg", "insert_airfoil", "drawing_bounds", "export_dxf", "copy", "cut", "paste", "replace", "drag", "drag_end", "options", "glyphs", "snap", "constrainer"],
  },
  { family: "solid", allow: "*" },
  { family: "surface", allow: "*" },
  { family: "face", only: ["delete"] },
  { family: "construct", allow: "*" },
  { family: "mesh", only: ["convert"] },
  // Read-only topology queries.
  { family: "model", allow: "*" },
  { family: "body", only: ["rename", "repair"] }, // not print_face (hands off to slicer exports)
  { family: "sheet", allow: "*", except: ["export_dxf", "export_bend_table", "manage_rules"] },
  { family: "plastic", allow: "*", except: ["manage_rules"] },
  { family: "frame", only: ["member", "end_cap", "profile.list", "profile.properties"] },
  // History. Not: the clipboard, `play` (UI animation), `add` (replays a recorded feature, which can
  // carry an embedded import). `export_script` is allowed WITHOUT a path (the key rule below).
  { family: "timeline", allow: "*", except: ["copy", "paste", "play", "add"] },
  // Parameters. Not: export / import (files).
  { family: "parameters", only: ["add", "change", "list", "rename", "delete", "favorite", "move", "comment", "users", "graph", "complete"] },
  { family: "expr", only: ["evaluate"] },
  // Inspection. Not: compare_picture (reads a picture file — use the compare_picture tool).
  { family: "inspect", allow: "*", except: ["compare_picture"] },
  { family: "material", only: ["assign", "list", "inspect"] },
  // Only what a plain part build can need; nothing that links, inserts or extracts another design.
  // NOT `from_bodies` / `move_bodies`: on 0.44.1 they apply and then `timeline.export_script` fails,
  // so the change could never be written to design.json (A2 review; real suite "script still exports").
  { family: "component", only: ["create", "activate", "list", "properties", "rename", "delete", "copy_bodies", "metadata", "metadata.set"] },
  { family: "occurrence", only: ["properties", "move", "ground", "align", "copy", "reparent"] },
  { family: "document", only: ["units", "metadata", "metadata.set", "metadata.remove", "inspect", "revision"] },
  // Ray picks and camera placement only.
  { family: "view", only: ["pick", "fit", "home", "front", "back", "left", "right", "top", "bottom", "isometric", "normal_to", "perspective"] },
];

const norm = (id: unknown): string => String(id ?? "").trim().toLowerCase();

/** Whether a command id is on the allow-list. */
export function isAllowedCommand(id: unknown): boolean {
  const c = norm(id);
  const dot = c.indexOf(".");
  if (dot <= 0 || !/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(c)) return false;
  const family = c.slice(0, dot);
  const rest = c.slice(dot + 1);
  const entry = CAD_COMMAND_ALLOW.find((f) => f.family === family);
  if (!entry) return false;
  if ("only" in entry) return entry.only.includes(rest);
  return !(entry.except ?? []).includes(rest);
}

/** Parameter names that carry a file, folder or address in SolidCraft's commands. */
export const PATH_KEYS = ["path", "dir", "file", "filename", "url", "reference", "out", "output"] as const;

/**
 * Commands where one of those names means GEOMETRY, not a file: `path` is the curve a sweep follows,
 * `reference` is a face. Only the listed key of the listed command is exempt from the key rule, and
 * its value still goes through the value rule (`looksLikePath`), so a real path is refused anyway.
 */
export const GEOMETRY_KEYS: Readonly<Record<string, readonly string[]>> = {
  "solid.sweep": ["path"],
  "solid.pipe": ["path"],
  "solid.pattern.path": ["path"],
  "surface.sweep": ["path"],
  "construct.point.along_path": ["path"],
  "construct.plane.along_path": ["path"],
  "construct.plane.tangent": ["reference"],
  "sketch.text": ["path"],
  "sketch.edit_text": ["path"],
  "sketch.trim.path": ["path"],
};

/** A string that names a file, a folder or an address: absolute, home- or variable-relative, holding
 *  `..`, or starting with a URL scheme. Expressions and entity ids never look like this. */
export function looksLikePath(v: string): boolean {
  const s = v.trim();
  if (!s) return false;
  if (s.startsWith("/") || s.startsWith("\\") || s.startsWith("~")) return true;
  if (/^[A-Za-z]:[\\/]/.test(s)) return true;
  if (s.includes("..")) return true;
  if (/%[A-Za-z_][A-Za-z_0-9]*%/.test(s) || /\$\{?[A-Za-z_]/.test(s)) return true;
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(file|data|javascript|mailto):/i.test(s)) return true;
  return false;
}

const holdsString = (v: unknown, depth = 0): boolean => {
  if (typeof v === "string") return true;
  if (depth > 8 || !v || typeof v !== "object") return false;
  return (Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)).some((x) => holdsString(x, depth + 1));
};

const OWNS_FILES = "the daemon owns the design's files (design.json is written after every change; use export_part to export)";

/**
 * Why `execute` / `batch` will not run this command id, or undefined when it may run. Default-deny:
 * anything not in `CAD_COMMAND_ALLOW` is refused, with a pointer to the right tool where there is one.
 */
export function refusedCommand(id: unknown): string | undefined {
  const c = norm(id);
  if (isAllowedCommand(c)) return undefined;
  if (!c) return "a step needs a `command` id";
  if (c === "file.insert_step") return "`file.insert_step` is reserved for import_reference { part, file }: the daemon copies the STEP into cad/<part>/refs/ and imports it as a fixed reference body";
  if (["open", "save", "export", "new_design", "crash_reports"].includes(c) || c.startsWith("file.") || c.startsWith("doc.")) return `\`${c}\` is not available here: ${OWNS_FILES}`;
  if (c === "undo" || c === "redo" || c.startsWith("edit.")) return `\`${c}\` is not available through execute or batch: use the undo and redo tools, which revert one of your requests as a whole`;
  if (c === "set_parameter") return "`set_parameter` is not available as a step: use the set_parameter tool, or the command `parameters.change` with {changes: {name: expression}}";
  if (c === "measure") return "`measure` is not available as a step: call the measure tool";
  if (c.startsWith("engine.")) return `\`${c}\` is not available here: use list_commands (with a filter) and describe_command`;
  if (c.startsWith("settings.")) return `\`${c}\` is not available here: it changes SolidCraft's own settings on this machine`;
  if (c.startsWith("plugin.")) return `\`${c}\` is not available here: plugins run code on this machine`;
  if (c.startsWith("diagnostics.")) return `\`${c}\` is not available here: diagnostics commands are not part of modeling`;
  if (/\.(export|import|insert)(_|\.|$)/.test(c) || /(^|\.)(export|import)/.test(c)) return `\`${c}\` is not available here: ${OWNS_FILES}`;
  return `\`${c}\` is not on the list of SolidCraft commands the anvil_cad tools may run (modeling and inspection commands only). If a part needs it, say so instead of working around it`;
}

/**
 * Why one step may not be sent, or undefined. Checks the command id, every command nested inside its
 * params at any depth (`sketch.draw.dimensioned` carries one), and the params themselves:
 *  - a key named like a path (`PATH_KEYS`, case-insensitive) whose value holds text — numbers are
 *    fine, so an axis `dir: [0, 0, 1]` passes — unless it is that command's geometry key;
 *  - any string value that looks like a path or an address.
 */
export function refusedStep(command: unknown, params: unknown, nesting = 0): string | undefined {
  const bad = refusedCommand(command);
  if (bad) return bad;
  if (nesting > 6) return "commands are nested too deeply";
  const cmd = norm(command);
  const exempt = GEOMETRY_KEYS[cmd] ?? [];
  const walk = (v: unknown, where: string, depth: number): string | undefined => {
    if (typeof v === "string") {
      return looksLikePath(v) ? `\`${cmd}\`: ${where || "a parameter"} looks like a file path or an address (${JSON.stringify(v.slice(0, 80))}), and the daemon owns every path` : undefined;
    }
    if (depth > 12) return `\`${cmd}\`: parameters are nested too deeply`;
    if (!v || typeof v !== "object") return undefined;
    if (Array.isArray(v)) {
      for (const [i, x] of v.entries()) {
        const why = walk(x, `${where}[${i}]`, depth + 1);
        if (why) return why;
      }
      return undefined;
    }
    const obj = v as Record<string, unknown>;
    // A command carried inside the params is a step in its own right, checked under its own name.
    const carries = typeof obj.command === "string";
    if (carries) {
      const why = refusedStep(obj.command, obj.params, nesting + 1);
      if (why) return why;
    }
    for (const [k, x] of Object.entries(obj)) {
      if (carries && (k === "command" || k === "params")) continue;
      const here = where ? `${where}.${k}` : `\`${k}\``;
      // `sketch.text` takes a font by family name OR by file: only the name form is allowed.
      if (k.toLowerCase() === "font" && typeof x === "string" && /[\\/]|\.(ttf|otf|ttc|woff2?)$/i.test(x.trim())) {
        return `\`${cmd}\`: ${here} must be an installed font's name, not a font file`;
      }
      if ((PATH_KEYS as readonly string[]).includes(k.toLowerCase()) && holdsString(x) && !(depth === 0 && exempt.includes(k.toLowerCase()))) {
        return `\`${cmd}\` may not take ${here} here: the daemon owns every path and file (design.json is written after each change; use export_part to export)`;
      }
      const why = walk(x, here, depth + 1);
      if (why) return why;
    }
    return undefined;
  };
  return walk(params, "", 0);
}
