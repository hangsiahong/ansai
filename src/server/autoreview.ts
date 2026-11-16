import { db, now } from "./db";
import { emit } from "./events";
import { resolveAccount } from "./accounts";
import { heldUntil } from "./holds";
import { closeSession, getSession, type SessionRow } from "./sessions";
import { getTask, projectAutopilot, startTaskReview, type ReviewFinding, type ReviewStart } from "./tasks";
import { postMessage } from "./team";
import { TOOLS } from "./tools";

/**
 * Automatic independent review of what autopilot agents finish.
 *
 * finish_task queues round 1 (tasks.auto_review). reviewTick starts it with the other agent
 * (Claude reviews Codex's work and the other way round), in the task's worktree, read-only.
 * At finish_review, high-severity findings go back to the implementer once as a message;
 * when it calls finish_task again, round 2 checks the fixes. The task stays in Review
 * throughout: you still decide what merges.
 */

type ReviewerTool = "claude" | "codex";
export const REVIEWS_AT_ONCE = 2;
/** A reviewer still running after this long is closed; the findings it reported stay. */
export const REVIEW_MAX_MS = 30 * 60_000;
/** Idle (turn ended) without finish_review this long: told once to finish. */
export const NUDGE_AFTER_MS = 3 * 60_000;
/** Idle this long without finish_review: closed. */
export const GIVE_UP_AFTER_MS = 10 * 60_000;
export const SYSTEM_LABEL = "ansai";
export const SEND_BACK_LABEL = "Auto-review";

type Deps = {
  start: (taskId: string, tool: ReviewerTool, o: ReviewStart) => Promise<unknown>;
  installed: (tool: ReviewerTool) => boolean;
  close: (sessionId: string) => Promise<void>;
};
const real: Deps = {
  start: (id, tool, o) => startTaskReview(id, tool, o),
  installed: (tool) => !!Bun.which(TOOLS[tool].bin),
  close: closeSession,
};
let deps = real;
/** Tests swap in fakes that don't launch agents. */
export function setReviewDeps(d: Partial<Deps> | null) {
  deps = d ? { ...real, ...d } : real;
}

type ReviewRow = { task_id: string; session_id: string | null; reviewer_tool: ReviewerTool; status: string; summary: string | null; findings: string; round: number; sent_back: number; updated_at: number };
const reviewOf = (taskId: string) => db.query("SELECT * FROM task_reviews WHERE task_id = ?").get(taskId) as ReviewRow | null;

/** The agent doing the task: its newest session that isn't a reviewer. */
function implementer(taskId: string): SessionRow | null {
  const r = db
    .query(
      `SELECT s.id FROM sessions s WHERE s.task_id = ? AND s.title NOT LIKE 'Review · %'
         AND NOT EXISTS (SELECT 1 FROM task_reviews r WHERE r.session_id = s.id)
       ORDER BY s.created_at DESC LIMIT 1`,
    )
    .get(taskId) as { id: string } | null;
  return r ? getSession(r.id) : null;
}

/**
 * Called after an agent's finish_task went through. Returns the round queued: 1 for a run's
 * first finish, 2 when it finished again after round 1's findings went back to it, 0 for none.
 */
export function queueAutoReview(taskId: string, sessionId: string): 0 | 1 | 2 {
  const t = getTask(taskId);
  const s = getSession(sessionId);
  if (!t || !s || !s.auto || t.status !== "review" || !t.summary || !t.worktree_path || !t.project_id) return 0;
  if (projectAutopilot(t.project_id)?.review === false) return 0;
  const prev = reviewOf(taskId);
  // A review row from before this agent started belongs to an earlier run.
  const round = !prev || prev.updated_at < s.created_at ? 1 : prev.round === 1 && prev.sent_back && prev.status === "complete" ? 2 : 0;
  if (!round) return 0;
  db.query("UPDATE tasks SET auto_review = ? WHERE id = ?").run(round, taskId);
  emit("tasks");
  return round;
}

function usableAccount(tool: ReviewerTool, accountId: string | null): { ok: boolean; accountId: string | null } {
  if (!deps.installed(tool)) return { ok: false, accountId: null };
  try {
    const a = resolveAccount(tool, accountId);
    return { ok: !(a && heldUntil(a.id)), accountId: a?.id ?? null };
  } catch {
    return { ok: false, accountId: null }; // an account that was deleted: try the other agent
  }
}

/** The other agent reviews; the implementer's own agent only when the other can't run now. */
export function pickReviewer(impl: Pick<SessionRow, "tool" | "account_id"> | null): { tool: ReviewerTool; accountId: string | null } | null {
  const own = impl?.tool === "claude" || impl?.tool === "codex" ? impl.tool : null;
  const other: ReviewerTool = own === "claude" ? "codex" : "claude";
  const first = usableAccount(other, null);
  if (first.ok) return { tool: other, accountId: first.accountId };
  if (!own) return null;
  const second = usableAccount(own, impl?.account_id ?? null);
  return second.ok ? { tool: own, accountId: second.accountId } : null;
}

