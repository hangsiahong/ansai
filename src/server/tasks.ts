import { db, newId, now } from "./db";
import { badRequest, conflict, notFound } from "./errors";
import { emit } from "./events";
import { getProject } from "./projects";
import { closeSession, createSession, getSession } from "./sessions";
import { cleanUpDoneTask, ensureTaskWorktree, removeTaskWorktreeSafely, type DoneCleanup } from "./worktrees";
import { changesIn, taskDir } from "./changes";
import type { ToolId } from "./tools";
import { checkAgySignIn } from "./accounts";
import { agySignInHint } from "./agyauth";
import { checksRunning, getChecks, parseChecks, type ChecksState } from "./checks";
import { dropEvidence, parseEvidence, type Evidence } from "./evidence";

export const STATUSES = ["todo", "doing", "review", "done"] as const;
export type TaskStatus = (typeof STATUSES)[number];
export type TaskSource = "you" | "agent" | "session";
export type Plan = { done: number; total: number; current: string | null; items: { content: string; status: string }[] };
export type TaskDependency = { id: string; title: string; status: TaskStatus };

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
  /** Autopilot retries used, and why the last run stopped early (null if it didn't). */
  attempts: number;
  last_failure: string | null;
  /** JSON: ChecksState (checks.ts) and Evidence[] (evidence.ts), set at finish_task. */
  checks: string | null;
  evidence: string | null;
  dependencies?: TaskDependency[];
  blocked_by?: TaskDependency[];
};

export type ReviewFinding = { file: string; line: number; severity: "high" | "medium" | "low"; message: string };
export type TaskReview = { session_id: string | null; reviewer_tool: "claude" | "codex"; status: "running" | "complete" | "stopped"; summary: string | null; findings: ReviewFinding[] };

export type Autopilot = {
  on: boolean;
  tool: ToolId;
  accountId: string | null;
  yolo: boolean;
  /** null = the agent's own default. Saved before these existed → undefined, same meaning. */
  model?: string | null;
  effort?: string | null;
  /** Time limit per run, in minutes (null = none). */
  maxMinutes?: number | null;
};

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
    .query(`SELECT id, task_id, tool, title, status, agent_state, auto FROM sessions WHERE task_id IS NOT NULL AND status != 'closed' ORDER BY created_at DESC`)
    .all() as { id: string; task_id: string; tool: ToolId; title: string; status: string; agent_state: string | null; auto: number }[];
  const byTask = new Map<string, typeof links>();
  for (const l of links) byTask.set(l.task_id, [...(byTask.get(l.task_id) ?? []), l]);
  const dependencies = db.query(
    `SELECT d.task_id, p.id, p.title, p.status FROM task_dependencies d JOIN tasks p ON p.id = d.depends_on_task_id ORDER BY p.position, p.title`,
  ).all() as ({ task_id: string } & TaskDependency)[];
  const byDependency = new Map<string, TaskDependency[]>();
  for (const d of dependencies) byDependency.set(d.task_id, [...(byDependency.get(d.task_id) ?? []), { id: d.id, title: d.title, status: d.status }]);
  const reviews = db.query(`SELECT r.*, s.status AS session_status FROM task_reviews r LEFT JOIN sessions s ON s.id = r.session_id`).all() as ({ task_id: string; session_id: string | null; reviewer_tool: "claude" | "codex"; status: "running" | "complete" | "stopped"; summary: string | null; findings: string; session_status: string | null })[];
  const byReview = new Map(reviews.map((r) => [r.task_id, { session_id: r.session_id, reviewer_tool: r.reviewer_tool, status: r.status === "running" && r.session_status !== "running" ? "stopped" as const : r.status, summary: r.summary, findings: JSON.parse(r.findings) as ReviewFinding[] }]));
  return rows.map((t) => {
    const deps = byDependency.get(t.id) ?? [];
    return { ...t, ...doneText(t), plan: t.plan ? (JSON.parse(t.plan) as Plan) : null, checks: liveChecks(t), evidence: parseEvidence(t.evidence), sessions: byTask.get(t.id) ?? [], dependencies: deps, blocked_by: deps.filter((d) => d.status !== "done"), review: byReview.get(t.id) ?? null };
  });
}

