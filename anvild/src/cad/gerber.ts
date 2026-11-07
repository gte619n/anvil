// Server-side Gerber rendering. tracespace v4 (pcb-stackup) is built on Node streams and does NOT run
// in a browser bundle (it throws "process is not defined" then readable-stream errors — found via the
// visual harness, not the unit tests). It works fine under Bun/Node, so — like STEP→GLB — we render the
// composited board SVG on the daemon and serve it to the client, which just displays it.
import pcbStackup from "pcb-stackup";
import whatsThatGerber from "whats-that-gerber";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Which filenames in a directory listing are real Gerber/drill layers. Unrecognised files (readme,
 * images, project files) are dropped. `.txt` is deliberately excluded: whats-that-gerber tags every
 * `.txt` as an Excellon drill, but a readme is also `.txt` — too ambiguous to auto-pull into a board
 * (mirrors the web `classifyCad` decision).
 */
export function selectGerberLayers(names: string[]): string[] {
  if (names.length === 0) return [];
  const classified = whatsThatGerber(names);
  return names.filter((n) => {
    if (n.toLowerCase().endsWith(".txt")) return false;
    return classified[n]?.type != null;
  });
}

export interface GerberStackup {
  top: string;
  bottom: string;
  layerCount: number;
}

/**
 * Composite the Gerber/drill set that lives in the same directory as `absOpenedPath` into top/bottom
 * board SVGs. The opened file is always included even if the directory scan misses it. Throws if
 * nothing in the directory is a recognised layer.
 */
export async function renderGerberFromDir(absOpenedPath: string): Promise<GerberStackup> {
  const dir = dirname(absOpenedPath);
  const opened = basename(absOpenedPath);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    names = [opened];
  }
  if (!names.includes(opened)) names.push(opened);

  const layerNames = selectGerberLayers(names);
  if (layerNames.length === 0) {
    throw new Error(`Not a recognised Gerber/Excellon file: ${opened}`);
  }

  const layers = await Promise.all(
    layerNames.map(async (filename) => ({ filename, gerber: await readFile(join(dir, filename), "utf8") })),
  );
  const stackup = await pcbStackup<string>(layers);
  return { top: stackup.top.svg, bottom: stackup.bottom.svg, layerCount: layerNames.length };
}
