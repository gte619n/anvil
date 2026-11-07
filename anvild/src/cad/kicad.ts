// kicad-cli detection + PCB → GLB export (D12 / Phase 5). KiCad ships a headless `kicad-cli` that
// tessellates a .kicad_pcb (with 3D models substituted) straight to GLB — far better than us
// reimplementing board rendering. We shell out with fixed positional args (no shell string, so a
// crafted path can't inject). Everything here is best-effort detection; failures surface as a
// CadConvertError the panel can show as "install KiCad to view PCBs in 3D".

import { CadConvertError } from "./types";

/** True if `kicad-cli` is on PATH. */
export async function kicadCliAvailable(): Promise<boolean> {
  const viaWhich = Bun.which("kicad-cli");
  if (viaWhich) return true;
  // Fall back to spawning `which` in case Bun.which's resolution differs from the user's shell.
  try {
    const proc = Bun.spawn(["which", "kicad-cli"], { stdout: "pipe", stderr: "ignore" });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Locate KiCad's bundled 3D model packages (the `*.3dshapes` dirs component footprints reference via
 * `${KICAD*_3DMODEL_DIR}`). Returns the directory or null. We probe the common env vars + default
 * install dirs; paths differ per OS/version so this is best-effort, not gospel.
 */
export async function findKicad3dModelDir(): Promise<string | null> {
  const envDirs = [
    process.env.KICAD9_3DMODEL_DIR,
    process.env.KICAD8_3DMODEL_DIR,
    process.env.KICAD7_3DMODEL_DIR,
    process.env.KICAD6_3DMODEL_DIR,
  ].filter((d): d is string => !!d);

  const commonDirs = [
    "/usr/share/kicad/3dmodels",
    "/usr/local/share/kicad/3dmodels",
    "/Applications/KiCad/KiCad.app/Contents/SharedSupport/3dmodels",
    "C:/Program Files/KiCad/9.0/share/kicad/3dmodels",
  ];

  for (const dir of [...envDirs, ...commonDirs]) {
    try {
      const s = await (await import("node:fs/promises")).stat(dir);
      if (s.isDirectory()) return dir;
    } catch {
      // not present at this path — keep probing
    }
  }
  return null;
}

/**
 * Advisory check that the 3D model packages are present — `--subst-models` needs them to place
 * component bodies. A false here never blocks export; it just lets the caller warn that boards may
 * render as a bare substrate without component models.
 */
export async function kicadPackages3dAvailable(): Promise<boolean> {
  return (await findKicad3dModelDir()) !== null;
}

/**
 * Export a KiCad PCB to GLB via `kicad-cli pcb export glb --subst-models --output <out> <pcb>`.
 * Fixed positional args (no shell interpolation). Throws CadConvertError if the CLI is missing or
 * the process exits non-zero (stderr is folded into the reason so the user sees what went wrong).
 */
export async function kicadPcbToGlb(pcbPath: string, outPath: string): Promise<void> {
  if (!(await kicadCliAvailable())) {
    throw new CadConvertError("kicad-cli not found — install KiCad to view PCBs in 3D");
  }
  // Footprints reference component models via ${KICAD*_3DMODEL_DIR}; define it (to the detected
  // library) so --subst-models can place component bodies instead of exporting a bare board.
  const modelDir = await findKicad3dModelDir();
  const args = ["pcb", "export", "glb", "--subst-models"];
  if (modelDir) args.push("--define-var", `KICAD9_3DMODEL_DIR=${modelDir}`);
  args.push("--output", outPath, pcbPath);
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["kicad-cli", ...args], { stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    throw new CadConvertError(
      `failed to launch kicad-cli: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const code = await proc.exited;
  if (code !== 0) {
    // proc.stderr is a ReadableStream when stderr:"pipe"; guard for the typed union all the same.
    const errStream = proc.stderr;
    const stderr =
      errStream instanceof ReadableStream
        ? await new Response(errStream).text().catch(() => "")
        : "";
    throw new CadConvertError(
      `kicad-cli exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    );
  }
}
