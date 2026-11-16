import { db, getSetting, setSetting } from "./db";
import { emit } from "./events";
import { notFound } from "./errors";
import { getProject } from "./projects";
import { AGENT_TOOLS, checkAgySignIn } from "./accounts";
import { agySignInHint } from "./agyauth";
import { notify } from "./push";
import { getTask, projectAutopilot, runTask as startTask, type Autopilot, type Task } from "./tasks";
import { scheduleTick, updateOccurrence } from "./schedules";
import { usesWorktrees } from "./worktrees";

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
    maxMinutes: raw.maxMinutes !== undefined ? raw.maxMinutes || null : (cur.maxMinutes ?? null),
  };
  db.query("UPDATE projects SET autopilot = ? WHERE id = ?").run(JSON.stringify(next), projectId);
  emit("projects");
  return next;
}

let ticking = false;

/** Queued tasks waiting for agy to be signed in; you hear about each once. */
const heldForSignIn = new Set<string>();
function holdForSignIn(t: Task) {
  if (heldForSignIn.has(t.id)) return;
  heldForSignIn.add(t.id);
  console.warn(`[ansai] autopilot is holding "${t.title}": agy isn't signed in`);
  notify("input", {
    title: `Autopilot is waiting · ${t.title}`,
    body: `agy isn't signed in, so this task stays queued until it is. ${agySignInHint()}`,
    url: t.project_id ? `/p/${t.project_id}` : "/",
    tag: `agy-signin-${t.id}`,
  }).catch(() => {});
}

/**
 * The agent session a queued task still has open, if any (runTask refuses to start a second).
 * `fresh` when it was started after the task was last touched: ansai restarted between
 * starting the agent and moving its task to Doing, so that agent IS this run. Otherwise it
 * is an agent from an earlier run, left open when you sent the task back to the queue.
 */
function openRun(t: Task): { fresh: boolean } | null {
  const s = db
    .query(
      `SELECT s.created_at FROM sessions s WHERE s.task_id = ? AND s.status = 'running'
         AND NOT EXISTS (SELECT 1 FROM task_reviews r WHERE r.session_id = s.id AND r.status = 'complete')
       ORDER BY s.created_at DESC LIMIT 1`,
    )
    .get(t.id) as { created_at: number } | null;
  return s ? { fresh: s.created_at >= t.updated_at } : null;
}

/** Queued tasks waiting for you to close the agent an earlier run left open; you hear about each once. */
const heldForOpenAgent = new Set<string>();
function holdForOpenAgent(t: Task) {
  if (heldForOpenAgent.has(t.id)) return;
  heldForOpenAgent.add(t.id);
  console.warn(`[ansai] autopilot is holding "${t.title}": an agent from an earlier run is still open`);
  notify("input", {
    title: `Autopilot is waiting · ${t.title}`,
    body: "This task still has an agent open from an earlier run, so a new one can't start. Close that agent and the task starts by itself, or message the agent to carry on.",
    url: t.project_id ? `/p/${t.project_id}` : "/",
    tag: `open-agent-${t.id}`,
  }).catch(() => {});
}

