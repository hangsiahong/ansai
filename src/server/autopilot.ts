import { db, getSetting, setSetting } from "./db";
import { emit } from "./events";
import { notFound } from "./errors";
import { getProject } from "./projects";
import { AGENT_TOOLS } from "./accounts";
import { getTask, projectAutopilot, runTask as startTask, type Autopilot, type Task } from "./tasks";

/** How autopilot starts a task (tests swap in a fake that doesn't launch agents). */
let runTask = startTask;
export function setTaskStarter(fn: typeof startTask) {
  runTask = fn;
}

/**
 * Autopilot: queued backlog tasks start on their own. Each task runs in its own
 * Git worktree, so tasks from the same project can run together, up to
 * `autopilotMax` autopilot agents overall.
 */

export type Settings = { autopilotMax: number; trackSessions: boolean };

export function getSettings(): Settings {
  return {
    autopilotMax: Math.max(1, Math.min(6, getSetting<number>("autopilot_max", 2))),
    trackSessions: getSetting<boolean>("track_sessions", true),
  };
}

export function updateSettings(patch: Partial<Settings>) {
  if (patch.autopilotMax !== undefined) setSetting("autopilot_max", Math.max(1, Math.min(6, Math.floor(Number(patch.autopilotMax) || 2))));
  if (patch.trackSessions !== undefined) setSetting("track_sessions", !!patch.trackSessions);
  return getSettings();
}

export function setProjectAutopilot(projectId: string, raw: Partial<Autopilot>): Autopilot {
  if (!getProject(projectId)) throw notFound("no such project");
  const cur = projectAutopilot(projectId) ?? { on: false, tool: "claude", accountId: null, yolo: false };
  const tool = raw.tool && (AGENT_TOOLS as string[]).includes(raw.tool) ? raw.tool : cur.tool;
  const sameTool = tool === cur.tool; // model ids belong to one agent; a new agent starts on its default
  const next: Autopilot = {
    on: raw.on !== undefined ? !!raw.on : cur.on,
    tool,
    accountId: raw.accountId !== undefined ? (raw.accountId ? String(raw.accountId) : null) : cur.accountId,
    yolo: raw.yolo !== undefined ? !!raw.yolo : cur.yolo,
    model: raw.model !== undefined ? raw.model || null : sameTool ? (cur.model ?? null) : null,
    effort: raw.effort !== undefined ? raw.effort || null : sameTool ? (cur.effort ?? null) : null,
  };
  db.query("UPDATE projects SET autopilot = ? WHERE id = ?").run(JSON.stringify(next), projectId);
  emit("projects");
  return next;
}

let ticking = false;

export async function autopilotTick() {
  if (ticking) return;
  ticking = true;
  try {
    const { autopilotMax } = getSettings();
    // Count active autopilot sessions, including agents that stopped to ask you
    // something (in review, but they haven't called finish_task yet).
    const active = db
      .query(
        `SELECT s.project_id, s.auto, t.worktree_path FROM sessions s JOIN tasks t ON t.id = s.task_id
         WHERE s.status = 'running' AND s.tool != 'shell'
           AND (t.status = 'doing' OR (t.status = 'review' AND t.summary IS NULL AND s.auto = 1))`,
      )
      .all() as { project_id: string | null; auto: number; worktree_path: string | null }[];
    let running = active.filter((a) => a.auto).length;
    // Non-Git projects keep using the shared project directory, so serialize
    // those tasks as before. Git worktrees have independent working folders.
    const busySharedProjects = new Set(active.filter((a) => !a.worktree_path).map((a) => a.project_id));
    if (running >= autopilotMax) return;

    const queued = db
      .query(`SELECT t.* FROM tasks t WHERE t.queued = 1 AND t.status = 'todo' AND t.project_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks prerequisite ON prerequisite.id = d.depends_on_task_id
          WHERE d.task_id = t.id AND prerequisite.status != 'done')
        ORDER BY t.priority DESC, t.created_at ASC`)
      .all() as Task[];
    for (const t of queued) {
      if (running >= autopilotMax) break;
      if (busySharedProjects.has(t.project_id)) continue;
      const ap = projectAutopilot(t.project_id) ?? { on: false, tool: "claude", accountId: null, yolo: false };
      try {
        await runTask(t.id, { tool: ap.tool, yolo: ap.yolo, accountId: ap.accountId, model: ap.model, effort: ap.effort, auto: true });
        running++;
        if (!getTask(t.id)?.worktree_path) busySharedProjects.add(t.project_id);
      } catch (e) {
        console.error(`[ansai] autopilot couldn't start "${t.title}":`, e instanceof Error ? e.message : e);
        db.query("UPDATE tasks SET queued = 0 WHERE id = ?").run(t.id); // don't retry forever
        emit("tasks");
      }
    }
  } finally {
    ticking = false;
  }
}

export function startAutopilot(ms = 4000) {
  const tick = () => autopilotTick().catch((e) => console.error("[ansai] autopilot:", e)).finally(() => setTimeout(tick, ms));
  setTimeout(tick, 3000);
}
