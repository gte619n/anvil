#!/usr/bin/env bun
// Generates the Firebase App Distribution release notes for an Android build, printed to stdout
// (the CI workflow redirects it to app/release-notes.txt, which the gradle firebaseAppDistribution
// block picks up). Replaces a flat `git log` bullet list with grouped, de-noised notes so testers
// can tell at a glance what landed — features vs fixes vs the rest — and on which version/build.
//
// Reads commit subjects in the build's range and parses them as Conventional Commits
// (`type(scope): description`, optional `!` for breaking). Run locally with no env to preview
// against recent history: `bun scripts/gen-release-notes.ts`.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const env = process.env;
const buildNumber = env.BUILD_NUMBER ?? "local";
const before = env.BEFORE ?? "";
const sha = env.SHA || "HEAD";
const ZERO = "0000000000000000000000000000000000000000";
const CAP = 80; // hard ceiling on listed commits, so one huge push can't blow past Firebase's limit

const sh = (cmd: string): string => {
  try {
    return execSync(cmd, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const commitExists = (ref: string): boolean => {
  try {
    execSync(`git cat-file -e ${ref}^{commit}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

// baseVersionName in app/build.gradle is the single source of truth for the user-visible version.
const baseVersion = ((): string => {
  try {
    const gradle = readFileSync(new URL("../app/build.gradle", import.meta.url), "utf8");
    return gradle.match(/baseVersionName\s*=\s*"([^"]+)"/)?.[1] ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// Range = exactly what landed in this push (before..sha). When `before` is missing/unknown — first
// push, force-push, manual dispatch, or local preview — fall back to the last 30 commits.
const isDelta = !!before && before !== ZERO && commitExists(before);
const rangeArgs = isDelta ? `${before}..${sha}` : `-n 30 ${sha}`;
const raw = sh(`git log --no-merges --pretty=format:%s ${rangeArgs}`);
const subjects = raw ? raw.split("\n") : [];
const shortSha = sh(`git rev-parse --short ${sha}`) || sha.slice(0, 7);
const date = sh(`git log -1 --pretty=%cs ${sha}`) || new Date().toISOString().slice(0, 10);

interface Group {
  title: string;
  items: string[];
}
const groups: Record<string, Group> = {
  breaking: { title: "⚠️ Breaking changes", items: [] },
  feat: { title: "✨ New features", items: [] },
  fix: { title: "🐛 Fixes", items: [] },
  improve: { title: "🔧 Improvements", items: [] },
  other: { title: "📦 Other changes", items: [] },
};
const CONVENTIONAL = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;
const extra = subjects.length > CAP ? subjects.length - CAP : 0;
for (const subject of subjects.slice(0, CAP)) {
  const m = subject.match(CONVENTIONAL);
  let key = "other";
  let scope = "";
  let desc = subject;
  if (m) {
    const [, type, sc, bang, rest] = m;
    scope = sc ?? "";
    desc = rest;
    if (bang) key = "breaking";
    else if (type === "feat") key = "feat";
    else if (type === "fix") key = "fix";
    else if (type === "perf" || type === "refactor") key = "improve";
  }
  const tag = scope ? `[${scope}] ` : "";
  const clean = desc.charAt(0).toUpperCase() + desc.slice(1); // sentence-case the description
  groups[key].items.push(`• ${tag}${clean}`);
}

const count = subjects.length;
const lines: string[] = [];
lines.push(`Anvil ${baseVersion}${buildNumber !== "local" ? ` (build ${buildNumber})` : ""}`);
const plural = count === 1 ? "" : "s";
const summary = isDelta ? `${count} change${plural} since the last build` : `${count} recent change${plural}`;
lines.push(`${date} · ${shortSha} · ${summary}`);
if (count === 0) {
  lines.push("");
  lines.push("Maintenance build — no functional changes.");
} else {
  for (const g of [groups.breaking, groups.feat, groups.fix, groups.improve, groups.other]) {
    if (!g.items.length) continue;
    lines.push("");
    lines.push(g.title);
    lines.push(...g.items);
  }
  if (extra > 0) {
    lines.push("");
    lines.push(`…and ${extra} more change${extra === 1 ? "" : "s"}.`);
  }
}
console.log(lines.join("\n"));
