import { resolve } from "node:path";

/**
 * The autonomy backstop (arch §6.6). Under `mostly-autonomous`, this is the ONLY thing
 * between the agent and an unattended destructive action — so it is conservative and
 * auditable. One reviewable table; extend deliberately.
 */
export interface DangerVerdict {
  danger: boolean;
  reason?: string;
}

const BASH_PATTERNS: [RegExp, string][] = [
  [/\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, "recursive force remove (rm -rf)"],
  [/\bgit\s+push\b[^\n]*(--force(?!-with-lease)|\s-f\b)/i, "git force-push"],
  [/\bgit\s+reset\s+--hard\b/i, "git reset --hard"],
  [/\bgit\s+clean\s+-[a-z]*f/i, "git clean -f"],
  [/\b(drop\s+database|drop\s+table|truncate\s+table|delete\s+from)\b/i, "destructive SQL"],
  [/\b(npm|pnpm|yarn)\s+publish\b/i, "package publish"],
  [/\b(sudo|doas)\b/i, "privilege escalation"],
  [/:\s*\(\s*\)\s*\{[^}]*\}\s*;/, "fork bomb"],
  [/\bmkfs\b|\bdd\s+if=[^\n]*of=\/dev\//i, "raw disk write"],
  [/\bcurl\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, "pipe-to-shell from network"],
];

const SECRET_PATH = /(^|\/)\.env(\.[a-z]+)?$|\/\.ssh\/|id_(rsa|ed25519)|(^|\/)credentials\b|\.pem$|\.p8$|\bsecrets?\b/i;

const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "NotebookRead", "TodoWrite"]);

export function isReadOnly(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName);
}

export function isDangerous(toolName: string, input: Record<string, unknown>, cwd?: string): DangerVerdict {
  const command = typeof input.command === "string" ? input.command : "";

  if (toolName === "Bash" && command) {
    for (const [re, reason] of BASH_PATTERNS) {
      if (re.test(command)) return { danger: true, reason };
    }
  }

  // credential / secret paths across any tool that names a path
  const pathish = [input.file_path, input.path, input.notebook_path, command]
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .join(" ");
  if (SECRET_PATH.test(pathish)) return { danger: true, reason: "credential/secret path" };

  // writes resolving outside the session worktree
  if (cwd && (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit")) {
    const fp = input.file_path ?? input.notebook_path;
    if (typeof fp === "string" && fp.startsWith("/") && !resolve(fp).startsWith(resolve(cwd))) {
      return { danger: true, reason: "write outside the session worktree" };
    }
  }

  return { danger: false };
}
