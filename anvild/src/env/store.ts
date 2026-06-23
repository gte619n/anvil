import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Environment, EnvironmentValidation } from "@protocol";
import { newId } from "../util/ids";

/**
 * Registry of project repos (arch §8). Persisted to `<stateDir>/environments.json`. An
 * environment is just a named git repo; picking one + a session name spins up a fresh
 * worktree off it. Adding validates that the path is actually a git repo.
 */
export class EnvironmentStore {
  private readonly file: string;
  private environments: Environment[] = [];

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, "environments.json");
    this.load();
  }

  list(): Environment[] {
    return [...this.environments];
  }
  get(id: string): Environment | undefined {
    return this.environments.find((e) => e.id === id);
  }

  /** @throws if `repoRoot` doesn't exist or isn't a git repo (environments are git repos). */
  add(name: string, repoRoot: string, defaultBase?: string, color?: string): Environment {
    if (!existsSync(repoRoot)) {
      throw new Error(`no such directory: ${repoRoot}`);
    }
    if (!existsSync(join(repoRoot, ".git"))) {
      throw new Error(`not a git repository: ${repoRoot} — environments must be git repos`);
    }
    const env: Environment = {
      id: newId("env"),
      name: name.trim() || (repoRoot.split("/").filter(Boolean).pop() ?? "environment"),
      repoRoot,
      isRepo: existsSync(join(repoRoot, ".git")),
      defaultBase,
      ...(color?.trim() ? { color: color.trim() } : {}),
    };
    this.environments.push(env);
    this.save();
    return env;
  }

  update(
    id: string,
    fields: {
      name?: string;
      defaultBase?: string;
      color?: string;
      todoistProjectId?: string | null;
      validation?: EnvironmentValidation | null;
    },
  ): void {
    const env = this.environments.find((e) => e.id === id);
    if (!env) return;
    if (fields.name !== undefined && fields.name.trim()) env.name = fields.name.trim();
    if (fields.defaultBase !== undefined) env.defaultBase = fields.defaultBase.trim() || undefined;
    if (fields.color !== undefined) env.color = fields.color.trim() || undefined;
    // null explicitly clears the link/gate; undefined leaves it untouched.
    if (fields.todoistProjectId !== undefined)
      env.todoistProjectId = fields.todoistProjectId?.trim() || undefined;
    if (fields.validation !== undefined)
      env.validation = fields.validation && fields.validation.commands.length ? fields.validation : undefined;
    this.save();
  }

  remove(id: string): void {
    this.environments = this.environments.filter((e) => e.id !== id);
    this.save();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      this.environments = (JSON.parse(readFileSync(this.file, "utf8")).environments ?? []) as Environment[];
    } catch {
      /* start empty on a corrupt file */
    }
  }
  private save(): void {
    writeFileSync(this.file, JSON.stringify({ environments: this.environments }, null, 2));
  }
}
