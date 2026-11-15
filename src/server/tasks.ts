import { db, newId, now } from "./db";
import { badRequest, conflict, notFound } from "./errors";
import { emit } from "./events";
import { getProject } from "./projects";
import { createSession } from "./sessions";
import { ensureTaskWorktree } from "./worktrees";
import type { ToolId } from "./tools";

export const STATUSES = ["todo", "doing", "review", "done"] as const;
export type TaskStatus = (typeof STATUSES)[number];
export type TaskSource = "you" | "agent" | "session";
export type Plan = { done: number; total: number; current: string | null; items: { content: string; status: string }[] };

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
  queued: number;
  plan: string | null;
  summary: string | null;
  source: TaskSource;
  worktree_path: string | null;
  worktree_branch: string | null;
};

export type Autopilot = { on: boolean; tool: ToolId; accountId: string | null; yolo: boolean };

const isStatus = (s: unknown): s is TaskStatus => typeof s === "string" && (STATUSES as readonly string[]).includes(s);

function topPosition(status: TaskStatus): number {
  const r = db.query("SELECT MIN(position) AS p FROM tasks WHERE status = ?").get(status) as { p: number | null };
  return r.p === null ? 0 : r.p - 1;
}
function bottomPosition(status: TaskStatus): number {
  const r = db.query("SELECT MAX(position) AS p FROM tasks WHERE status = ?").get(status) as { p: number | null };
  return r.p === null ? 0 : r.p + 1;
}

export function projectAutopilot(projectId: string | null): Autopilot | null {
  if (!projectId) return null;
  const r = db.query("SELECT autopilot FROM projects WHERE id = ?").get(projectId) as { autopilot: string | null } | null;
  if (!r?.autopilot) return null;
  try {
    return JSON.parse(r.autopilot) as Autopilot;
  } catch {
    return null;
  }
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
    .query(`SELECT id, task_id, tool, status, agent_state, auto FROM sessions WHERE task_id IS NOT NULL AND status != 'closed'`)
    .all() as { id: string; task_id: string; tool: ToolId; status: string; agent_state: string | null; auto: number }[];
  const byTask = new Map<string, typeof links>();
  for (const l of links) byTask.set(l.task_id, [...(byTask.get(l.task_id) ?? []), l]);
  return rows.map((t) => ({ ...t, plan: t.plan ? (JSON.parse(t.plan) as Plan) : null, sessions: byTask.get(t.id) ?? [] }));
}

export function getTask(id: string): Task | null {
  return db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Task | null;
}

const clampPriority = (p: unknown) => Math.max(0, Math.min(3, Math.floor(Number(p) || 0)));
const startingTasks = new Set<string>();