/** Close auto-reviewers that ran too long or stopped without finish_review; nudge once first. */
async function sweepStuck(at: number) {
  const rows = db
    .query(
      `SELECT r.task_id, r.session_id, s.created_at, s.agent_state, s.agent_state_at FROM task_reviews r JOIN sessions s ON s.id = r.session_id
       WHERE r.status = 'running' AND r.round > 0 AND s.status = 'running'`,
    )
    .all() as { task_id: string; session_id: string; created_at: number; agent_state: string | null; agent_state_at: number | null }[];
  for (const r of rows) {
    const idle = r.agent_state === "waiting" && r.agent_state_at ? at - r.agent_state_at : 0;
    const why = at - r.created_at > REVIEW_MAX_MS ? `ran for ${REVIEW_MAX_MS / 60_000} minutes` : idle > GIVE_UP_AFTER_MS ? "stopped without calling finish_review" : null;
    if (why) {
      db.query("UPDATE task_reviews SET status = 'stopped', summary = COALESCE(summary, ?), updated_at = ? WHERE session_id = ? AND status = 'running'").run(`The reviewer ${why}, so ansai closed it. Findings it reported are kept.`, at, r.session_id);
      emit("tasks");
      console.warn(`[ansai] auto-review of task ${r.task_id}: the reviewer ${why}; closing it`);
      await deps.close(r.session_id).catch((e) => console.error("[ansai] could not close stuck reviewer:", e));
      continue;
    }
    const nudged = db.query("SELECT 1 FROM messages WHERE to_session = ? AND from_session IS NULL AND from_label = ?").get(r.session_id, SYSTEM_LABEL);
    if (idle > NUDGE_AFTER_MS && !nudged) {
      try {
        postMessage({ from: null, to: r.session_id, label: SYSTEM_LABEL, body: "ansai: your review isn't finished. Report anything left with report_finding, then call finish_review with a short summary (call it even when you found nothing)." });
      } catch (e) {
        console.error("[ansai] could not nudge reviewer:", e);
      }
    }
  }
}

let reviewing = false;

/** Each autopilot tick: forget reviews nobody needs, unstick reviewers, start what's queued. */
export async function reviewTick(at = now()) {
  if (reviewing) return;
  reviewing = true;
  try {
    // The task moved on (you merged it, sent it back, the agent took it up again): no review.
    const dropped = db.query("UPDATE tasks SET auto_review = 0 WHERE auto_review > 0 AND (status != 'review' OR summary IS NULL)").run();
    if (dropped.changes) emit("tasks");
    await sweepStuck(at);
    let running = (db.query(`SELECT COUNT(*) AS n FROM task_reviews r JOIN sessions s ON s.id = r.session_id WHERE r.status = 'running' AND s.status = 'running'`).get() as { n: number }).n;
    const wanted = db.query("SELECT id, title, auto_review FROM tasks WHERE auto_review > 0 ORDER BY updated_at ASC").all() as { id: string; title: string; auto_review: number }[];
    for (const t of wanted) {
      if (running >= REVIEWS_AT_ONCE) break;
      const impl = implementer(t.id);
      const pick = pickReviewer(impl);
      if (!pick) continue; // both agents unavailable (usage limits): stays queued
      const prev = t.auto_review === 2 ? reviewOf(t.id) : null;
      const task = getTask(t.id);
      // One attempt: a review that can't start leaves the task as the agent finished it.
      db.query("UPDATE tasks SET auto_review = 0 WHERE id = ?").run(t.id);
      try {
        await deps.start(t.id, pick.tool, {
          round: t.auto_review,
          accountId: pick.accountId,
          previous: prev ? { findings: JSON.parse(prev.findings) as ReviewFinding[], summary: prev.summary, fix: task?.summary ?? null } : undefined,
        });
        running++;
      } catch (e) {
        console.error(`[ansai] auto-review of "${t.title}" couldn't start:`, e instanceof Error ? e.message : e);
        emit("tasks");
      }
    }
  } finally {
    reviewing = false;
  }
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const line = (f: ReviewFinding) => `- [${f.severity}] ${f.file}:${f.line} — ${clip(f.message.replace(/\s+/g, " "), 700)}`;

/** The message that hands round 1's findings back to the implementer. */
export function sendBackMessage(reviewer: ReviewerTool, title: string, findings: ReviewFinding[]): string {
  const high = findings.filter((f) => f.severity === "high");
  const rest = findings.filter((f) => f.severity !== "high");
  const out = [
    `ansai: an independent reviewer (${TOOLS[reviewer].label}) read your changes for "${clip(title, 120)}" and found ${high.length} serious problem${high.length > 1 ? "s" : ""}:`,
  ];
  let size = out[0]!.length;
  const add = (l: string) => {
    if (size + l.length > 6500) return false;
    out.push(l);
    size += l.length + 1;
    return true;
  };
  for (const f of high) if (!add(line(f))) break;
  if (rest.length && add("Also noted (your judgment):")) for (const f of rest) if (!add(line(f))) break;
  out.push(
    "Check each one against the code. Fix the ones that are right and commit. If one is wrong, leave the code as it is. Then call finish_task again; in its summary say what you fixed and which findings you rejected and why. A second review checks that.",
  );
  return out.join("\n");
}

/**
 * Called after a reviewer's finish_review. Round 1 with a high-severity finding: the findings
 * go to the implementer (once), if it's still running. Returns whether they went.
 */
export function sendBack(reviewerSessionId: string): boolean {
  const r = db.query("SELECT * FROM task_reviews WHERE session_id = ?").get(reviewerSessionId) as ReviewRow | null;
  if (!r || r.round !== 1 || r.sent_back || r.status !== "complete") return false;
  const findings = JSON.parse(r.findings) as ReviewFinding[];
  if (!findings.some((f) => f.severity === "high")) return false;
  const t = getTask(r.task_id);
  if (!t || t.status !== "review") return false;
  const impl = implementer(t.id);
  if (!impl || impl.status !== "running" || (impl.tool !== "claude" && impl.tool !== "codex")) return false;
  try {
    postMessage({ from: null, to: impl.id, label: SEND_BACK_LABEL, body: sendBackMessage(r.reviewer_tool, t.title, findings) });
  } catch (e) {
    console.error("[ansai] could not send review findings back:", e);
    return false;
  }
  db.query("UPDATE task_reviews SET sent_back = 1, updated_at = ? WHERE task_id = ?").run(now(), t.id);
  emit("tasks");
  return true;
}
