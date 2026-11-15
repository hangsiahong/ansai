import { db, newId, now } from "./db";
import { emit } from "./events";
import { getProject } from "./projects";
import { createSession } from "./sessions";
import type { ToolId } from "./tools";

export const STATUSES = ["todo", "doing", "review", "done"] as const;
export type TaskStatus = (typeof STATUSES)[number];

export type Task = {
  id: string;
  project_id: string | null;
  title: string;
  body: string;
  status: TaskStatus;
  priority: number;
  position: number;
  created_at: number;
  updated_at: number;
  done_at: number | null;
};

const isStatus = (s: unknown): s is TaskStatus => typeof s === "string" && (STATUSES as readonly string[]).includes(s);

function topPosition(status: TaskStatus): number {
  const r = db.query("SELECT MIN(position) AS p FROM tasks WHERE status = ?").get(status) as { p: number | null };
  return r.p === null ? 0 : r.p - 1;
}

export function listTasks() {
  // Open tasks plus anything finished in the last 30 days.
  const cutoff = now() - 30 * 86400_000;
  const rows = db
    .query(
      `SELECT t.*, p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.status != 'done' OR COALESCE(t.done_at, t.updated_at) > ?
       ORDER BY t.position ASC`,
    )
    .all(cutoff) as (Task & { project_name: string | null })[];
  const links = db
    .query(`SELECT id, task_id, tool, status FROM sessions WHERE task_id IS NOT NULL AND status != 'closed'`)
    .all() as { id: string; task_id: string; tool: ToolId; status: string }[];
  const byTask = new Map<string, typeof links>();
  for (const l of links) byTask.set(l.task_id, [...(byTask.get(l.task_id) ?? []), l]);
  return rows.map((t) => ({ ...t, sessions: byTask.get(t.id) ?? [] }));
}

export function getTask(id: string): Task | null {
  return db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Task | null;
}

export function createTask(o: { title?: unknown; body?: unknown; projectId?: unknown; status?: unknown; priority?: unknown }) {
  const title = String(o.title ?? "").trim();
  if (!title) throw new Error("a task needs a title");
  const projectId = o.projectId ? String(o.projectId) : null;
  if (projectId && !getProject(projectId)) throw new Error("no such project");
  const status = isStatus(o.status) ? o.status : "todo";
  const id = newId("t");
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, body, status, priority, position, created_at, updated_at, done_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, title.slice(0, 300), String(o.body ?? ""), status, clampPriority(o.priority), topPosition(status), t, t, status === "done" ? t : null);
  emit("tasks");
  return getTask(id)!;
}

const clampPriority = (p: unknown) => Math.max(0, Math.min(3, Math.floor(Number(p) || 0)));

export function updateTask(
  id: string,
  patch: { title?: unknown; body?: unknown; status?: unknown; projectId?: unknown; priority?: unknown; position?: unknown },
) {
  const cur = getTask(id);
  if (!cur) throw new Error("no such task");
  const next = { ...cur };
  if (patch.title !== undefined) {
    const title = String(patch.title).trim();
    if (!title) throw new Error("a task needs a title");
    next.title = title.slice(0, 300);
  }
  if (patch.body !== undefined) next.body = String(patch.body);
  if (patch.priority !== undefined) next.priority = clampPriority(patch.priority);
  if (patch.projectId !== undefined) {
    const pid = patch.projectId ? String(patch.projectId) : null;
    if (pid && !getProject(pid)) throw new Error("no such project");
    next.project_id = pid;
  }
  if (patch.status !== undefined) {
    if (!isStatus(patch.status)) throw new Error("bad status");
    if (patch.status !== cur.status) {
      next.status = patch.status;
      next.done_at = patch.status === "done" ? now() : null;
      if (patch.position === undefined) next.position = topPosition(patch.status);
    }
  }
  if (patch.position !== undefined && Number.isFinite(Number(patch.position))) next.position = Number(patch.position);
  next.updated_at = now();
  db.query(
    `UPDATE tasks SET project_id = ?, title = ?, body = ?, status = ?, priority = ?, position = ?, updated_at = ?, done_at = ? WHERE id = ?`,
  ).run(next.project_id, next.title, next.body, next.status, next.priority, next.position, next.updated_at, next.done_at, id);
  emit("tasks");
  return next;
}

export function deleteTask(id: string) {
  db.query("DELETE FROM tasks WHERE id = ?").run(id);
  emit("tasks");
}

/** Start an agent on a task: the task text becomes the first prompt, and the task moves to "doing". */
export async function runTask(id: string, o: { tool: ToolId; yolo?: boolean; accountId?: string | null; extra?: string }) {
  const task = getTask(id);
  if (!task) throw new Error("no such task");
  if (!task.project_id) throw new Error("pick a project for this task first");
  if (o.tool === "shell") throw new Error("pick an agent, not a shell");
  const prompt = [task.title, task.body.trim(), o.extra?.trim()].filter(Boolean).join("\n\n");
  const session = await createSession({
    projectId: task.project_id,
    tool: o.tool,
    prompt,
    title: task.title,
    yolo: o.yolo,
    accountId: o.accountId ?? null,
    taskId: task.id,
  });
  if (task.status === "todo" || task.status === "done") updateTask(id, { status: "doing" });
  else emit("tasks");
  return session;
}