export function createTask(o: {
  title?: unknown;
  body?: unknown;
  projectId?: unknown;
  status?: unknown;
  priority?: unknown;
  queued?: unknown;
  source?: TaskSource;
}) {
  const title = String(o.title ?? "").trim();
  if (!title) throw badRequest("a task needs a title");
  const projectId = o.projectId ? String(o.projectId) : null;
  if (projectId && !getProject(projectId)) throw badRequest("no such project");
  const status = isStatus(o.status) ? o.status : "todo";
  const source = o.source ?? "you";
  // Projects on autopilot queue every task you add; agents' own follow-ups wait for you.
  const queued = o.queued !== undefined ? !!o.queued : source === "you" && status === "todo" && !!projectAutopilot(projectId)?.on;
  const id = newId("t");
  const t = now();
  // Queued work runs oldest-first, so it goes to the bottom; everything else to the top.
  const position = queued ? bottomPosition(status) : topPosition(status);
  db.query(
    `INSERT INTO tasks (id, project_id, title, body, status, priority, position, created_at, updated_at, done_at, queued, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, title.slice(0, 300), String(o.body ?? ""), status, clampPriority(o.priority), position, t, t, status === "done" ? t : null, queued ? 1 : 0, source);
  emit("tasks");
  return getTask(id)!;
}

export function updateTask(
  id: string,
  patch: { title?: unknown; body?: unknown; status?: unknown; projectId?: unknown; priority?: unknown; position?: unknown; queued?: unknown },
) {
  const cur = getTask(id);
  if (!cur) throw notFound("no such task");
  const next = { ...cur };
  if (patch.title !== undefined) {
    const title = String(patch.title).trim();
    if (!title) throw badRequest("a task needs a title");
    next.title = title.slice(0, 300);
  }
  if (patch.body !== undefined) next.body = String(patch.body);
  if (patch.priority !== undefined) next.priority = clampPriority(patch.priority);
  if (patch.projectId !== undefined) {
    const pid = patch.projectId ? String(patch.projectId) : null;
    if (pid && !getProject(pid)) throw badRequest("no such project");
    if (cur.worktree_path && pid !== cur.project_id) throw conflict("this task already has a worktree; keep it in its current project");
    next.project_id = pid;
  }
  if (patch.status !== undefined) {
    if (!isStatus(patch.status)) throw badRequest("bad status");
    if (patch.status !== cur.status) {
      next.status = patch.status;
      next.done_at = patch.status === "done" ? now() : null;
      if (patch.position === undefined) next.position = topPosition(patch.status);
      if (patch.status !== "todo") next.queued = 0;
    }
  }
  if (patch.queued !== undefined) {
    next.queued = patch.queued ? 1 : 0;
    if (next.queued && !next.project_id) throw conflict("pick a project first — the agent works inside it");
  }
  if (patch.position !== undefined && Number.isFinite(Number(patch.position))) next.position = Number(patch.position);
  next.updated_at = now();
  db.query(
    `UPDATE tasks SET project_id = ?, title = ?, body = ?, status = ?, priority = ?, position = ?, updated_at = ?, done_at = ?, queued = ? WHERE id = ?`,
  ).run(next.project_id, next.title, next.body, next.status, next.priority, next.position, next.updated_at, next.done_at, next.queued, id);
  emit("tasks");
  return next;
}

export function deleteTask(id: string) {
  if (!db.query("DELETE FROM tasks WHERE id = ?").run(id).changes) throw notFound("no such task");
  emit("tasks");
}

/** The first message an agent gets for a backlog task: the task, plus how to work it. */
function taskPrompt(task: Task): string {
  return [
    `Backlog task: ${task.title}`,
    task.worktree_path
      ? `Worktree: ${task.worktree_path} (branch ${task.worktree_branch}). This is your own checkout: commit your work on this branch as you go, with clear messages. The user reviews the diff and merges it from ansai.`
      : "",
    task.body.trim(),
    [
      "How to work this task:",
      "- First check it is clear. If it is ambiguous or needs a decision from me, ask me before changing anything, and wait for my answer.",
      "- Keep to this task. Record unrelated problems you notice with the ansai add_task tool instead of fixing them now.",
      "- When it is done, call the ansai finish_task tool with a 2-3 sentence summary, then tell me how to verify it.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Start an agent on a task: the task becomes its first prompt, and the task moves to "doing". */
export async function runTask(id: string, o: { tool: ToolId; yolo?: boolean; accountId?: string | null; auto?: boolean }) {
  const task = getTask(id);
  if (!task) throw notFound("no such task");
  if (!task.project_id) throw conflict("pick a project for this task first");
  if (o.tool === "shell") throw badRequest("pick an agent, not a shell");
  if (startingTasks.has(id)) throw conflict("this task is already starting");
  if (db.query("SELECT 1 FROM sessions WHERE task_id = ? AND status = 'running'").get(id)) {
    throw conflict("this task already has a running agent session");
  }
  startingTasks.add(id);
  try {
    const project = getProject(task.project_id);
    if (!project) throw conflict("this task's project no longer exists");
    const worktree = await ensureTaskWorktree(task, project.path);
    const launchTask = worktree ? { ...task, worktree_path: worktree.path, worktree_branch: worktree.branch } : task;
    const session = await createSession({
      projectId: task.project_id,
      cwd: worktree?.cwd,
      tool: o.tool,
      prompt: taskPrompt(launchTask),
      title: task.title,
      yolo: o.yolo,
      accountId: o.accountId ?? null,
      taskId: task.id,
      auto: o.auto,
    });
    db.query("UPDATE tasks SET queued = 0, summary = NULL, plan = NULL WHERE id = ?").run(id);
    if (task.status === "todo" || task.status === "done") updateTask(id, { status: "doing" });
    else emit("tasks");
    return session;
  } finally {
    startingTasks.delete(id);
  }
}

/** Called by an agent (MCP finish_task): record its summary and hand the task back for review. */
export function finishTask(id: string, summary: string) {
  const task = getTask(id);
  if (!task) throw notFound("no such task");
  db.query("UPDATE tasks SET summary = ?, updated_at = ? WHERE id = ?").run(summary.slice(0, 4000), now(), id);
  if (task.status !== "done") updateTask(id, { status: "review" });
  else emit("tasks");
}

/** The agent's own plan (Claude TodoWrite / Codex update_plan) mirrored onto its task. */
export function setPlan(taskId: string, items: { content: string; status: string }[]) {
  const done = items.filter((i) => i.status === "completed").length;
  const current = items.find((i) => i.status === "in_progress")?.content ?? null;
  const plan: Plan = { done, total: items.length, current, items: items.slice(0, 40) };
  const json = JSON.stringify(plan);
  const r = db.query("UPDATE tasks SET plan = ? WHERE id = ? AND COALESCE(plan, '') != ?").run(json, taskId, json);
  if (r.changes) emit("tasks");
}
