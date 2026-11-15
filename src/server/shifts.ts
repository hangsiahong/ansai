import { db, now } from "./db";
import { badRequest, conflict, notFound } from "./errors";
import { emit } from "./events";
import { notify } from "./push";
import { getSession, sendText, sessionView, type SessionRow } from "./sessions";
import { wakes } from "./team";

/**
 * Shifts: keep an agent working until a set time while you're away.
 *
 * When an agent on shift finishes a turn, ansai hands it a "keep going" prompt
 * instead of letting it wait for you. Claude gets it through its Stop hook (it
 * continues in the same turn), Codex gets it typed in once its turn has ended.
 * A shift ends when time is up, when the agent calls end_shift because nothing
 * useful is left, when it's nudged twice in a row without doing any work, or
 * when you end it. It leaves a short report: how long, how many nudges, and the
 * commits made in the project meanwhile.
 */

export type ShiftReport = { commits: { sha: string; subject: string }[]; moreCommits: number };

export type ShiftRow = {
  session_id: string;
  until: number;
  focus: string | null;
  started_at: number;
  nudges: number;
  /** Nudges in a row that produced no work (Claude: no tool call; Codex: a turn under a minute). */
  idle: number;
  /** Claude only: a tool ran since the last nudge. */
  worked: number;
  last_nudge_at: number | null;
  ended_at: number | null;
  end_reason: EndReason | null;
  summary: string | null;
  report: string | null;
};

export type EndReason = "time" | "agent" | "idle" | "you" | "exited" | "cap";

export type ShiftView = Omit<ShiftRow, "report" | "worked"> & { active: boolean; report: ShiftReport | null };

/** Agents ansai can tell when a turn ends (agy has no hooks yet). */
const SUPPORTED = new Set(["claude", "codex"]);
/** Upper bound on nudges per hour, so a confused agent can't spin through tokens. */
const MAX_NUDGES_PER_HOUR = 30;
/** A Codex turn shorter than this after a nudge counts as "nothing done". */
const CODEX_IDLE_TURN = 60_000;
/** Two nudges in a row with no work means the agent has run out of things to do. */
const IDLE_LIMIT = 2;
const MAX_SHIFT = 24 * 3600_000;

export const END_LABEL: Record<EndReason, string> = {
  time: "time was up",
  agent: "the agent said it was done",
  idle: "the agent ran out of work",
  you: "you ended it",
  exited: "the agent stopped running",
  cap: "it hit the hourly nudge limit",
};

function row(sessionId: string): ShiftRow | null {
  return db.query("SELECT * FROM shifts WHERE session_id = ?").get(sessionId) as ShiftRow | null;
}

function active(sessionId: string): ShiftRow | null {
  return db.query("SELECT * FROM shifts WHERE session_id = ? AND ended_at IS NULL").get(sessionId) as ShiftRow | null;
}

export function shiftView(sessionId: string): ShiftView | null {
  const r = row(sessionId);
  if (!r) return null;
  const { report, worked: _w, ...rest } = r;
  let parsed: ShiftReport | null = null;
  try {
    parsed = report ? (JSON.parse(report) as ShiftReport) : null;
  } catch {}
  return { ...rest, active: r.ended_at === null, report: parsed };
}

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const minutesLeft = (until: number) => Math.max(1, Math.round((until - now()) / 60_000));

/** The prompt an agent on shift gets instead of waiting for you. */
function nudgeText(s: SessionRow, sh: ShiftRow): string {
  const focus = sh.focus?.trim() || s.title;
  return [
    `ansai shift: you're on shift until ${clock(sh.until)} (${minutesLeft(sh.until)} min left) and the user is away, so keep going without waiting for them.`,
    `Focus: ${focus}`,
    "Pick the next most valuable thing and do it: finish anything half-done, check that what you changed really works (run it, test it), fix what you find, then improve further. " +
      "list_tasks shows the backlog; list_agents and send_message keep you from clashing with teammates. Commit finished work in small commits.",
    "If something needs a decision only the user can make, record it with add_task and move on to something else.",
    "When nothing useful is left, call the ansai end_shift tool with a short summary of what you did this shift.",
  ].join("\n");
}

// ------------------------------------------------------------------ control