/** How much of a done task's body and summary the live list carries: enough to search and to show it has details. */
export const DONE_PREVIEW = 120;

/**
 * Done tasks pile up (dozens a day) and their text is most of the list, which is pushed to
 * every open screen on each change. The list carries the start of it with cut: true; the
 * task sheet loads the rest (taskText) when one is opened.
 */
function doneText(t: Pick<Task, "status" | "body" | "summary">): { body: string; summary: string | null; cut?: true } {
  if (t.status !== "done" || (t.body.length <= DONE_PREVIEW && (t.summary ?? "").length <= DONE_PREVIEW)) return { body: t.body, summary: t.summary };
  return { body: t.body.slice(0, DONE_PREVIEW), summary: t.summary === null ? null : t.summary.slice(0, DONE_PREVIEW), cut: true };
}

/** A task's full body and summary, for a screen that got it cut from the list. */
export function taskText(id: string): { body: string; summary: string | null } | null {
  return db.query("SELECT body, summary FROM tasks WHERE id = ?").get(id) as { body: string; summary: string | null } | null;
}

// A "running" left behind by a restart mid-run would otherwise spin forever.
function liveChecks(t: Task): ChecksState | null {
  const c = parseChecks(t.checks);
  return c && "running" in c && !checksRunning(t.id) ? null : c;
}

/** Start a separate, constrained reviewer in the task's existing worktree. */
export async function startTaskReview(id: string, reviewer?: "claude" | "codex") {
  const task = getTask(id);
  if (!task) throw notFound("no such task");
  if (task.status !== "review") throw conflict("the task must be in Review first");
  if (!task.project_id || !task.worktree_path) throw conflict("this task needs a project worktree before it can be reviewed");
  const project = getProject(task.project_id);
  if (!project) throw conflict("this task's project no longer exists");
  const previous = db.query("SELECT session_id, status FROM task_reviews WHERE task_id = ?").get(id) as { session_id: string | null; status: string } | null;
  if (previous?.status !== "complete" && previous?.session_id && db.query("SELECT 1 FROM sessions WHERE id = ? AND status = 'running'").get(previous.session_id)) throw conflict("the reviewer is still running");
  if (previous?.status === "complete" && previous.session_id && getSession(previous.session_id)?.status === "running") await closeSession(previous.session_id);
  const implementer = db.query("SELECT tool FROM sessions WHERE task_id = ? AND title NOT LIKE 'Review · %' AND id != COALESCE(?, '') ORDER BY created_at DESC LIMIT 1").get(id, previous?.session_id ?? "") as { tool: string } | null;
  const tool = reviewer ?? (implementer?.tool === "claude" ? "codex" : "claude");
  if (tool !== "claude" && tool !== "codex") throw badRequest("choose Claude or Codex as the reviewer");
  const dir = await taskDir(task, project.path);
  const changes = await changesIn(dir);
  const prompt = [
    `Independent review for backlog task: ${task.title}`,
    `Requirements (task body):\n${task.body || "(no additional details)"}`,
    `Review the task's complete diff in this worktree against merge-base ${changes.base.sha} (${changes.base.label}). Use that commit as the diff base, including commits and uncommitted changes. Worktree: ${task.worktree_path}. Do not edit, create, or delete files.`,
    "Find correctness bugs, regressions, and unmet requirements. Ignore style preferences. For each actionable issue call ansai report_finding with file, line, severity (high, medium, or low), and a concise message. If there are no findings, call no report_finding tools. When your inspection is complete, call ansai finish_review with a concise summary. Do not call finish_task.",
  ].join("\n\n");
  const session = await createSession({ projectId: task.project_id, cwd: dir, tool, title: `Review · ${task.title}`, prompt, taskId: task.id, readOnly: true,
    instructions: "You are an independent code reviewer. You may inspect files and run read-only commands, but must not modify the worktree. Report actionable findings using ansai report_finding, then call ansai finish_review. Do not use finish_task.",
    onCreated: (sessionId) => db.query(`INSERT INTO task_reviews (task_id, session_id, reviewer_tool, status, summary, findings, updated_at) VALUES (?, ?, ?, 'running', NULL, '[]', ?) ON CONFLICT(task_id) DO UPDATE SET session_id=excluded.session_id, reviewer_tool=excluded.reviewer_tool, status='running', summary=NULL, findings='[]', updated_at=excluded.updated_at`).run(id, sessionId, tool, now()),
  });
  emit("tasks");
  return session;
}

