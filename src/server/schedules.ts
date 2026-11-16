import { db, newId, now } from "./db";
import { badRequest, notFound } from "./errors";
import { emit } from "./events";
import { getProject } from "./projects";
import { projectAutopilot, createTask } from "./tasks";
import type { ToolId } from "./tools";

export type Cadence = "daily" | "weekdays" | "weekly";
export type ScheduleInput = {
  title: string; prompt: string; tool: ToolId; accountId?: string | null;
  model?: string | null; effort?: string | null; cadence: Cadence; localTime: string; timezone: string;
  /** Weekly only: "Mon".."Sun". Unset keeps the day a schedule already runs on (or today, for a new one). */
  weekday?: string;
};
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
type ScheduleRow = {
  id: string; project_id: string; prompt: string; title: string; tool: ToolId; account_id: string | null;
  model: string | null; effort: string | null; cadence: Cadence; local_time: string; timezone: string;
  next_at: number; enabled: number; created_at: number; updated_at: number;
};

function validate(o: ScheduleInput) {
  if (!o.title.trim() || o.title.length > 300) throw badRequest("give the schedule a title (up to 300 characters)");
  if (!o.prompt.trim() || o.prompt.length > 30_000) throw badRequest("give the schedule a prompt (up to 30,000 characters)");
  if (!("daily weekdays weekly".split(" ").includes(o.cadence))) throw badRequest("bad cadence");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(o.localTime)) throw badRequest("time must be HH:MM");
  try { new Intl.DateTimeFormat("en", { timeZone: o.timezone }).format(); } catch { throw badRequest("bad timezone"); }
  if (!["claude", "codex", "agy"].includes(o.tool)) throw badRequest("pick an agent, not a shell");
}

// Building an Intl.DateTimeFormat is the slow part (nextAt scans minute by minute: a weekly
// schedule took 1.2 s of blocked event loop), so keep one per zone.
const partsFmt = new Map<string, Intl.DateTimeFormat>();
const dateFmt = new Map<string, Intl.DateTimeFormat>();
function fmt(cache: Map<string, Intl.DateTimeFormat>, zone: string, make: () => Intl.DateTimeFormat) {
  let f = cache.get(zone);
  if (!f) cache.set(zone, (f = make()));
  return f;
}
function localParts(at: number, zone: string) {
  const parts = fmt(partsFmt, zone, () => new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })).formatToParts(at);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}
