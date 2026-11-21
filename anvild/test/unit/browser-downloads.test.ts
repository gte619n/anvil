/**
 * [C3] The download quarantine (src/browser/downloads.ts; agent-cad-and-browser §4.12 "Downloads",
 * §4.14 item 30): which files count as downloads, the limits applied in `.anvil-downloads/`, what is
 * deleted and how it is reported, `quarantinePath`, and the rule that keeps quarantined files from
 * being executed. Real files in a temporary worktree throughout.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFileOffer } from "../../src/agent/file-offer";
import {
  DOWNLOADS_DIRNAME,
  DOWNLOAD_EXTENSIONS,
  DOWNLOAD_MAX_BYTES,
  downloadContext,
  downloadNotice,
  downloadsProtectedRule,
  isInQuarantine,
  isPlaywrightOwnFile,
  parseDownloadLines,
  quarantineDir,
  quarantineExecProblem,
  quarantineFile,
  quarantinePath,
  requestedOutputFiles,
  sanitizeDownloadName,
  sweepOutputDir,
} from "../../src/browser/downloads";
import { BROWSER_OUTPUT_DIRNAME } from "../../src/browser/preset";

let wt: string;
let out: string;
beforeEach(() => {
  wt = realpathSync(mkdtempSync(join(tmpdir(), "anvil-c3-dl-")));
  out = join(wt, ".anvil-browser");
  mkdirSync(out);
});
afterEach(() => rmSync(wt, { recursive: true, force: true }));

const drop = (name: string, bytes: number | string = "ISO-10303-21;\n"): string => {
  const p = join(out, name);
  writeFileSync(p, typeof bytes === "number" ? Buffer.alloc(bytes, 0x41) : bytes);
  return p;
};
const quarantined = (): string[] => (existsSync(quarantineDir(wt)) ? readdirSync(quarantineDir(wt)).sort() : []);

describe("constants", () => {
  test("[C3] the quarantine is .anvil-downloads/, the limit is 200 MB, and the allowed extensions are exactly the listed fourteen", () => {
    expect(DOWNLOADS_DIRNAME).toBe(".anvil-downloads");
    expect(BROWSER_OUTPUT_DIRNAME).toBe(".anvil-browser"); // the folder downloads.ts watches
    expect(DOWNLOAD_MAX_BYTES).toBe(200 * 1024 * 1024);
    expect([...DOWNLOAD_EXTENSIONS].sort()).toEqual(["3mf", "csv", "iges", "igs", "jpeg", "jpg", "json", "pdf", "png", "step", "stl", "stp", "txt", "zip"]);
    expect(quarantineDir("/w")).toBe("/w/.anvil-downloads");
  });
});

describe("reading results", () => {
  test("[C3] parses the Downloaded file line from a real result, ignores the earlier Downloading line, and handles several in one result", () => {
    const real = `### Open tabs\n- 0: (current) [Home](http://127.0.0.1:50362/)\n### Page\n- Page URL: http://127.0.0.1:50362/\n### Events\n- Downloaded file part.step to "/tmp/c3x/run/out/part.step"`;
    expect(parseDownloadLines(real)).toEqual([{ name: "part.step", path: "/tmp/c3x/run/out/part.step" }]);
    expect(parseDownloadLines("### Events\n- Downloading file part.step ...")).toEqual([]);
    expect(parseDownloadLines(`- Downloaded file a b.pdf to "/o/a b.pdf"\n- Downloaded file c.zip to "/o/c.zip"\n  - Downloaded file indented.txt to "/o/x"`)).toEqual([{ name: "a b.pdf", path: "/o/a b.pdf" }, { name: "c.zip", path: "/o/c.zip" }]);
  });

  test("[C3] Playwright's own page-*.yml, page-*.png and console-*.log files are recognised and are not downloads; look-alikes are", () => {
    for (const own of ["page-2026-11-19T18-11-20-885Z.yml", "page-2026-11-19T18-11-21-783Z.png", "page-2026-11-19T18-11-21-783Z.jpeg", "console-2026-11-19T18-11-20-859Z.log"]) expect([own, isPlaywrightOwnFile(own)]).toEqual([own, true]);
    for (const not of ["page-1.png", "page.yml", "console.log", "part.step", "page-2026-11-19T18-11-20-885Z.dmg", "xpage-2026-11-19T18-11-20-885Z.yml", "console-2026-11-19T18-11-20-859Z.txt"]) expect([not, isPlaywrightOwnFile(not)]).toEqual([not, false]);
  });

  test("[C3] file names the model asked for through a filename argument are remembered as not-downloads", () => {
    expect(requestedOutputFiles(wt, { filename: "shot.png" })).toContain(join(out, "shot.png"));
    expect(requestedOutputFiles(wt, { a: { b: [{ filename: "deep/snap.yml" }] } })).toEqual([join(out, "deep/snap.yml"), join(out, "snap.yml")]);
    expect(requestedOutputFiles(wt, { element: "x", filename: 7 })).toEqual([]);
  });
});

describe("quarantineFile", () => {
  test("[C3] a 1 KB part.step is moved into .anvil-downloads/ with its bytes intact and no execute bit, and is gone from .anvil-browser/", () => {
    const src = drop("part.step", 1024);
    chmodSync(src, 0o755);
    const o = quarantineFile(wt, src)!;
    expect(o).toEqual({ name: "part.step", size: 1024, kept: ".anvil-downloads/part.step", file: "part.step" });
    expect(existsSync(src)).toBe(false);
    expect(readFileSync(join(wt, ".anvil-downloads", "part.step")).length).toBe(1024);
    expect(statSync(join(wt, ".anvil-downloads", "part.step")).mode & 0o777).toBe(0o600);
    expect(quarantined()).toEqual(["part.step"]);
  });

  test("[C3] every allowed extension is kept, in any letter case; a second file of the same name gets a unique name instead of replacing the first", () => {
    for (const ext of DOWNLOAD_EXTENSIONS) expect([ext, quarantineFile(wt, drop(`f.${ext}`))?.kept]).toEqual([ext, `.anvil-downloads/f.${ext}`]);
    expect(quarantineFile(wt, drop("UPPER.STEP"))?.kept).toBe(".anvil-downloads/UPPER.STEP");
    expect(quarantineFile(wt, drop("Mixed.Pdf"))?.kept).toBe(".anvil-downloads/Mixed.Pdf");
    writeFileSync(join(wt, ".anvil-downloads", "f.step"), "FIRST");
    const second = quarantineFile(wt, drop("f.step", "SECOND"))!;
    expect(second.kept).toBe(".anvil-downloads/f-1.step");
    expect(readFileSync(join(wt, ".anvil-downloads", "f.step"), "utf8")).toBe("FIRST");
    expect(quarantineFile(wt, drop("f.step", "THIRD"))!.file).toBe("f-2.step");
  });

  test("[C3] a .dmg is deleted and reported — as are .exe, .sh, .app, .html, .js, a double extension ending in a refused one, and a file with no extension", () => {
    for (const name of ["Installer.dmg", "setup.exe", "run.sh", "tool.app", "page.html", "x.js", "model.step.dmg", "README", "archive.tar.gz", "photo.png.command"]) {
      const src = drop(name);
      const o = quarantineFile(wt, src)!;
      expect([name, o.kept, typeof o.deleted]).toEqual([name, undefined, "string"]);
      expect(o.deleted).toMatch(/not allowed \(allowed: step, stp, iges/);
      expect(existsSync(src)).toBe(false);
    }
    expect(quarantined()).toEqual([]);
    expect(quarantineFile(wt, drop("Installer.dmg"))!.deleted).toMatch(/^\.dmg files are not allowed/);
  });

  test("[C3] a file over the size limit is deleted and reported; one exactly at the limit is kept (a sparse file stands in for 200 MB + 1)", () => {
    const big = drop("huge.zip", "x");
    truncateSync(big, DOWNLOAD_MAX_BYTES + 1); // sparse: no real disk use
    expect(statSync(big).size).toBe(DOWNLOAD_MAX_BYTES + 1);
    const o = quarantineFile(wt, big)!;
    expect(o.deleted).toMatch(/it is 200\.0 MB, over the 200\.0 MB limit/);
    expect(o.size).toBe(DOWNLOAD_MAX_BYTES + 1);
    expect(existsSync(big)).toBe(false);
    expect(quarantined()).toEqual([]);

    const exact = drop("exact.zip", "x");
    truncateSync(exact, DOWNLOAD_MAX_BYTES);
    expect(quarantineFile(wt, exact)!.kept).toBe(".anvil-downloads/exact.zip");
    // An injected limit behaves the same way.
    expect(quarantineFile(wt, drop("small.pdf", 2048), { maxBytes: 1024 })!.deleted).toMatch(/over the 1\.0 kB limit/);
    expect(quarantineFile(wt, drop("small.pdf", 1024), { maxBytes: 1024 })!.kept).toBeDefined();
  });

  test("[C3] a symbolic link is never followed: the link is deleted and reported, and what it points at is untouched", () => {
    const secret = join(wt, "secret.pdf");
    writeFileSync(secret, "do not move me");
    symlinkSync(secret, join(out, "link.pdf"));
    const o = quarantineFile(wt, join(out, "link.pdf"))!;
    expect(o).toEqual({ name: "link.pdf", deleted: "it is a symbolic link" });
    expect(lstatSync(secret).isFile()).toBe(true);
    expect(readFileSync(secret, "utf8")).toBe("do not move me");
    expect(existsSync(join(out, "link.pdf"))).toBe(false);
    expect(quarantined()).toEqual([]);
  });

  test("[C3] the name is sanitized: path separators, control characters, leading dots and odd characters cannot shape where the file lands", () => {
    expect(sanitizeDownloadName("../../etc/passwd.txt")).toBe("passwd.txt");
    expect(sanitizeDownloadName("..\\..\\evil.pdf")).toBe("evil.pdf");
    expect(sanitizeDownloadName(".hidden.png")).toBe("hidden.png");
    expect(sanitizeDownloadName("a\u0000b\nc<d>|e?.pdf")).toBe("a_b_c_d_e_.pdf");
    expect(sanitizeDownloadName("   ")).toBe("download");
    expect(sanitizeDownloadName(`${"x".repeat(300)}.step`)).toHaveLength(120);
    expect(sanitizeDownloadName(`${"x".repeat(300)}.step`).endsWith(".step")).toBe(true);
    const o = quarantineFile(wt, drop("we ird;name$(id).step"))!;
    expect(o.kept).toBe(".anvil-downloads/we ird_name_id_.step");
    expect(quarantined()).toEqual(["we ird_name_id_.step"]);
  });

  test("[C3] gamed result text: a Downloaded line naming a file outside this session's .anvil-browser/ moves nothing — not /etc/hosts, not a worktree file, not a file in a subfolder or through a link", () => {
    writeFileSync(join(wt, "design.step"), "MINE");
    mkdirSync(join(out, "sub"));
    writeFileSync(join(out, "sub", "inner.step"), "x");
    symlinkSync(wt, join(out, "up"));
    for (const p of ["/etc/hosts", join(wt, "design.step"), join(out, "sub", "inner.step"), join(out, "up", "design.step"), join(out, "..", "design.step"), "relative.step", join(out, "missing.step"), out]) {
      expect([p, quarantineFile(wt, p)]).toEqual([p, undefined]);
    }
    expect(readFileSync(join(wt, "design.step"), "utf8")).toBe("MINE");
    expect(existsSync(join(out, "sub", "inner.step"))).toBe(true);
    expect(quarantined()).toEqual([]);
  });

  test("[C3] a .anvil-downloads that is a link to somewhere else is not written through: the download is deleted and reported", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "anvil-c3-elsewhere-"));
    try {
      symlinkSync(elsewhere, join(wt, ".anvil-downloads"));
      const o = quarantineFile(wt, drop("part.step"))!;
      expect(o.deleted).toMatch(/could not be put in quarantine/);
      expect(readdirSync(elsewhere)).toEqual([]);
      expect(existsSync(join(out, "part.step"))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("[C3] .anvil-downloads/ is added to the checkout's git exclude through the helper the caller passes", () => {
    const calls: [string, string][] = [];
    quarantineFile(wt, drop("part.step"), { exclude: (w, e) => void calls.push([w, e]) });
    expect(calls).toEqual([[wt, ".anvil-downloads/"]]);
  });
});

describe("the end-of-turn sweep", () => {
  test("[C3] files left in .anvil-browser/ that are not Playwright's own and were not asked for by filename are treated as downloads; Playwright's page and console files and the model's own files stay put", () => {
    const own = ["page-2026-11-19T18-11-20-885Z.yml", "page-2026-11-19T18-11-21-783Z.png", "console-2026-11-19T18-11-20-859Z.log"].map((n) => drop(n, "own"));
    const asked = drop("my-shot.png", "asked for");
    drop("part.step");
    drop("tool.dmg");
    mkdirSync(join(out, "folder"));
    const outcomes = sweepOutputDir(wt, { requested: new Set(requestedOutputFiles(wt, { filename: "my-shot.png" })) });
    expect(outcomes).toEqual([
      { name: "part.step", size: 14, kept: ".anvil-downloads/part.step", file: "part.step" },
      { name: "tool.dmg", size: 14, deleted: expect.stringMatching(/^\.dmg files are not allowed/) },
    ]);
    for (const f of [...own, asked]) expect([f, existsSync(f)]).toEqual([f, true]);
    expect(readdirSync(out).sort()).toEqual(["console-2026-11-19T18-11-20-859Z.log", "folder", "my-shot.png", "page-2026-11-19T18-11-20-885Z.yml", "page-2026-11-19T18-11-21-783Z.png"]);
    expect(quarantined()).toEqual(["part.step"]);
    expect(sweepOutputDir(wt)).toEqual([{ name: "my-shot.png", size: 9, kept: ".anvil-downloads/my-shot.png", file: "my-shot.png" }]); // without the request it would count
    expect(sweepOutputDir(join(wt, "no-such-worktree"))).toEqual([]);
  });

  test("[C3] the sweep only takes files that appeared since the last sweep", () => {
    const old = drop("old.pdf");
    const past = new Date(Date.now() - 3600_000);
    utimesSync(old, past, past);
    drop("new.pdf");
    const since = Date.now() - 60_000;
    // (ctime cannot be set back, so the old file is only skipped when the cut-off is after its ctime too.)
    expect(sweepOutputDir(wt, { since: Date.now() + 60_000 })).toEqual([]);
    expect(sweepOutputDir(wt, { since }).map((o) => o.name).sort()).toEqual(["new.pdf", "old.pdf"]);
  });
});

describe("reports", () => {
  test("[C3] each outcome becomes one notice line for the transcript and one line of context for the model", () => {
    const kept = { name: "part.step", kept: ".anvil-downloads/part.step", file: "part.step" };
    const gone = { name: "Installer.dmg", deleted: ".dmg files are not allowed (allowed: step)" };
    expect(downloadNotice(kept)).toBe("⬇️ _Download `part.step` was put in quarantine at `.anvil-downloads/part.step`. It is never run and gets no download card; copy it out deliberately to use it._");
    expect(downloadNotice(gone)).toBe("🗑️ _Download `Installer.dmg` was deleted: .dmg files are not allowed (allowed: step)._");
    expect(downloadNotice({ name: "a`*_[x](y)<b>.dmg", deleted: "no" })).toBe("🗑️ _Download `ax(y)b.dmg` was deleted: no._"); // a hostile name cannot write Markdown
    const text = downloadContext([kept, gone]);
    expect(text).toContain('"part.step" was moved to .anvil-downloads/part.step (it is no longer in .anvil-browser/)');
    expect(text).toContain('"Installer.dmg" was DELETED: .dmg files are not allowed');
    expect(text.startsWith("Anvil download quarantine:")).toBe(true);
  });
});

describe("quarantinePath (for import_reference)", () => {
  test("[C3] returns the absolute path of a quarantined file by its bare name, and throws for anything that is not a plain file directly in the quarantine", () => {
    const o = quarantineFile(wt, drop("bracket.step"))!;
    expect(quarantinePath(wt, o.file!)).toBe(join(wt, ".anvil-downloads", "bracket.step"));
    expect(isInQuarantine(wt, quarantinePath(wt, "bracket.step"))).toBe(true);
    expect(isInQuarantine(wt, join(wt, "cad", "bracket.step"))).toBe(false);
    expect(isInQuarantine(wt, join(wt, ".anvil-downloads-other", "x"))).toBe(false);

    mkdirSync(join(wt, ".anvil-downloads", "dir.step"));
    writeFileSync(join(wt, "outside.step"), "x");
    symlinkSync(join(wt, "outside.step"), join(wt, ".anvil-downloads", "link.step"));
    for (const bad of ["missing.step", "../outside.step", "sub/x.step", "/etc/hosts", "", ".", "..", "dir.step", "link.step", "a\\b.step", "x\u0000.step"]) {
      expect(() => quarantinePath(wt, bad)).toThrow();
    }
    expect(() => quarantinePath(join(wt, "nope"), "bracket.step")).toThrow(/not in the download quarantine/);
  });
});

describe("never executed", () => {
  const rule = (command: string) => downloadsProtectedRule({ session: { id: "s", data: {} as never }, tool: "Bash", input: { command }, cwd: wt });

  test("[C3] Bash that executes a file in .anvil-downloads/ is denied: as the command word, through a shell or interpreter, with open, with chmod +x, after cd into the folder, or piped into a shell", () => {
    for (const command of [
      ".anvil-downloads/tool",
      "./.anvil-downloads/run.sh --flag",
      `${wt}/.anvil-downloads/installer`,
      "sh .anvil-downloads/run.sh",
      "bash -x ./.anvil-downloads/run.sh",
      "zsh .anvil-downloads/x",
      "python3 .anvil-downloads/setup.py",
      "python .anvil-downloads/setup.py install",
      "node .anvil-downloads/index.js",
      "bun run .anvil-downloads/x.ts",
      "open .anvil-downloads/Installer.dmg",
      "open -a Terminal .anvil-downloads/x",
      "chmod +x .anvil-downloads/tool",
      "chmod u+x .anvil-downloads/tool && echo done",
      "chmod 755 .anvil-downloads/tool",
      "ls && sh .anvil-downloads/run.sh",
      "echo hi; FOO=1 bash .anvil-downloads/run.sh",
      "sudo sh .anvil-downloads/run.sh",
      "env X=1 python3 .anvil-downloads/a.py",
      "cd .anvil-downloads && ./tool",
      "cd .anvil-downloads; sh run.sh",
      "cat .anvil-downloads/run.txt | sh",
      "cat .anvil-downloads/a.txt | python3",
      "source .anvil-downloads/env.txt",
      ". .anvil-downloads/env.txt",
      "$(.anvil-downloads/tool)",
      "hdiutil attach .anvil-downloads/x.dmg",
    ]) {
      expect([command, rule(command)?.kind]).toEqual([command, "deny"]);
    }
    expect(rule("sh .anvil-downloads/run.sh")).toEqual({ kind: "deny", reason: expect.stringMatching(/never executed/) });
  });

  test("[C3] reading, listing and deliberately copying a quarantined file is not denied, and the rule has no opinion on other tools or other folders", () => {
    for (const command of [
      "ls -la .anvil-downloads/",
      "cp .anvil-downloads/part.step cad/refs/part.step",
      "mv .anvil-downloads/data.csv data/",
      "file .anvil-downloads/part.step && shasum -a 256 .anvil-downloads/part.step",
      "head -c 200 .anvil-downloads/part.step",
      "unzip -l .anvil-downloads/models.zip",
      "chmod 644 .anvil-downloads/part.step",
      "chmod -x .anvil-downloads/part.step",
      "sh scripts/build.sh",
      "python3 tools/convert.py --in cad/refs/part.step",
      "git status",
      "echo .anvil-downloads",
    ]) {
      expect([command, quarantineExecProblem(command)]).toEqual([command, undefined]);
    }
    expect(downloadsProtectedRule({ session: { id: "s", data: {} as never }, tool: "Read", input: { file_path: join(wt, ".anvil-downloads", "part.step") }, cwd: wt })).toBeUndefined();
  });

  test("[C3] a file in the quarantine gets no file-offer card, whatever its type; the same file copied out does", () => {
    quarantineFile(wt, drop("report.pdf", "%PDF-1.7"));
    expect(buildFileOffer("sess_1", wt, ".anvil-downloads/report.pdf")).toBeNull();
    expect(buildFileOffer("sess_1", wt, join(wt, ".anvil-downloads", "report.pdf"))).toBeNull();
    writeFileSync(join(wt, "report.pdf"), "%PDF-1.7");
    expect(buildFileOffer("sess_1", wt, "report.pdf")).toMatchObject({ name: "report.pdf" });
  });
});
