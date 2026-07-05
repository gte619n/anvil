import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Prompt } from "@protocol";
import { newId } from "../util/ids";

/**
 * The user's saved prompt library — reusable composer snippets fired into the chat with one click
 * (arch §8). Persisted to `<stateDir>/prompts.json` and broadcast to every connected client so the
 * library syncs across a user's devices. Purely personal boilerplate: no git/repo binding, unlike
 * environments. Hub-authoritative — clients route prompt.* commands to the hub daemon.
 */
export class PromptStore {
  private readonly file: string;
  private prompts: Prompt[] = [];

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, "prompts.json");
    this.load();
  }

  /** Every prompt, sorted by short title (the button label), case-insensitive — the display order. */
  list(): Prompt[] {
    return [...this.prompts].sort((a, b) =>
      (a.shortTitle || a.title).localeCompare(b.shortTitle || b.title, undefined, { sensitivity: "base" }),
    );
  }

  /** Create (no `id`) or update (existing `id`) a prompt; returns the stored record.
   *  @throws if there's no text to save (an empty prompt is meaningless). */
  save(fields: { id?: string; title: string; shortTitle: string; icon: string; body: string }): Prompt {
    const title = fields.title.trim();
    const shortTitle = fields.shortTitle.trim();
    const body = fields.body.trim();
    if (!body) throw new Error("a prompt needs some text");
    if (!title && !shortTitle) throw new Error("a prompt needs a title");
    const prompt: Prompt = {
      id: fields.id?.trim() || newId("prompt"),
      // Each field falls back to the other so neither the editor heading nor the button is ever blank.
      title: title || shortTitle,
      shortTitle: shortTitle || title,
      icon: fields.icon.trim() || "bookmark",
      body,
      updatedAt: Date.now(),
    };
    const i = this.prompts.findIndex((p) => p.id === prompt.id);
    if (i >= 0) this.prompts[i] = prompt;
    else this.prompts.push(prompt);
    this.save_();
    return prompt;
  }

  remove(id: string): void {
    this.prompts = this.prompts.filter((p) => p.id !== id);
    this.save_();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      this.prompts = (JSON.parse(readFileSync(this.file, "utf8")).prompts ?? []) as Prompt[];
    } catch {
      /* start empty on a corrupt file */
    }
  }
  private save_(): void {
    writeFileSync(this.file, JSON.stringify({ prompts: this.prompts }, null, 2));
  }
}
