import { test, expect } from "bun:test";
import { globMatch, anyGlobMatches, evaluateScope } from "../../src/loops/scope-guard";

test("globMatch: directory prefixes match the whole subtree", () => {
  expect(globMatch("src/upload/", "src/upload/a.ts")).toBe(true);
  expect(globMatch("src/upload/", "src/upload/deep/b.ts")).toBe(true);
  expect(globMatch("src/upload", "src/upload/a.ts")).toBe(true); // no trailing slash → still a subtree
  expect(globMatch("src/upload/", "src/other/a.ts")).toBe(false);
});

test("globMatch: * stays within a segment, ** crosses segments", () => {
  expect(globMatch("src/*.ts", "src/a.ts")).toBe(true);
  expect(globMatch("src/*.ts", "src/deep/a.ts")).toBe(false); // * doesn't cross /
  expect(globMatch("src/**/*.ts", "src/deep/a.ts")).toBe(true);
  expect(globMatch("**/*.test.ts", "test/upload.test.ts")).toBe(true);
});

test("globMatch: an exact file path matches itself", () => {
  expect(globMatch("test/upload.test.ts", "test/upload.test.ts")).toBe(true);
  expect(globMatch("test/upload.test.ts", "test/other.test.ts")).toBe(false);
});

test("anyGlobMatches ors across globs", () => {
  expect(anyGlobMatches(["src/a/", "src/b/"], "src/b/x.ts")).toBe(true);
  expect(anyGlobMatches(["src/a/", "src/b/"], "src/c/x.ts")).toBe(false);
});

test("evaluateScope: check-tampering wins over scope-violation", () => {
  // A file both outside scope AND a locked check input → the more serious check-tampering.
  const r = evaluateScope(["test/upload.test.ts"], ["src/upload/"], ["test/upload.test.ts"]);
  expect(r.verdict).toBe("check-tampering");
  expect(r.offending).toEqual(["test/upload.test.ts"]);
});

test("evaluateScope: a file outside scope.allow is a scope-violation", () => {
  const r = evaluateScope(["src/other/x.ts"], ["src/upload/"], []);
  expect(r.verdict).toBe("scope-violation");
  expect(r.offending).toEqual(["src/other/x.ts"]);
});

test("evaluateScope: in-scope, no locks touched → ok", () => {
  expect(evaluateScope(["src/upload/a.ts", "src/upload/b.ts"], ["src/upload/"], ["test/upload.test.ts"]).verdict).toBe("ok");
});

test("evaluateScope: no scope set → only the lock wall applies", () => {
  expect(evaluateScope(["anywhere/x.ts"], undefined, []).verdict).toBe("ok");
  expect(evaluateScope(["test/upload.test.ts"], undefined, ["test/upload.test.ts"]).verdict).toBe("check-tampering");
});
