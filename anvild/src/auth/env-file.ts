import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Shared primitives for reading/writing the launcher's env file — the single file the launcher sources
 * on every start (`set -a; . "$HOME/.config/anvil/env"`, see scripts/service.sh; the launcher is the
 * same on macOS/launchd and Linux/systemd). Both the Claude subscription token (auth/store.ts) and the
 * OpenRouter key (auth/openrouter.ts) live here so a value set from the UI survives a service restart.
 * Keep this in lockstep with service.sh — do NOT swap in XDG_CONFIG_HOME, or the daemon would write a
 * file the launcher never reads (the launcher hardcodes ~/.config/anvil/env on both platforms).
 */

/** The env file the launcher sources. */
export function envFile(home: string = homedir()): string {
  return join(home, ".config", "anvil", "env");
}

/** Show enough of a secret to recognise it without leaking it (first 8 + last 4 chars). */
export function mask(secret: string): string {
  const t = secret.trim();
  if (t.length <= 14) return "•".repeat(t.length);
  return `${t.slice(0, 8)}…${t.slice(-4)}`;
}

export function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

/** True if the persisted env file already carries a `KEY=` line (ignoring an optional `export `). */
export function envFileHasKey(file: string, key: string): boolean {
  if (!existsSync(file)) return false;
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .some((l) => l.replace(/^export\s+/, "").startsWith(`${key}=`));
  } catch {
    return false;
  }
}

/** The value of `KEY=` in the persisted env file, or undefined if absent/unreadable. */
export function readEnvKey(file: string, key: string): string | undefined {
  if (!existsSync(file)) return undefined;
  try {
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const line = raw.replace(/^export\s+/, "").trim();
      if (line.startsWith(`${key}=`)) return stripQuotes(line.slice(key.length + 1));
    }
  } catch {
    /* unreadable — fall through */
  }
  return undefined;
}

/** Rewrite `file` with `KEY=value` set (preserving every other line), creating it 0600 if absent. */
export function upsertEnvLine(file: string, key: string, value: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const kept = lines.filter((l) => !l.replace(/^export\s+/, "").startsWith(`${key}=`));
  // Drop a trailing empty line so we don't accumulate blank lines on repeated writes.
  while (kept.length && kept[kept.length - 1]!.trim() === "") kept.pop();
  kept.push(`${key}=${value}`);
  writeFileSync(file, `${kept.join("\n")}\n`, { mode: 0o600 });
}

/** Remove any `KEY=…` line from `file` (no-op if the file or line is absent). */
export function removeEnvLine(file: string, key: string): void {
  if (!existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split("\n");
  const kept = lines.filter((l) => !l.replace(/^export\s+/, "").startsWith(`${key}=`));
  writeFileSync(file, kept.join("\n"), { mode: 0o600 });
}
