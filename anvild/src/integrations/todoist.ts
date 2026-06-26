/**
 * Thin client for the Todoist unified API (v1, `https://api.todoist.com/api/v1`).
 * Auth is a personal API token sent as `Authorization: Bearer <token>`. GET list endpoints
 * are cursor-paginated: `{ results, next_cursor }` — `getAll` walks the cursor for us.
 */
const API_BASE = "https://api.todoist.com/api/v1";
// A single hung request must never block a caller forever — Todoist calls are quick, so cap each one.
// (An autopilot run awaits many of these; without a per-call ceiling one stalled socket latches the
// whole run, and with it the "running" spinner. See TodoistClient's run-level signal too.)
const REQUEST_TIMEOUT_MS = 30_000;

export interface TodoistUser {
  id: string;
  email?: string;
  full_name?: string;
}

export interface TodoistProject {
  id: string;
  name: string;
  color?: string;
  parent_id?: string | null;
  is_archived?: boolean;
  is_inbox_project?: boolean;
  is_favorite?: boolean;
  view_style?: string;
  url?: string;
}

export interface TodoistSection {
  id: string;
  project_id: string;
  name: string;
  section_order?: number;
}

export interface TodoistLabel {
  id: string;
  name: string;
  color?: string;
  is_favorite?: boolean;
}

export interface TodoistDue {
  date: string;
  string?: string;
  is_recurring?: boolean;
  datetime?: string | null;
  timezone?: string | null;
}

export interface TodoistTask {
  id: string;
  project_id: string;
  section_id?: string | null;
  parent_id?: string | null;
  content: string;
  description?: string;
  priority?: number; // 1 (normal) .. 4 (urgent)
  labels?: string[];
  due?: TodoistDue | null;
  is_completed?: boolean;
  created_at?: string;
  url?: string;
}

export interface TodoistComment {
  id: string;
  task_id?: string;
  content: string;
  posted_at?: string;
}

interface Page<T> {
  results: T[];
  next_cursor?: string | null;
}

export class TodoistError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TodoistError";
  }
}

export class TodoistClient {
  constructor(
    private readonly token: string,
    /** Optional run-level abort: when the caller's run is cancelled (e.g. the autopilot watchdog), every
     *  in-flight request unwinds instead of hanging. Composed with a per-request timeout below. */
    private readonly signal?: AbortSignal,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // Abort the request when EITHER the run is cancelled OR this call outlives REQUEST_TIMEOUT_MS, so a
    // stalled connection can't latch a run (and the spinner) open. The run-level signal is optional.
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new TodoistError(
        `Todoist ${method} ${path} → ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`,
        res.status,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Walk a cursor-paginated list endpoint, accumulating all pages. */
  private async getAll<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({ ...params, limit: "200", ...(cursor ? { cursor } : {}) });
      const page = await this.request<Page<T>>("GET", `${path}?${qs.toString()}`);
      out.push(...(page.results ?? []));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return out;
  }

  /** Validate the token and return the authenticated user (throws TodoistError on bad token). */
  async whoami(): Promise<TodoistUser> {
    return this.request<TodoistUser>("GET", "/user");
  }

  projects(): Promise<TodoistProject[]> {
    return this.getAll<TodoistProject>("/projects");
  }

  sections(projectId?: string): Promise<TodoistSection[]> {
    return this.getAll<TodoistSection>("/sections", projectId ? { project_id: projectId } : {});
  }

  labels(): Promise<TodoistLabel[]> {
    return this.getAll<TodoistLabel>("/labels");
  }

  /** Active (non-completed) tasks, optionally scoped to a project. */
  tasks(projectId?: string): Promise<TodoistTask[]> {
    return this.getAll<TodoistTask>("/tasks", projectId ? { project_id: projectId } : {});
  }

  /** Active tasks carrying `label` (by name), across EVERY project in the account. */
  tasksByLabel(label: string): Promise<TodoistTask[]> {
    return this.getAll<TodoistTask>("/tasks", { label });
  }

  getTask(taskId: string): Promise<TodoistTask> {
    return this.request<TodoistTask>("GET", `/tasks/${taskId}`);
  }

  /** Replace a task's full label set (labels are by name in the v1 API). */
  setTaskLabels(taskId: string, labels: string[]): Promise<TodoistTask> {
    return this.request<TodoistTask>("POST", `/tasks/${taskId}`, { labels });
  }

  /** Complete a task (used when a WorkUnit's PR merges + validation passes). */
  closeTask(taskId: string): Promise<void> {
    return this.request<void>("POST", `/tasks/${taskId}/close`);
  }

  comments(taskId: string): Promise<TodoistComment[]> {
    return this.getAll<TodoistComment>("/comments", { task_id: taskId });
  }

  addComment(taskId: string, content: string): Promise<TodoistComment> {
    return this.request<TodoistComment>("POST", "/comments", { task_id: taskId, content });
  }
}