export function startShift(sessionId: string, o: { until: number; focus?: string | null }): ShiftView {
  const s = getSession(sessionId);
  if (!s) throw notFound("no such session");
  if (s.status !== "running") throw conflict("this session isn't running");
  if (!SUPPORTED.has(s.tool)) throw badRequest(s.tool === "shell" ? "a shell has no agent to keep working" : "shifts work with Claude Code and Codex for now");
  const t = now();
  if (!Number.isFinite(o.until) || o.until <= t + 60_000) throw badRequest("pick a time at least a minute from now");
  if (o.until > t + MAX_SHIFT) throw badRequest("a shift can last 24 hours at most");
  const cur = active(sessionId);
  // Extending without a focus (the project sheet does that for every agent) keeps each one's own focus.
  const focus = o.focus === undefined && cur ? cur.focus : o.focus?.trim() || null;
  if (cur) {
    // Extending or refocusing keeps the counters (and the report's start).
    db.query("UPDATE shifts SET until = ?, focus = ? WHERE session_id = ?").run(o.until, focus, sessionId);
  } else {
    db.query(
      `INSERT INTO shifts (session_id, until, focus, started_at, nudges, idle, worked, last_nudge_at, ended_at, end_reason, summary, report)
       VALUES (?, ?, ?, ?, 0, 0, 0, NULL, NULL, NULL, NULL, NULL)
       ON CONFLICT(session_id) DO UPDATE SET until = excluded.until, focus = excluded.focus, started_at = excluded.started_at,
         nudges = 0, idle = 0, worked = 0, last_nudge_at = NULL, ended_at = NULL, end_reason = NULL, summary = NULL, report = NULL`,
    ).run(sessionId, o.until, focus, t);
  }
  emit("sessions");
  // An agent that is already waiting for you gets going right away (the loop types the nudge).
  setTimeout(() => nudgeIdle().catch(() => {}), 50);
  return shiftView(sessionId)!;
}

/** Start (or extend) a shift for every running Claude/Codex agent in a project. */
export function startProjectShift(projectId: string, o: { until: number; focus?: string | null }): { started: number } {
  const rows = db
    .query(`SELECT id FROM sessions WHERE project_id = ? AND status = 'running' AND tool IN ('claude', 'codex')`)
    .all(projectId) as { id: string }[];
  if (!rows.length) throw conflict("no Claude or Codex agents are running in this project");
  for (const r of rows) startShift(r.id, o);
  return { started: rows.length };
}

export function endProjectShift(projectId: string): { ended: number } {
  const rows = db
    .query(`SELECT sh.session_id AS id FROM shifts sh JOIN sessions s ON s.id = sh.session_id WHERE s.project_id = ? AND sh.ended_at IS NULL`)
    .all(projectId) as { id: string }[];
  for (const r of rows) endShift(r.id, "you");
  return { ended: rows.length };
}

export function endShift(sessionId: string, reason: EndReason, summary?: string | null) {
  const sh = active(sessionId);
  if (!sh) return;
  const s = getSession(sessionId);
  const t = now();
  db.query("UPDATE shifts SET ended_at = ?, end_reason = ?, summary = COALESCE(?, summary) WHERE session_id = ? AND ended_at IS NULL").run(
    t,
    reason,
    summary?.trim() || null,
    sessionId,
  );
  emit("sessions");
  if (!s) return;
  // The report (commits made meanwhile) is filled in shortly after; git can take a moment.
  buildReport(s, sh.started_at, t)
    .then((report) => {
      db.query("UPDATE shifts SET report = ? WHERE session_id = ?").run(JSON.stringify(report), sessionId);
      emit("sessions");
      if (reason === "you") return; // you know already
      const hours = (t - sh.started_at) / 3600_000;
      const span = hours >= 1 ? `${hours.toFixed(1)} h` : `${Math.max(1, Math.round(hours * 60))} min`;
      const n = report.commits.length + report.moreCommits;
      const body = `${span}, ${sh.nudges} nudge${sh.nudges === 1 ? "" : "s"}${n ? `, ${n} commit${n === 1 ? "" : "s"}` : ""}. Ended because ${END_LABEL[reason]}.`;
      notify("done", { title: `Shift over · ${s.title}`, body, url: `/s/${s.id}`, tag: `shift-${s.id}` }).catch(() => {});
    })
    .catch((e) => console.error("[ansai] shift report:", e));
}

