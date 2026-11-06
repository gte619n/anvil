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
 * Best-effort check that KiCad's bundled 3D model packages are present — `--subst-models` needs
 * them to place component bodies. We probe the common env vars + default install dirs. This is
 * advisory only: a true/false here never blocks export, it just lets the caller warn the user that
 * boards may render without component models. (Paths differ per OS/version — comment, not gospel.)
 */
export async function kicadPackages3dAvailable(): Promise<boolean> {
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
      if (s.isDirectory()) return true;
    } catch {
      // not present at this path — keep probing
    }
  }
  return false;
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
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(
      ["kicad-cli", "pcb", "export", "glb", "--subst-models", "--output", outPath, pcbPath],
      { stdout: "pipe", stderr: "pipe" },
    );
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
