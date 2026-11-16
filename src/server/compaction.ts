import { db, getSetting, now, setSetting } from "./db";
import { emit } from "./events";
import { sendText } from "./sessions";
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

type Plan = { keep: string; next: string; phase: "asked" | "compacting"; timer?: ReturnType<typeof setTimeout> };
const plans = new Map<string, Plan>();
const nudged = new Map<string, number>();

/** Delays, in ms (tests shorten them). */
export const timing = { afterStop: 1500, afterCompact: 1500, giveUp: 5 * 60_000 };

let send: (id: string, text: string) => Promise<unknown> = (id, text) => sendText(id, text, true);
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
  plans.set(sessionId, { keep: oneLine(keep, KEEP_MAX), next: next.trim().slice(0, 4000), phase: "asked" });
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
  markState(sessionId, "working", "Compacting the conversation");
  setTimeout(() => {
    if (plans.get(sessionId) !== p) return;
    send(sessionId, p.keep ? `/compact ${p.keep}` : "/compact").catch((e) => {
      console.error(`[ansai] couldn't start compacting ${sessionId}:`, e instanceof Error ? e.message : e);
      compacted(sessionId, "failed");
    });
  }, timing.afterStop);
  p.timer = setTimeout(() => compacted(sessionId, "failed"), timing.giveUp);
  return true;
}

/**
 * A compaction ended (Claude's SessionStart hook with source "compact"), or ansai gave
 * up waiting for one. Returns null when ansai didn't ask for it (yours, or Claude's own);
 * otherwise whether the agent was handed a next step (false: it waits for you).
 */
export function compacted(sessionId: string, how: "done" | "failed" = "done"): { continues: boolean } | null {
  const p = plans.get(sessionId);
  if (!p || p.phase !== "compacting") return null;
  plans.delete(sessionId);
  clearTimeout(p.timer);
  nudged.delete(sessionId);
  if (!p.next) {
    if (how === "failed") markState(sessionId, "waiting", null);
    return { continues: false };
  }
  const intro = how === "done" ? "ansai: your conversation was compacted, as you asked." : "ansai: the compaction you asked for didn't happen, so your conversation is as it was.";
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
  clearTimeout(plans.get(sessionId)?.timer);
  plans.delete(sessionId);
  nudged.delete(sessionId);
  db.query("DELETE FROM settings WHERE key = ?").run(`compact-tool:${sessionId}`);
}