async function buildReport(s: SessionRow, from: number, to: number): Promise<ShiftReport> {
  const LIMIT = 12;
  try {
    const p = Bun.spawn(
      ["git", "-C", s.cwd, "log", `--since=@${Math.floor(from / 1000)}`, `--until=@${Math.ceil(to / 1000)}`, "--format=%h%x09%s", "-n", "200"],
      { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
    );
    const timer = setTimeout(() => p.kill(), 5000);
    const out = await new Response(p.stdout).text();
    clearTimeout(timer);
    const lines = out.split("\n").filter(Boolean);
    const commits = lines.slice(0, LIMIT).map((l) => {
      const [sha, ...rest] = l.split("\t");
      return { sha: sha!, subject: rest.join("\t") };
    });
    return { commits, moreCommits: Math.max(0, lines.length - LIMIT) };
  } catch {
    return { commits: [], moreCommits: 0 };
  }
}

// ------------------------------------------------------------------ signals

/**
 * Esc while an agent on shift is mid-turn (the chat's Stop button, the key bar's esc)
 * means "stop", so the shift ends too. Otherwise the next turn's end would hand the
 * agent another prompt, and Stop could never stop it. Esc on an idle agent changes nothing.
 */
export function stopPressed(sessionId: string, keys: string[]) {
  if (keys.length !== 1 || keys[0] !== "Escape") return;
  const sh = active(sessionId);
  const s = sh && getSession(sessionId);
  if (!sh || !s) return;
  // Codex has no "working" hook: a nudge typed after its last turn ended means it's on that turn now.
  const midTurn = s.agent_state === "working" || (!!sh.last_nudge_at && sh.last_nudge_at > (s.agent_state_at ?? 0));
  if (midTurn) endShift(sessionId, "you");
}

/** Claude ran a tool: the shift is producing work. */
export function shiftWorked(sessionId: string) {
  db.query("UPDATE shifts SET worked = 1, idle = 0 WHERE session_id = ? AND ended_at IS NULL AND worked = 0").run(sessionId);
}

/** Decide whether this agent should keep going, and record the nudge. Returns the prompt, or null to let it stop. */
function nextNudge(s: SessionRow, didWork: boolean): string | null {
  const sh = active(s.id);
  if (!sh) return null;
  const t = now();
  if (t >= sh.until) {
    endShift(s.id, "time");
    return null;
  }
  const idle = sh.nudges > 0 && !didWork ? sh.idle + 1 : 0;
  if (idle >= IDLE_LIMIT) {
    endShift(s.id, "idle");
    return null;
  }
  // On average no more than MAX_NUDGES_PER_HOUR (a burst early in the shift is fine).
  const allowed = MAX_NUDGES_PER_HOUR * Math.max(1, Math.ceil((t - sh.started_at) / 3600_000));
  if (sh.nudges >= allowed) {
    endShift(s.id, "cap");
    return null;
  }
  db.query("UPDATE shifts SET nudges = nudges + 1, idle = ?, worked = 0, last_nudge_at = ? WHERE session_id = ?").run(idle, t, s.id);
  emit("sessions");
  return nudgeText(s, { ...sh, idle });
}

/**
 * Claude's Stop hook: on shift, block the stop and hand Claude its next prompt
 * (it continues in the same turn, so the task stays in Doing and no "finished"
 * push goes out). Returns null when Claude should stop as usual.
 */
export function claudeStop(s: SessionRow): { decision: "block"; reason: string } | null {
  const sh = active(s.id);
  if (!sh) return null;
  const reason = nextNudge(s, sh.worked === 1);
  return reason ? { decision: "block", reason } : null;
}

/** A Codex turn ended. True if the shift will type the next prompt (so don't announce "finished"). */
export function codexTurnEnded(s: SessionRow): boolean {
  const sh = active(s.id);
  if (!sh) return false;
  const t = now();
  if (t >= sh.until) {
    endShift(s.id, "time");
    return false;
  }
  return true; // nudgeIdle() types it once the screen settles
}

const nudging = new Set<string>();

/**
 * Agents on shift that are sitting at their prompt get the next prompt typed in.
 * Covers Codex after every turn, and any agent that was already idle when its
 * shift started. Runs every few seconds.
 */
export async function nudgeIdle() {
  const t = now();
  // Shifts whose time ran out while the agent was busy (or idle) end on the clock, not only at a turn's end.
  const expired = db.query("SELECT session_id FROM shifts WHERE ended_at IS NULL AND until <= ?").all(t) as { session_id: string }[];
  for (const e of expired) endShift(e.session_id, "time");
  const gone = db
    .query(`SELECT sh.session_id FROM shifts sh LEFT JOIN sessions s ON s.id = sh.session_id WHERE sh.ended_at IS NULL AND (s.id IS NULL OR s.status != 'running')`)
    .all() as { session_id: string }[];
  for (const g of gone) endShift(g.session_id, "exited");

  // A Codex that hasn't finished a turn yet has no state (it has no start hook), so an
  // idle one is recognized by its screen being still and free of startup questions.
  const rows = db
    .query(
      `SELECT s.* FROM sessions s JOIN shifts sh ON sh.session_id = s.id
       WHERE sh.ended_at IS NULL AND s.status = 'running' AND s.tool IN ('claude', 'codex')
         AND (s.agent_state = 'waiting' OR (s.tool = 'codex' AND s.agent_state IS NULL))`,
    )
    .all() as SessionRow[];
  for (const s of rows) {
    if (nudging.has(s.id) || wakes(s)) continue; // a waiting team message goes first; it starts a turn of its own
    const view = sessionView(s);
    const quietFor = t - (view.activity_at ?? 0);
    if (quietFor < 4000) continue; // let the screen settle after the turn
    if (s.agent_state === null && (view.startup || quietFor < 10_000)) continue; // a fresh Codex: only once it's clearly sitting at its prompt
    const sh = active(s.id);
    if (!sh) continue;
    if (sh.last_nudge_at && t - sh.last_nudge_at < 15_000) continue; // already typed one; wait for it to land
    // Codex has no tool hooks: a turn that took a minute or more after the last nudge counts as work.
    const turnLength = sh.last_nudge_at ? (s.agent_state_at ?? t) - sh.last_nudge_at : Infinity;
    const didWork = s.tool === "claude" ? sh.worked === 1 : turnLength >= CODEX_IDLE_TURN;
    nudging.add(s.id);
    try {
      const text = nextNudge(s, didWork);
      if (text) await sendText(s.id, text, true);
    } catch (e) {
      console.error("[ansai] shift nudge:", e);
    } finally {
      nudging.delete(s.id);
    }
  }
}
