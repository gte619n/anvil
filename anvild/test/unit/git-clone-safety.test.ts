/**
 * [SEC-H5] `git clone <url>` with a raw, caller-supplied URL is an RCE: git's remote-helper syntax
 * `ext::sh -c '<cmd>'` runs an arbitrary shell command during clone, and a leading-dash "URL" is
 * parsed as a git option. The clone URL flows from "add environment from git URL", so it is
 * attacker-influenceable. These tests pin the allowlist + option-injection guard.
 */
import { test, expect } from "bun:test";
import { assertSafeCloneUrl, cloneRepo } from "../../src/git/ops";

test("assertSafeCloneUrl accepts the intended transports", () => {
  for (const ok of [
    "https://github.com/owner/repo.git",
    "https://gitlab.example.com/team/proj",
    "ssh://git@github.com/owner/repo.git",
    "git@github.com:owner/repo.git", // scp-form
    "user@host.example.com:path/to/repo.git",
  ]) {
    expect(() => assertSafeCloneUrl(ok)).not.toThrow();
  }
});

test("assertSafeCloneUrl rejects remote-helper RCE, option injection, and unsafe schemes", () => {
  for (const bad of [
    "ext::sh -c 'touch /tmp/pwned'", // arbitrary command execution
    "fd::17/foo", // other remote helpers
    "-upload-pack=/bin/sh", // option injection (leading dash)
    "--upload-pack=touch pwned",
    "file:///etc/passwd", // local file transport
    "git://insecure.example.com/repo", // unauthenticated cleartext transport
    "", // empty
    "   ", // whitespace only
  ]) {
    expect(() => assertSafeCloneUrl(bad)).toThrow();
  }
});

test("cloneRepo rejects a malicious URL before it ever spawns git", () => {
  // If the guard is present, this throws from validation — no network, no subprocess.
  expect(() => cloneRepo("ext::sh -c 'touch /tmp/pwned'", "/tmp/anvil-clone-safety-test")).toThrow(
    /unsupported|invalid|scheme|url/i,
  );
  expect(() => cloneRepo("-upload-pack=/bin/sh", "/tmp/anvil-clone-safety-test")).toThrow();
});