function localDate(at: number, zone: string) {
  const p = fmt(dateFmt, zone, () => new Intl.DateTimeFormat("en", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })).formatToParts(at);
  const values = Object.fromEntries(p.map((x) => [x.type, x.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
/**
 * The next time a schedule runs. Walks the clock a minute at a time, in the schedule's zone,
 * and takes the first minute of a matching day at or past the wanted time. On the day clocks
 * go forward that time may not exist (02:30 when 02:00 jumps to 03:00): the run then happens
 * at the first minute after the jump, instead of being skipped. A weekly schedule on such a day
 * used to find no time at all within the scan and threw, on every tick, for ever.
 * Exported for tests.
 */
export function nextAt(after: number, time: string, zone: string, cadence: Cadence, weeklyDay = localParts(after, zone).weekday, skipDate?: string) {
  const start = Math.floor(after / 60_000) * 60_000 + 60_000;
  let prev = localParts(start - 60_000, zone);
  for (let t = start; t <= start + 9 * 86400_000; t += 60_000) {
    const p = localParts(t, zone);
    // Reached now, and not already a minute ago: the same day was still before the time, or it was yesterday.
    const reached = `${p.hour}:${p.minute}` >= time && (prev.weekday !== p.weekday || `${prev.hour}:${prev.minute}` < time);
    prev = p;
    if (!reached) continue;
    const dayOk = cadence === "daily" || (cadence === "weekdays" ? p.weekday !== "Sat" && p.weekday !== "Sun" : p.weekday === weeklyDay);
    if (dayOk && localDate(t, zone) !== skipDate) return t;
  }
  throw badRequest("could not find the next schedule time");
}

export function listSchedules(projectId: string) {
  if (!getProject(projectId)) throw notFound("no such project");
  const schedules = db.query("SELECT * FROM schedules WHERE project_id = ? ORDER BY created_at").all(projectId) as ScheduleRow[];
  return schedules.map((s) => ({ ...s, occurrences: db.query(
    `SELECT o.*, t.status AS task_status, t.summary, t.last_failure, (SELECT id FROM sessions WHERE task_id=t.id ORDER BY created_at DESC LIMIT 1) AS session_id
     FROM schedule_occurrences o JOIN tasks t ON t.id=o.task_id WHERE o.schedule_id=? OR (o.schedule_id IS NULL AND ? IS NULL) ORDER BY o.created_at DESC LIMIT 10`,
  ).all(s.id, s.id) }));
}

export function saveSchedule(projectId: string, id: string | null, o: ScheduleInput) {
  validate(o);
  if (!getProject(projectId)) throw notFound("no such project");
  if (o.accountId && !db.query("SELECT 1 FROM accounts WHERE id=?").get(o.accountId)) throw badRequest("no such account");
  if (o.weekday && !(WEEKDAYS as readonly string[]).includes(o.weekday)) throw badRequest("weekday must be Mon to Sun");
  const t = now();
  const old = id ? (db.query("SELECT id, next_at, timezone FROM schedules WHERE id=? AND project_id=?").get(id, projectId) as { id: string; next_at: number; timezone: string } | null) : null;
  if (id && !old) throw notFound("no such schedule");
  // A weekly schedule keeps its day when edited (the day isn't stored; it's the day of the next run).
  const day = o.weekday ?? (old ? localParts(old.next_at, old.timezone).weekday : undefined);
  const next = nextAt(t, o.localTime, o.timezone, o.cadence, day);
  if (id) {
    db.query(`UPDATE schedules SET title=?,prompt=?,tool=?,account_id=?,model=?,effort=?,cadence=?,local_time=?,timezone=?,next_at=?,updated_at=? WHERE id=?`)
      .run(o.title.trim(), o.prompt, o.tool, o.accountId ?? null, o.model ?? null, o.effort ?? null, o.cadence, o.localTime, o.timezone, next, t, id);
  } else {
    id = newId("r");
    db.query(`INSERT INTO schedules (id,project_id,title,prompt,tool,account_id,model,effort,cadence,local_time,timezone,next_at,enabled,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(id, projectId, o.title.trim(), o.prompt, o.tool, o.accountId ?? null, o.model ?? null, o.effort ?? null, o.cadence, o.localTime, o.timezone, next, t, t);
  }
  emit("tasks");
  return db.query("SELECT * FROM schedules WHERE id=?").get(id);
}

export function setScheduleEnabled(projectId: string, id: string, enabled: boolean) {
  const s = db.query("SELECT * FROM schedules WHERE id=? AND project_id=?").get(id, projectId) as ScheduleRow | null;
  if (!s) throw notFound("no such schedule");
  db.query("UPDATE schedules SET enabled=?, next_at=?, updated_at=? WHERE id=?").run(enabled ? 1 : 0, enabled ? nextAt(now(), s.local_time, s.timezone, s.cadence, localParts(s.next_at, s.timezone).weekday) : s.next_at, now(), id);
  return { ok: true };
}
export function deleteSchedule(projectId: string, id: string) {
  if (!db.query("DELETE FROM schedules WHERE id=? AND project_id=?").run(id, projectId).changes) throw notFound("no such schedule");
}

function occurrence(schedule: ScheduleRow, forAt: number) {
  const ap = projectAutopilot(schedule.project_id);
  const canQueue = !!ap?.on;
  const task = createTask({ title: schedule.title, body: schedule.prompt, projectId: schedule.project_id, queued: canQueue, source: "you" });
  const status = canQueue ? "queued" : "needs_attention";
  const outcome = canQueue ? null : "Project autopilot is off. Turn it on or start this task manually.";
  db.query("INSERT INTO schedule_occurrences (id,schedule_id,scheduled_for,task_id,tool,account_id,model,effort,status,outcome,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(newId("o"), schedule.id, forAt, task.id, schedule.tool, schedule.account_id, schedule.model, schedule.effort, status, outcome, now());
  emit("tasks");
  return task;
}

/** Schedules whose failure is already in the log (one line each, not one per tick). */
const failing = new Set<string>();

/**
 * Materialize only the latest missed slot per schedule. Unique occurrence keys make restart/delayed ticks safe.
 * One schedule that can't run (its next time can't be worked out, its project is gone) is
 * logged and left for the next tick; the others still run.
 */
export function scheduleTick(at = now()) {
  const due = db.query("SELECT * FROM schedules WHERE enabled=1 AND next_at<=? ORDER BY next_at").all(at) as ScheduleRow[];
  for (const s of due) {
    const transaction = db.transaction(() => {
      const fresh = db.query("SELECT * FROM schedules WHERE id=? AND enabled=1 AND next_at<=?").get(s.id, at) as ScheduleRow | null;
      if (!fresh) return;
      const scheduledFor = fresh.next_at;
      const task = occurrence(fresh, scheduledFor);
      // If a tick was delayed, skip missed slots and resume at the next future local occurrence.
      const next = nextAt(Math.max(at, scheduledFor), fresh.local_time, fresh.timezone, fresh.cadence, localParts(scheduledFor, fresh.timezone).weekday, localDate(scheduledFor, fresh.timezone));
      db.query("UPDATE schedules SET next_at=?,updated_at=? WHERE id=?").run(next, at, fresh.id);
      return task;
    });
    try {
      transaction();
      failing.delete(s.id);
    } catch (e) {
      if (!failing.has(s.id)) console.error(`[ansai] schedule "${s.title}" (${s.id}) couldn't run:`, e instanceof Error ? e.message : e);
      failing.add(s.id);
    }
  }
  return due.length;
}

export function runScheduleNow(projectId: string, id: string) {
  const s = db.query("SELECT * FROM schedules WHERE id=? AND project_id=?").get(id, projectId) as ScheduleRow | null;
  if (!s) throw notFound("no such schedule");
  const task = db.transaction(() => {
    const last = Number((db.query("SELECT MAX(scheduled_for) AS n FROM schedule_occurrences WHERE schedule_id=?").get(id) as { n: number | null }).n ?? 0);
    // Filed under when it actually ran (not the next slot), so a manual run and the 09:00 run don't look alike.
    return occurrence(s, Math.max(now(), last + 1));
  })();
  return task;
}

export function updateOccurrence(taskId: string, status: string, outcome: string | null) {
  db.query("UPDATE schedule_occurrences SET status=?,outcome=? WHERE task_id=?").run(status, outcome, taskId);
}

