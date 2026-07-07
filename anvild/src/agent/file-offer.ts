import { statSync } from "node:fs";
import { relative } from "node:path";
import type { FileOffer } from "@protocol";
import { resolveInside } from "../fs/session-fs";

/**
 * File-offer detection (UI refinement §8): when the agent writes a *deliverable* file into its
 * worktree — a report, export, archive, media, etc. — the daemon surfaces it in the conversation
 * as a download card "from the model". This module is the heuristic + the offer builder; the
 * driver wires it into the tool_use/tool.result stream.
 */

/** Extensions we treat as deliverables (things a user would download, not source/config churn). */
const DELIVERABLE_EXTS = new Set([
  // documents
  "pdf", "docx", "doc", "pptx", "ppt", "xlsx", "xls", "csv", "tsv", "rtf", "epub",
  // archives
  "zip", "tar", "gz", "tgz", "bz2", "7z", "rar", "dmg",
  // images / media (generated outputs)
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "svg", "mp4", "mov", "webm", "mp3", "wav", "m4a",
  // data exports / binaries
  "ico", "icns", "apk", "ipa", "wasm", "parquet",
]);

const MIME: Record<string, string> = {
  pdf: "application/pdf", csv: "text/csv", tsv: "text/tab-separated-values",
  zip: "application/zip", tar: "application/x-tar", gz: "application/gzip", tgz: "application/gzip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", bmp: "image/bmp", tiff: "image/tiff", ico: "image/x-icon", icns: "image/icns",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4",
  apk: "application/vnd.android.package-archive", wasm: "application/wasm",
};
const extOf = (p: string): string => (p.includes(".") ? p.split(".").pop()!.toLowerCase() : "");

/** Tools whose `file_path` input means "a file was created/written". */
const WRITE_TOOLS = new Set(["Write", "NotebookEdit"]);

/** The path a write-style tool_use targets, if it's a deliverable extension; else undefined. */
export function deliverablePath(toolName: string, input: unknown): string | undefined {
  if (!WRITE_TOOLS.has(toolName)) return undefined;
  const i = input as Record<string, unknown> | undefined;
  const p = (i?.file_path ?? i?.notebook_path) as string | undefined;
  if (typeof p !== "string" || !p) return undefined;
  return DELIVERABLE_EXTS.has(extOf(p)) ? p : undefined;
}

/** Build a FileOffer for `rawPath` (worktree-relative or absolute) if it exists inside `cwd`. */
export function buildFileOffer(sessionId: string, cwd: string, rawPath: string): FileOffer | null {
  let abs: string;
  try {
    abs = resolveInside(cwd, rawPath);
  } catch {
    return null; // escaped the worktree — never offer it
  }
  let size: number;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return null;
    size = st.size;
  } catch {
    return null; // gone / not a file
  }
  const name = abs.split("/").pop() || "download";
  const rel = relative(cwd, abs) || name;
  return {
    name,
    path: abs,
    size,
    mime: MIME[extOf(abs)] ?? "application/octet-stream",
    downloadUrl: `/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(rel)}&download=1`,
  };
}

/**
 * Best-effort Taildrop: push the file to the user's device with `tailscale file cp`. Enabled only
 * when a target is configured via `ANVIL_TAILDROP_TARGET` (a tailnet device name/IP) AND the
 * `tailscale` CLI is on PATH. Returns true on a successful send; silently false otherwise so the
 * in-chat download card is always the reliable path.
 */
export async function maybeTaildrop(absPath: string): Promise<boolean> {
  const target = process.env.ANVIL_TAILDROP_TARGET?.trim();
  if (!target) return false;
  for (const tailscale of ["tailscale", "/usr/bin/tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    try {
      const proc = Bun.spawn([tailscale, "file", "cp", absPath, `${target}:`], { stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      if (code === 0) return true;
      // CLI exists but the copy failed (offline peer, etc.) — stop trying other paths.
      return false;
    } catch {
      /* not at this path — try the next candidate */
    }
  }
  return false;
}