export function reportReviewFinding(sessionId: string, finding: ReviewFinding) {
  const review = db.query("SELECT * FROM task_reviews WHERE session_id = ?").get(sessionId) as { task_id: string; status: string; findings: string } | null;
  if (!review || review.status !== "running") throw conflict("this session is not the active reviewer for a task");
  if (!finding.file.trim() || !Number.isInteger(finding.line) || finding.line < 1 || !finding.message.trim()) throw badRequest("finding needs a file, positive line, and message");
  const findings = JSON.parse(review.findings) as ReviewFinding[];
  findings.push({ ...finding, file: finding.file.trim(), message: finding.message.trim().slice(0, 2000) });
  db.query("UPDATE task_reviews SET findings = ?, updated_at = ? WHERE task_id = ?").run(JSON.stringify(findings), now(), review.task_id);
  emit("tasks");
}

export function finishTaskReview(sessionId: string, summary: string) {
  const r = db.query("UPDATE task_reviews SET status = 'complete', summary = ?, updated_at = ? WHERE session_id = ? AND status = 'running'").run(summary.trim().slice(0, 4000), now(), sessionId);
  if (!r.changes) throw conflict("this session is not the active reviewer for a task");
  emit("tasks");
  if (getSession(sessionId)?.title.startsWith("Review · ")) setTimeout(() => void closeSession(sessionId).catch((e) => console.error("[ansai] could not close finished reviewer:", e)), 500);
}

function dependencyList(id: string): TaskDependency[] {
  return db.query(`SELECT p.id, p.title, p.status FROM task_dependencies d JOIN tasks p ON p.id = d.depends_on_task_id WHERE d.task_id = ? ORDER BY p.position, p.title`).all(id) as TaskDependency[];
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
  patch: { title?: unknown; body?: unknown; status?: unknown; projectId?: unknown; priority?: unknown; position?: unknown; queued?: unknown; dependencies?: unknown },
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
    const hasDependencies = db.query("SELECT 1 FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ? LIMIT 1").get(id, id);
    if (hasDependencies && pid !== cur.project_id) throw conflict("tasks with dependencies must stay in their current project");
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
  if (patch.dependencies !== undefined) {
    if (!Array.isArray(patch.dependencies) || patch.dependencies.some((x) => typeof x !== "string")) throw badRequest("dependencies must be a list of task ids");
    const deps = [...new Set(patch.dependencies as string[])];
    for (const depId of deps) {
      const dep = getTask(depId);
      if (!dep) throw badRequest("a dependency task does not exist");
      if (dep.id === id) throw badRequest("a task cannot depend on itself");
      if (dep.project_id !== next.project_id) throw conflict("dependencies must be in the same project");
      // Adding id -> depId is invalid if depId already depends (transitively) on id.
      const cycle = db.query(`WITH RECURSIVE downstream(id) AS (
        SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?
        UNION SELECT d.depends_on_task_id FROM task_dependencies d JOIN downstream x ON d.task_id = x.id
      ) SELECT 1 FROM downstream WHERE id = ? LIMIT 1`).get(depId, id);
      if (cycle) throw badRequest("that dependency would create a cycle");
    }
    db.transaction(() => {
      db.query("DELETE FROM task_dependencies WHERE task_id = ?").run(id);
      for (const depId of deps) db.query("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)").run(id, depId);
    })();
  }
  next.updated_at = now();
  db.query(
    `UPDATE tasks SET project_id = ?, title = ?, body = ?, status = ?, priority = ?, position = ?, updated_at = ?, done_at = ?, queued = ? WHERE id = ?`,
  ).run(next.project_id, next.title, next.body, next.status, next.priority, next.position, next.updated_at, next.done_at, next.queued, id);
  emit("tasks");
  const deps = dependencyList(id);
  return { ...next, dependencies: deps, blocked_by: deps.filter((d) => d.status !== "done") };
}

