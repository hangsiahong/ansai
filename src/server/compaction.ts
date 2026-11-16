import { db, getSetting, now, setSetting } from "./db";
import { emit } from "./events";
import { sendAtPrompt } from "./sessions";
import { contextSize } from "./transcripts";

/**
 * Compaction the agent times itself, so a long autonomous run keeps going without you.
 *
 * Claude Code compacts on its own only near the model's full window (far past 150k
 * on the big models), and every step re-reads the whole conversation until then. Only
 * the agent knows when a summary would lose nothing it still needs, so:
 * 1. Past 150k (and every 100k after), ansai tells the agent its size between steps
 *    (contextNudge, from the PostToolUse hook).
 * 2. At a good stopping point the agent calls ansai's `compact` tool with what the
 *    summary must keep and what it does next, then ends its turn.
 * 3. On that Stop, ansai keeps the session "working" (the task stays in Doing, no
 *    "done" push, shifts and team messages don't type into it) and types
 *    `/compact <keep>` once Claude is back at its prompt (startCompaction).
 * 4. When Claude reports the compaction (SessionStart, source "compact"), ansai types
 *    the agent's next step as its next prompt (compacted). If it never reports one,
 *    the agent gets its next step anyway after a few minutes, uncompacted.
 * Only Claude: Codex compacts its own conversation and has no hooks to time this.
 *
 * A plan is also written to the database. ansai gets restarted while agents work (every
 * update does it), and a plan that only lived in memory was lost with it: the agent's
 * turn then ended as an ordinary one, or its compaction finished and nobody typed its
 * next step, and the run it was meant to keep going sat idle until you looked.
 */

/** First note to the agent, then one more every STEP as it keeps growing. */
export const COMPACT_AT = 150_000;
const STEP = 100_000;

/**
 * How much of `keep` is typed after /compact. Claude Code turns a long paste into an
 * attachment and submits it as an ordinary prompt, so a 1,500-character note never ran
 * /compact at all: the agent got its own note back as a message. Short enough to stay
 * typed text; the summary is written from the whole conversation anyway, and this only
 * says what it must not drop.
 */
export const KEEP_MAX = 600;

