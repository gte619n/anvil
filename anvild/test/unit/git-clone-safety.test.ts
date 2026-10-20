/**
 * [SEC-H5] `git clone <url>` with a raw, caller-supplied URL is an RCE: git's remote-helper syntax
 * `ext::sh -c '<cmd>'` runs an arbitrary shell command during clone, and a leading-dash "URL" is
 * parsed as a git option. The clone URL flows from "add environment from git URL", so it is
 * attacker-influenceable. These tests pin the allowlist + option-injection guard.
 */
import { test, expect } from "bun:test";
import { assertSafeCloneUrl, cloneRepo, toSshCloneUrl } from "../../src/git/ops";

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

test("toSshCloneUrl rewrites https/web URLs to the scp-style SSH form", () => {
  const cases: [string, string][] = [
    // the motivating case: a GitHub repo web URL → SSH clone path
    ["https://github.com/Frigg-It/frigg-it", "git@github.com:Frigg-It/frigg-it.git"],
    ["https://github.com/owner/repo.git", "git@github.com:owner/repo.git"],
    ["http://github.com/owner/repo", "git@github.com:owner/repo.git"],
    ["https://github.com/owner/repo/", "git@github.com:owner/repo.git"],
    // GitLab subgroups: the full path is preserved, not truncated to owner/repo
    ["https://gitlab.com/group/subgroup/repo", "git@gitlab.com:group/subgroup/repo.git"],
    // self-hosted host with a port
    ["https://git.example.com:8443/team/proj.git", "git@git.example.com:team/proj.git"],
    // embedded credentials are dropped (SSH auth is by key)
    ["https://user:token@github.com/owner/repo.git", "git@github.com:owner/repo.git"],
  ];
  for (const [input, expected] of cases) {
    expect(toSshCloneUrl(input)).toBe(expected);
  }
});

test("toSshCloneUrl leaves already-SSH forms untouched", () => {
  for (const u of [
    "git@github.com:owner/repo.git", // scp-form already clones over SSH
    "ssh://git@github.com/owner/repo.git",
    "user@host.example.com:path/to/repo.git",
  ]) {
    expect(toSshCloneUrl(u)).toBe(u);
  }
});

test("cloneRepo rejects a malicious URL before it ever spawns git", () => {
  // If the guard is present, this throws from validation — no network, no subprocess.
  expect(() => cloneRepo("ext::sh -c 'touch /tmp/pwned'", "/tmp/anvil-clone-safety-test")).toThrow(
    /unsupported|invalid|scheme|url/i,
  );
  expect(() => cloneRepo("-upload-pack=/bin/sh", "/tmp/anvil-clone-safety-test")).toThrow();
});
