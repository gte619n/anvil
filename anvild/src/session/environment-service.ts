/**
 * Environment (project) domain — CRUD over the EnvironmentStore + git-URL clone + README rendering.
 * Third slice of the P7 god-file decomposition. This domain is genuinely low-coupling (no session/driver
 * state), so the injected deps are just the store, the broadcast registry, the clones dir, and the
 * markdown renderer. Supervisor keeps a thin `environmentsEvent()` that delegates here (it's read by
 * several other Supervisor domains + the AccountRosterService), and delegates the env commands.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION, type Environment, type EnvironmentValidation, type EnvironmentsEvent } from "@protocol";
import { now } from "../util/envelope";
import * as git from "../git/ops";
import type { ConnectionRegistry } from "../server/registry";
import type { EnvironmentStore } from "../env/store";
import type { MarkdownRenderer } from "../render/markdown";
import { BadCommand } from "./errors";

export interface EnvironmentServiceDeps {
  envStore: EnvironmentStore;
  registry: ConnectionRegistry;
  /** Clone destination for repos added by git URL (see `Config.clonesDir`). */
  clonesDir: string;
  renderer: MarkdownRenderer;
}

export class EnvironmentService {
  constructor(private readonly deps: EnvironmentServiceDeps) {}

  private get envStore(): EnvironmentStore {
    return this.deps.envStore;
  }

  environmentsEvent(): EnvironmentsEvent {
    return { v: PROTOCOL_VERSION, type: "environments", ts: now(), environments: this.envStore.list() };
  }

  getEnvironment(id: string): Environment | undefined {
    return this.envStore.get(id);
  }

  addEnvironment(name: string, repoRoot: string, defaultBase?: string, color?: string, icon?: string): void {
    try {
      this.envStore.add(name, repoRoot, defaultBase, color, icon);
    } catch (e) {
      throw new BadCommand(e instanceof Error ? e.message : String(e));
    }
    this.deps.registry.toAll(this.environmentsEvent());
  }

  /** Clone a git URL into `clonesDir` (host git auth) and register it as an environment. */
  cloneEnvironment(url: string, name?: string, defaultBase?: string, color?: string, icon?: string): void {
    let dest: string;
    try {
      dest = git.cloneRepo(url, this.deps.clonesDir).dest;
    } catch (e) {
      throw new BadCommand(e instanceof Error ? e.message : String(e));
    }
    try {
      this.envStore.add(name?.trim() || git.repoNameFromUrl(url), dest, defaultBase, color, icon);
    } catch (e) {
      throw new BadCommand(e instanceof Error ? e.message : String(e));
    }
    this.deps.registry.toAll(this.environmentsEvent());
  }

  /** Read & render an environment repo's README (arch §8). */
  envReadme(id: string): { markdown?: ReturnType<MarkdownRenderer["render"]>; text?: string; missing?: boolean } {
    const env = this.envStore.get(id);
    if (!env) throw new BadCommand(`no such environment: ${id}`);
    for (const name of ["README.md", "README.markdown", "Readme.md", "readme.md", "README", "README.txt"]) {
      const p = join(env.repoRoot, name);
      if (existsSync(p)) {
        const raw = readFileSync(p, "utf8").slice(0, 256 * 1024);
        const isMd = /\.(md|markdown)$/i.test(name) || name === "README";
        return isMd ? { markdown: this.deps.renderer.render(raw) } : { text: raw };
      }
    }
    return { missing: true };
  }

  updateEnvironment(
    id: string,
    fields: {
      name?: string;
      defaultBase?: string;
      color?: string;
      icon?: string;
      todoistProjectId?: string | null;
      validation?: EnvironmentValidation | null;
      accountId?: string | null;
    },
  ): void {
    this.envStore.update(id, fields);
    this.deps.registry.toAll(this.environmentsEvent());
  }

  removeEnvironment(id: string): void {
    this.envStore.remove(id);
    this.deps.registry.toAll(this.environmentsEvent());
  }
}