type Plan = {
  keep: string;
  next: string;
  phase: "asked" | "compacting";
  /** When it was asked for, then when the compaction started. */
  at: number;
  /** /compact was typed (or is being typed): never type it a second time. */
  sent?: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
const plans = new Map<string, Plan>();
const PLAN_KEY = "compact-plan:";

function keepPlan(sessionId: string, p: Plan) {
  plans.set(sessionId, p);
  setSetting(PLAN_KEY + sessionId, { keep: p.keep, next: p.next, phase: p.phase, at: p.at, sent: !!p.sent });
}
function forgetPlan(sessionId: string) {
  clearTimeout(plans.get(sessionId)?.timer);
  plans.delete(sessionId);
  db.query("DELETE FROM settings WHERE key = ?").run(PLAN_KEY + sessionId);
}
const nudged = new Map<string, number>();

/** Delays, in ms (tests shorten them). */
export const timing = { afterStop: 1500, afterCompact: 1500, giveUp: 5 * 60_000 };

// Only once Claude's input box is showing: "/compact" typed into a menu would pick one of its rows.
let send: (id: string, text: string) => Promise<unknown> = (id, text) => sendAtPrompt(id, text);
/** Tests: capture what would be typed instead of driving tmux. */
export function setSender(f: typeof send) {
  send = f;
}

const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

function markState(id: string, state: "working" | "waiting", message: string | null) {
  db.query("UPDATE sessions SET agent_state = ?, agent_state_at = ?, agent_message = ? WHERE id = ? AND status = 'running'").run(state, now(), message, id);
  emit("sessions");
}

/** The agent asked to be compacted (the `compact` tool). It happens when its turn ends. */
export function requestCompaction(sessionId: string, keep: string, next: string) {
  const p = plans.get(sessionId);
  if (p?.phase === "compacting") return;
  keepPlan(sessionId, { keep: oneLine(keep, KEEP_MAX), next: next.trim().slice(0, 4000), phase: "asked", at: now() });
}

export const compactionAsked = (sessionId: string) => plans.get(sessionId)?.phase === "asked";
/** ansai typed /compact for this agent and is waiting for it to finish. */
export const compactionRunning = (sessionId: string) => plans.get(sessionId)?.phase === "compacting";

/**
 * The agent's turn ended with a compaction asked for: type /compact once Claude is back
 * at its prompt. Returns false when none was asked for (a normal end of turn).
 */
export function startCompaction(sessionId: string): boolean {
  const p = plans.get(sessionId);
  if (!p || p.phase !== "asked") return false;
  p.phase = "compacting";
  p.at = now();
  keepPlan(sessionId, p);
  markState(sessionId, "working", "Compacting the conversation");
  typeCompact(sessionId, p);
  p.timer = setTimeout(() => compacted(sessionId, "failed"), timing.giveUp);
  return true;
}

function typeCompact(sessionId: string, p: Plan) {
  setTimeout(() => {
    if (plans.get(sessionId) !== p) return;
    // Noted before typing: a restart in between must not type /compact into a compaction already running.
    p.sent = true;
    keepPlan(sessionId, p);
    send(sessionId, p.keep ? `/compact ${p.keep}` : "/compact").catch((e) => {
      console.error(`[ansai] couldn't start compacting ${sessionId}:`, e instanceof Error ? e.message : e);
      compacted(sessionId, "failed");
    });
  }, timing.afterStop);
}

/**
 * ansai just started: pick up the plans the last run left. One still waiting for its
 * turn to end needs nothing more. One already compacting gets its give-up timer back
 * (what is left of it, a minute at least), and /compact if that was never typed. If
 * the compaction finished while ansai was down, its report was lost: the agent then
 * gets its next step when the timer runs out, told that ansai can't say how it went.
 */
export function resumeCompactions() {
  for (const p of plans.values()) clearTimeout(p.timer);
  plans.clear();
  const rows = db.query("SELECT key, value FROM settings WHERE key LIKE ?").all(`${PLAN_KEY}%`) as { key: string; value: string }[];
  for (const r of rows) {
    const id = r.key.slice(PLAN_KEY.length);
    let saved: Partial<Plan> | null = null;
    try {
      saved = JSON.parse(r.value);
    } catch {}
    const running = db.query("SELECT 1 FROM sessions WHERE id = ? AND status = 'running'").get(id);
    if (!running || !saved || (saved.phase !== "asked" && saved.phase !== "compacting")) {
      db.query("DELETE FROM settings WHERE key = ?").run(r.key);
      continue;
    }
    const p: Plan = { keep: String(saved.keep ?? ""), next: String(saved.next ?? ""), phase: saved.phase, at: Number(saved.at) || now(), sent: !!saved.sent };
    plans.set(id, p);
    if (p.phase !== "compacting") continue;
    const typedBefore = p.sent;
    if (!typedBefore) typeCompact(id, p);
    const left = Math.max(timing.giveUp - (now() - p.at), Math.min(60_000, timing.giveUp));
    p.timer = setTimeout(() => compacted(id, typedBefore ? "lost" : "failed"), left);
    console.log(`[ansai] ${id} was being compacted when ansai stopped; waiting for it to finish`);
  }
}

/**
 * A compaction ended (Claude's SessionStart hook with source "compact"), or ansai gave
 * up waiting for one. Returns null when ansai didn't ask for it (yours, or Claude's own);
 * otherwise whether the agent was handed a next step (false: it waits for you).
 * "lost": ansai restarted in the middle and never heard how it went.
 */
export function compacted(sessionId: string, how: "done" | "failed" | "lost" = "done"): { continues: boolean } | null {
  const p = plans.get(sessionId);
  if (!p || p.phase !== "compacting") return null;
  forgetPlan(sessionId);
  nudged.delete(sessionId);
  if (!p.next) {
    if (how !== "done") markState(sessionId, "waiting", null);
    return { continues: false };
  }
  const intro =
    how === "done"
      ? "ansai: your conversation was compacted, as you asked."
      : how === "lost"
        ? "ansai: ansai was restarted while your conversation was being compacted, so it can't tell whether that finished."
        : "ansai: the compaction you asked for didn't happen, so your conversation is as it was.";
  setTimeout(() => {
    send(sessionId, `${intro} Carry on: ${p.next}`).catch((e) => {
      console.error(`[ansai] couldn't hand ${sessionId} its next step after compacting:`, e instanceof Error ? e.message : e);
      markState(sessionId, "waiting", null);
    });
  }, timing.afterCompact);
  return { continues: true };
}

/**
 * The agent's MCP client listed ansai's tools, so it has `compact`. Agents started
 * before ansai had the tool never re-list, and a note about a tool they don't have
 * would only confuse them. Kept in the database: the list comes once per agent, and
 * ansai may restart many times while the agent runs.
 */
export function noteToolsListed(sessionId: string) {
  if (!getSetting(`compact-tool:${sessionId}`, false)) setSetting(`compact-tool:${sessionId}`, true);
}

/**
 * A note for the agent once its conversation passes the next mark (150k, 250k, …),
 * at most once per mark; null otherwise. A compaction (any kind) starts the marks over.
 */
export function contextNudge(sessionId: string): string | null {
  if (plans.has(sessionId) || !getSetting(`compact-tool:${sessionId}`, false)) return null;
  const ctx = contextSize(sessionId);
  if (ctx === null) return null;
  if (ctx < COMPACT_AT) {
    nudged.delete(sessionId);
    return null;
  }
  const mark = COMPACT_AT + Math.floor((ctx - COMPACT_AT) / STEP) * STEP;
  if ((nudged.get(sessionId) ?? 0) >= mark) return null;
  nudged.set(sessionId, mark);
  return (
    `ansai: this conversation is ${Math.round(ctx / 1000)}k tokens, and every step re-reads all of it. ` +
    "At your next good stopping point (a piece of work finished and saved or committed, before you start the next), " +
    "call ansai's compact tool with what the summary must keep and what you'll do next, then end your turn; " +
    "ansai compacts it and hands you your next step, so you keep going without the user. " +
    "Don't break off mid-edit or mid-investigation for it, and skip it if you're about to finish."
  );
}

/** Forget a session (it ended). */
export function dropCompaction(sessionId: string) {
  forgetPlan(sessionId);
  nudged.delete(sessionId);
  db.query("DELETE FROM settings WHERE key = ?").run(`compact-tool:${sessionId}`);
}
