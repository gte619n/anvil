import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectChecks, resolveGate, runValidation } from "../../src/integrations/validation";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "anvil-val-"));
}

test("detectChecks: package.json at root → typecheck + test, npm by default", () => {
  const dir = tmpRepo();
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc", test: "vitest", lint: "eslint" } }));
    expect(detectChecks(dir)).toEqual(["npm run typecheck", "npm run lint", "npm test"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectChecks: bun lockfile → bun commands", () => {
  const dir = tmpRepo();
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc", test: "bun test" } }));
    writeFileSync(join(dir, "bun.lock"), "");
    expect(detectChecks(dir)).toEqual(["bun run typecheck", "bun test"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectChecks: JS subproject one level down → cd-prefixed (Gradle-root layout)", () => {
  const dir = tmpRepo();
  try {
    writeFileSync(join(dir, "build.gradle"), "");
    mkdirSync(join(dir, "daemon"));
    writeFileSync(join(dir, "daemon", "package.json"), JSON.stringify({ scripts: { typecheck: "tsc", test: "bun test" } }));
    writeFileSync(join(dir, "daemon", "bun.lock"), "");
    expect(detectChecks(dir)).toEqual(["cd daemon && bun run typecheck", "cd daemon && bun test"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectChecks: nothing recognized → empty", () => {
  const dir = tmpRepo();
  try {
    expect(detectChecks(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveGate: explicit env commands win and are not flagged autodetected", () => {
  const dir = tmpRepo();
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
    expect(resolveGate(dir, { commands: ["make check"] })).toEqual({ commands: ["make check"], autodetected: false });
    expect(resolveGate(dir, undefined).autodetected).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runValidation: passes when all checks exit 0", async () => {
  const r = await runValidation(tmpdir(), ["true", "echo ok"]);
  expect(r.passed).toBe(true);
  expect(r.results).toHaveLength(2);
});

test("runValidation: fail-fast on first non-zero", async () => {
  const r = await runValidation(tmpdir(), ["false", "echo should-not-run"]);
  expect(r.passed).toBe(false);
  expect(r.results).toHaveLength(1); // stopped at the failure
  expect(r.results[0]!.code).not.toBe(0);
});

test("runValidation: no commands → passes with noChecks flag", async () => {
  const r = await runValidation(tmpdir(), []);
  expect(r.passed).toBe(true);
  expect(r.noChecks).toBe(true);
});