/**
 * `updateTask`, as `PATCH /api/tasks/:id` calls it. Marking a task Done also clears what it
 * no longer needs, when nothing can be lost (worktrees.ts `cleanUpDoneTask`): its idle agents,
 * its worktree and its branch. `cleanup` says what went, so the web UI can tell you; it is
 * left out when nothing did. Merge sets Done itself and has already cleaned up, so it calls
 * `updateTask` and doesn't come through here.
 */
export async function patchTask(id: string, patch: Parameters<typeof updateTask>[1], close: (sessionId: string) => Promise<void> = closeSession) {
  const was = getTask(id)?.status;
  const task = updateTask(id, patch);
  if (task.status !== "done" || was === "done") return task;
  const cleanup: DoneCleanup | null = await cleanUpDoneTask(task, close);
  if (!cleanup) return task;
  return { ...task, ...(cleanup.worktree ? { worktree_path: null, worktree_branch: null } : {}), cleanup };
}

export async function deleteTask(id: string) {
  const task = getTask(id);
  if (!task) throw notFound("no such task");
  // The task's worktree and branch go with it, unless that would lose work (409).
  await removeTaskWorktreeSafely(task);
  if (!db.query("DELETE FROM tasks WHERE id = ?").run(id).changes) throw notFound("no such task");
  await dropEvidence(id);
  emit("tasks");
}

/** The first message an agent gets for a backlog task: the task, plus how to work it. */
/**
 * A rerun shouldn't start from zero: tell the new agent what the last run said
 * and what is already on the task's branch, so it carries on instead of
 * rebuilding everything (and possibly redoing the work).
 */
export async function handoff(task: Task, dir: string | null): Promise<string> {
  const lines: string[] = [];
  if (task.summary?.trim()) lines.push(`The last run's summary: ${task.summary.trim()}`);
  if (dir && task.worktree_path) {
    try {
      const c = await changesIn(dir);
      if (c.commits.length)
        lines.push(
          `Already committed on ${c.branch ?? "this branch"} (newest first):`,
          ...c.commits.slice(0, 15).map((k) => `- ${k.sha.slice(0, 7)} ${k.subject}`),
        );
      if (c.uncommitted) lines.push(`${c.uncommitted} file${c.uncommitted === 1 ? " has" : "s have"} uncommitted changes from that run; check them with git status / git diff.`);
    } catch {}
  }
  if (!lines.length) return "";
  return ["This task was worked on before, in this same worktree. Pick up from there rather than starting over:", ...lines].join("\n");
}

