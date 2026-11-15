import { db, getSetting, setSetting } from "./db";
import { emit } from "./events";
import { AGENT_TOOLS } from "./accounts";
import { projectAutopilot, runTask, type Autopilot, type Task } from "./tasks";

/**
 * Autopilot: queued backlog tasks start on their own. One agent per project
 * at a time (two agents editing the same checkout trip over each other), and
 * at most `autopilotMax` autopilot agents overall. A project frees up as soon
 * as its task leaves "doing" (the agent finished its turn or asked you
 * something and stopped).
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
  const cur = projectAutopilot(projectId) ?? { on: false, tool: "claude", accountId: null, yolo: false };
  const next: Autopilot = {
    on: raw.on !== undefined ? !!raw.on : cur.on,
    tool: raw.tool && (AGENT_TOOLS as string[]).includes(raw.tool) ? raw.tool : cur.tool,
    accountId: raw.accountId !== undefined ? (raw.accountId ? String(raw.accountId) : null) : cur.accountId,
    yolo: raw.yolo !== undefined ? !!raw.yolo : cur.yolo,
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
    // A project is busy while an agent works a task there — including an autopilot agent that
    // stopped to ask you something (in review, but it hasn't called finish_task yet).
    const active = db
      .query(
        `SELECT s.project_id, s.auto FROM sessions s JOIN tasks t ON t.id = s.task_id
         WHERE s.status = 'running' AND s.tool != 'shell'
           AND (t.status = 'doing' OR (t.status = 'review' AND t.summary IS NULL AND s.auto = 1))`,
      )
      .all() as { project_id: string; auto: number }[];
    const busy = new Set(active.map((a) => a.project_id));
    let running = active.filter((a) => a.auto).length;
    if (running >= autopilotMax) return;

    const queued = db
      .query(`SELECT * FROM tasks WHERE queued = 1 AND status = 'todo' AND project_id IS NOT NULL ORDER BY priority DESC, created_at ASC`)
      .all() as Task[];
    for (const t of queued) {
      if (running >= autopilotMax) break;
      if (busy.has(t.project_id!)) continue;
      const ap = projectAutopilot(t.project_id) ?? { on: false, tool: "claude", accountId: null, yolo: false };
      try {
        await runTask(t.id, { tool: ap.tool, yolo: ap.yolo, accountId: ap.accountId, auto: true });
        running++;
        busy.add(t.project_id!);
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