export async function autopilotTick() {
  if (ticking) return;
  ticking = true;
  try {
    const { autopilotMax } = getSettings();
    // Count active autopilot sessions, including agents that stopped to ask you
    // something (in review, but they haven't called finish_task yet). Not agy: it has
    // no finish_task to call, so a turn that ended is all it will ever say.
    const active = db
      .query(
        `SELECT s.project_id, s.auto, t.worktree_path FROM sessions s JOIN tasks t ON t.id = s.task_id
         WHERE s.status = 'running' AND s.tool != 'shell'
           AND (t.status = 'doing' OR (t.status = 'review' AND t.summary IS NULL AND s.auto = 1 AND s.tool != 'agy'))`,
      )
      .all() as { project_id: string | null; auto: number; worktree_path: string | null }[];
    let running = active.filter((a) => a.auto).length;
    // Non-Git projects keep using the shared project directory, so serialize
    // those tasks as before. In a Git project a queued task gets its own worktree,
    // so a session in the project folder (e.g. one you're chatting with) doesn't hold it up.
    const busySharedProjects = new Set<string | null>();
    for (const pid of new Set(active.filter((a) => !a.worktree_path).map((a) => a.project_id))) {
      const p = pid ? getProject(pid) : null;
      if (!p || !(await usesWorktrees(p.path))) busySharedProjects.add(pid);
    }
    if (running >= autopilotMax) return;

    const queued = db
      .query(`SELECT t.*, so.tool AS schedule_tool, so.account_id AS schedule_account, so.model AS schedule_model, so.effort AS schedule_effort
        FROM tasks t LEFT JOIN schedule_occurrences so ON so.task_id = t.id
        WHERE t.queued = 1 AND t.status = 'todo' AND t.project_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks prerequisite ON prerequisite.id = d.depends_on_task_id
            WHERE d.task_id = t.id AND prerequisite.status != 'done')
        ORDER BY t.priority DESC, t.created_at ASC`)
      .all() as Task[];
    for (const t of queued) {
      if (running >= autopilotMax) break;
      if (busySharedProjects.has(t.project_id)) continue;
      const ap = projectAutopilot(t.project_id) ?? { on: false, tool: "claude", accountId: null, yolo: false };
      const scheduled = t as Task & { schedule_tool?: string | null; schedule_account?: string | null; schedule_model?: string | null; schedule_effort?: string | null };
      if (scheduled.schedule_tool && !ap.on) {
        db.query("UPDATE tasks SET queued=0 WHERE id=?").run(t.id);
        updateOccurrence(t.id, "needs_attention", "Project autopilot was turned off before this scheduled task could start.");
        emit("tasks");
        continue;
      }
      const tool = (scheduled.schedule_tool as Autopilot["tool"] | null) ?? ap.tool;
      const accountId = scheduled.schedule_tool ? scheduled.schedule_account : ap.accountId;
      // Signed out, agy would sit on its sign-in menu: the task stays queued until you sign in.
      if (tool === "agy" && (await checkAgySignIn(accountId ?? null)) === false) {
        holdForSignIn(t);
        continue;
      }
      heldForSignIn.delete(t.id);
      // Marking the task Doing here used to happen for ANY open agent: a Review task sent back
      // to the queue while its old agent was still open went to Doing with nobody working on it,
      // and held an autopilot slot for good.
      const open = openRun(t);
      if (open && !open.fresh) {
        holdForOpenAgent(t);
        continue;
      }
      heldForOpenAgent.delete(t.id);
      try {
        await runTask(t.id, {
          tool,
          yolo: ap.yolo,
          accountId,
          model: scheduled.schedule_tool ? scheduled.schedule_model : ap.model,
          effort: scheduled.schedule_tool ? scheduled.schedule_effort : ap.effort,
          auto: true,
        });
        updateOccurrence(t.id, "running", null);
        running++;
        if (!getTask(t.id)?.worktree_path) busySharedProjects.add(t.project_id);
      } catch (e) {
        if (openRun(t)?.fresh) {
          // Recover the narrow restart window after createSession committed but before runTask moved the task to Doing.
          db.query("UPDATE tasks SET status='doing',queued=0 WHERE id=?").run(t.id);
          updateOccurrence(t.id, "running", null);
          running++;
          if (!getTask(t.id)?.worktree_path) busySharedProjects.add(t.project_id);
          emit("tasks");
          continue;
        }
        console.error(`[ansai] autopilot couldn't start "${t.title}":`, e instanceof Error ? e.message : e);
        db.query("UPDATE tasks SET queued = 0 WHERE id = ?").run(t.id); // don't retry forever
        updateOccurrence(t.id, "needs_attention", e instanceof Error ? e.message : String(e));
        emit("tasks");
      }
    }
  } finally {
    ticking = false;
  }
}

export function startAutopilot(ms = 4000) {
  const tick = () => {
    try { scheduleTick(); } catch (e) { console.error("[ansai] schedules:", e); }
    autopilotTick().catch((e) => console.error("[ansai] autopilot:", e)).finally(() => setTimeout(tick, ms));
  };
  setTimeout(tick, 3000);
}