/** `tools`: the agent has ansai's own tools (MCP). agy doesn't, and went looking for them for minutes when told to call one. */
export function taskPrompt(task: Task & { notes?: string[]; handoff?: string; checksCmd?: string }, tools = true): string {
  return [
    `Backlog task: ${task.title}`,
    task.worktree_path
      ? `Worktree: ${task.worktree_path} (branch ${task.worktree_branch}). This is your own checkout: commit your work on this branch as you go, with clear messages. The user reviews the diff and merges it from ansai.`
      : "",
    task.notes?.length ? ["Set up in this worktree:", ...task.notes.map((n) => `- ${n}`)].join("\n") : "",
    task.body.trim(),
    task.handoff ?? "",
    [
      "How to work this task:",
      "- First check it is clear. If it is ambiguous or needs a decision from me, ask me before changing anything, and wait for my answer.",
      tools
        ? "- Keep to this task. Record unrelated problems you notice with the ansai add_task tool instead of fixing them now."
        : "- Keep to this task. List unrelated problems you notice at the end instead of fixing them now.",
      tools
        ? "- When it is done, call the ansai finish_task tool with a 2-3 sentence summary, then tell me how to verify it. Pass `evidence` (paths to screenshots or a check log) when you have proof it works; I review from my phone and look at that first."
        : "- When it is done, stop and tell me in 2-3 sentences what changed and how to verify it.",
      tools && task.checksCmd
        ? `- finish_task first runs \`${task.checksCmd}\` in your working folder. If it fails, the task stays in Doing and you get the output back: fix it and call finish_task again.`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const AGY_SIGNED_OUT = "agy isn't signed in on this laptop.";

/** Start an agent on a task: the task becomes its first prompt, and the task moves to "doing". */
export async function runTask(
  id: string,
  o: { tool: ToolId; yolo?: boolean; accountId?: string | null; model?: string | null; effort?: string | null; auto?: boolean },
) {
  const task = getTask(id);
  if (!task) throw notFound("no such task");
  if (!task.project_id) throw conflict("pick a project for this task first");
  if (o.tool === "shell") throw badRequest("pick an agent, not a shell");
  // Signed out, agy would sit on its sign-in menu instead of working.
  if (o.tool === "agy" && (await checkAgySignIn(o.accountId ?? null)) === false) throw conflict(`${AGY_SIGNED_OUT} ${agySignInHint()} Then run the task again.`);
  if (startingTasks.has(id)) throw conflict("this task is already starting");
  if (db.query(`SELECT 1 FROM sessions s WHERE s.task_id = ? AND s.status = 'running'
    AND NOT EXISTS (SELECT 1 FROM task_reviews r WHERE r.session_id = s.id AND r.status = 'complete')`).get(id)) {
    throw conflict("this task already has a running agent session");
  }
  startingTasks.add(id);
  try {
    const project = getProject(task.project_id);
    if (!project) throw conflict("this task's project no longer exists");
    const rerun = !!task.worktree_path; // the worktree outlives a run, so it marks a task that ran before
    const worktree = await ensureTaskWorktree(task, project.path);
    const launchTask = {
      ...(worktree ? { ...task, worktree_path: worktree.path, worktree_branch: worktree.branch, notes: worktree.notes } : task),
      handoff: rerun || task.summary ? await handoff(task, worktree?.cwd ?? null) : "",
      checksCmd: task.project_id ? getChecks(task.project_id) : "",
    };
    const session = await createSession({
      projectId: task.project_id,
      cwd: worktree?.cwd,
      tool: o.tool,
      prompt: taskPrompt(launchTask, o.tool !== "agy"),
      title: task.title,
      yolo: o.yolo,
      model: o.model,
      effort: o.effort,
      accountId: o.accountId ?? null,
      taskId: task.id,
      auto: o.auto,
    });
    db.query("UPDATE schedule_occurrences SET status = 'running', outcome = NULL WHERE task_id = ?").run(task.id);
    // A run you start yourself resets autopilot's retry count.
    db.query("UPDATE tasks SET queued = 0, summary = NULL, plan = NULL, attempts = CASE WHEN ? THEN attempts ELSE 0 END WHERE id = ?").run(o.auto ? 1 : 0, id);
    if (task.status === "todo" || task.status === "done") updateTask(id, { status: "doing" });
    else emit("tasks");
    return session;
  } finally {
    startingTasks.delete(id);
  }
}

/** Called by an agent (MCP finish_task): record its summary and hand the task back for review. */
export function finishTask(id: string, summary: string, evidence: Evidence[] = []) {
  const task = getTask(id);
  if (!task) throw notFound("no such task");
  // A finished task starts its retry count over.
  db.query("UPDATE tasks SET summary = ?, evidence = ?, attempts = 0, last_failure = NULL, updated_at = ? WHERE id = ?").run(summary.slice(0, 4000), evidence.length ? JSON.stringify(evidence) : null, now(), id);
  db.query("UPDATE schedule_occurrences SET status = 'completed', outcome = ? WHERE task_id = ?").run(summary.slice(0, 1000), id);
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
