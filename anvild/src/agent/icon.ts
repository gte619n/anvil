import { query } from "@anthropic-ai/claude-agent-sdk";
import { claudeCliOptions } from "./cli";

/**
 * Curated Material Symbols (Rounded) names. Constraining Sonnet's choice to this set
 * guarantees the returned name is a real, renderable icon (arch §5).
 */
const ICONS = [
  "bug_report", "build", "rocket_launch", "science", "experiment", "database", "storage",
  "lock", "key", "security", "login", "shield", "palette", "brush", "dashboard", "settings",
  "tune", "terminal", "code", "data_object", "cloud", "cloud_upload", "api", "hub", "schema",
  "account_tree", "network_node", "smartphone", "web", "language", "search", "bolt", "speed",
  "monitoring", "analytics", "insights", "healing", "cleaning_services", "integration_instructions",
  "payments", "shopping_cart", "mail", "notifications", "description", "article", "image",
  "photo_camera", "videocam", "mic", "map", "calendar_month", "chat", "forum", "person", "group",
  "memory", "sync", "auto_fix_high", "construction", "handyman", "flag", "bookmark", "label",
  "folder", "edit_document", "draft", "table_chart", "functions", "fingerprint", "support_agent",
];
const SET = new Set(ICONS);

/**
 * Ask Sonnet to pick the best-fitting icon for a session, constrained to ICONS. One-shot,
 * no tools, uses the §3 OAuth env. Returns undefined on failure/timeout so the caller falls
 * back to a generic icon.
 */
export async function pickIcon(title: string, env: Record<string, string>): Promise<string | undefined> {
  const prompt =
    `Choose the single best-fitting icon for a software-development session titled: "${title}".\n` +
    `Pick exactly one name from this list:\n${ICONS.join(", ")}\n` +
    `Reply with ONLY the icon name (snake_case), nothing else.`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const q = query({
      prompt,
      options: {
        model: "sonnet",
        settingSources: [],
        allowedTools: [],
        permissionMode: "bypassPermissions",
        maxTurns: 1,
        ...claudeCliOptions(),
        abortController: ac,
        env,
      },
    });
    let text = "";
    for await (const m of q) {
      if (m.type === "assistant") {
        for (const block of (m as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content ?? []) {
          if (block.type === "text" && block.text) text += block.text;
        }
      }
      if (m.type === "result") break;
    }
    const name = text.trim().toLowerCase().replace(/[^a-z_]/g, "");
    return SET.has(name) ? name : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
