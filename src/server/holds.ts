import { db, getSetting, now, setSetting } from "./db";
import { emit } from "./events";
import { notify } from "./push";
import { addPaused, dropPaused } from "./runs";
import { sendAtPrompt, sendKeys } from "./sessions";
import { storedLimits } from "./usage";

/**
 * A Claude turn that stopped on an error ansai can wait out, so a night's queue isn't
 * lost to it.
 *
 * - Usage limit (`rate_limit`): the account is at its limit until a window resets. The run
 *   that hit it is held: it gives its autopilot slot back, queued tasks that would use the
 *   same account stay queued (tasks on other accounts and agents keep starting), and at
 *   the reset ansai tells the run to carry on. The reset time comes from the account's
 *   last limits snapshot; while that doesn't show a used-up window, ansai tries again
 *   every 15 minutes instead.
 * - Overloaded / server error: the run is told to carry on once, a few minutes later.
 *
 * Only autopilot runs are carried on (`resume`). A session of yours that hits the limit
 * is only noted, so autopilot doesn't start new work on that account meanwhile.
 * Holds live in the database: ansai restarts while agents wait.
 */

export type Hold = {
  /** The account whose limit it is. */
  account: string;
  kind: "limit" | "retry";
  /** When the run stopped, and when ansai carries it on. */
  at: number;
  until: number;
  /** `until` is the limit's real reset time (not a guess to try again at). */
  known: boolean;
  /** An autopilot run: ansai carries it on. Otherwise this only marks the account. */
  resume: boolean;
  /** How often ansai has told this run to carry on since it last finished a turn. */
  tries: number;
  /** ansai told it to carry on: no longer held, only remembered in case it fails again. */
  sent?: number;
};

const KEY = "run-hold:";

/** Delays, in ms (tests shorten them). */
export const timing = { retry: 3 * 60_000, unknown: 15 * 60_000, slack: 60_000 };
/** After this many tries in a row the run waits for you, as it did before. */
export const MAX_TRIES = 8;

let send = async (id: string, text: string) => {
  try {
    await sendAtPrompt(id, text);
  } catch {
    // At its limit Claude can leave a menu open (wait for the reset, or pay for more). The turn
    // is over, so Esc only closes that menu; then the input box is there to type into.
    await sendKeys(id, ["Escape"]);
    await sendAtPrompt(id, text);
  }
};
/** Tests: capture what would be typed instead of driving tmux. */
export function setSender(f: typeof send) {
  send = f;
}

const get = (sessionId: string) => getSetting<Hold | null>(KEY + sessionId, null);
function keep(sessionId: string, h: Hold) {
  setSetting(KEY + sessionId, h);
  emit("accounts");
}
function allHolds(): { id: string; hold: Hold }[] {
  const rows = db.query("SELECT key, value FROM settings WHERE key LIKE ?").all(`${KEY}%`) as { key: string; value: string }[];
  return rows.flatMap((r) => {
    try {
      return [{ id: r.key.slice(KEY.length), hold: JSON.parse(r.value) as Hold }];
    } catch {
      return [];
    }
  });
}

/** Forget a run's hold: it finished a turn, you took it over, or it ended. */
export function dropHold(sessionId: string, ended = false) {
  const r = db.query("DELETE FROM settings WHERE key = ?").run(KEY + sessionId);
  if (ended) dropPaused(sessionId);
  if (r.changes) emit("accounts");
}

/** You (or anything but ansai's own "carry on") typed into a held run: it is yours again. */
export function promptedWhileHeld(sessionId: string) {
  const h = get(sessionId);
  if (h && !h.sent) dropHold(sessionId);
}

/** When the used-up window of this Claude account resets, from its last limits snapshot (null: none is used up). */
export function limitReset(accountId: string, at = now()): number | null {
  const snap = storedLimits(accountId)?.data;
  if (!snap) return null;
  const resets = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"]
    .filter((k) => Number(snap[k]?.utilization) >= 100)
    .map((k) => Date.parse(snap[k].resets_at))
    .filter((reset) => reset > at);
  return resets.length ? Math.max(...resets) : null;
}

/** "at about 03:10", or with the day when that isn't today. */
export function when(ms: number, at = now()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date(at).toDateString() ? `at about ${time}` : `on ${d.toLocaleDateString("en", { month: "short", day: "numeric" })} at about ${time}`;
}

/** What the held run's session says under "Stopped: <why>". */
export const holdNote = (h: Hold) => (h.known ? `ansai carries on ${when(h.until)}` : `ansai tries again ${when(h.until)}`);

/**
 * A Claude turn ended on `error`. Returns the hold when ansai will carry the run on by
 * itself (so it needn't ask you), null when it is left to you.
 * `resume`: an autopilot run working a task, not on shift.
 */
export function holdRun(sessionId: string, error: string, resume: boolean): Hold | null {
  const limit = error === "rate_limit";
  if (!limit && !(resume && (error === "overloaded" || error === "server_error"))) return null;
  const s = db.query("SELECT account_id, tool FROM sessions WHERE id = ?").get(sessionId) as { account_id: string | null; tool: string } | null;
  if (!s) return null;
  const account = s.account_id ?? `${s.tool}-default`;
  const prev = get(sessionId);
  const tries = prev?.sent ? prev.tries : 0;
  // It failed again right after ansai told it to carry on: once for a server error, a few times for a limit.
  if (tries >= (limit ? MAX_TRIES : 1)) {
    dropHold(sessionId);
    return null;
  }
  const at = now();
  const reset = limit ? limitReset(account, at) : null;
  const h: Hold = {
    account,
    kind: limit ? "limit" : "retry",
    at,
    until: reset ? reset + timing.slack : at + (limit ? timing.unknown : timing.retry),
    known: !!reset,
    resume,
    tries,
  };
  keep(sessionId, h);
  return resume ? h : null;
}

/** Until when autopilot should start nothing new on this account (null: it is free). */
export function heldUntil(accountId: string, at = now()): number | null {
  const untils = allHolds()
    .filter(({ hold: h }) => h.kind === "limit" && !h.sent && h.account === accountId && h.until > at)
    .map(({ hold: h }) => h.until);
  return untils.length ? Math.max(...untils) : null;
}

/** Is this run held for a usage limit (it gave its autopilot slot back)? */
export function isHeld(sessionId: string): boolean {
  const h = get(sessionId);
  return !!h && h.kind === "limit" && h.resume && !h.sent;
}

/**
 * Every autopilot tick: learn reset times that weren't known yet, and tell the runs
 * whose wait is over to carry on.
 */
export async function resumeHeld(at = now()) {
  for (const { id, hold: h } of allHolds()) {
    if (h.sent) continue;
    const s = db.query("SELECT id, title, task_id, agent_message FROM sessions WHERE id = ? AND status = 'running'").get(id) as
      | { id: string; title: string; task_id: string | null; agent_message: string | null }
      | null;
    if (!s) {
      dropHold(id, true);
      continue;
    }
    if (h.kind === "limit" && !h.known) {
      // The limits are polled every few minutes: the snapshot that shows the used-up window can come after the failure.
      const reset = limitReset(h.account, at);
      if (reset) {
        h.until = reset + timing.slack;
        h.known = true;
        keep(id, h);
        if (h.resume && s.agent_message?.startsWith("Stopped:")) {
          db.query("UPDATE sessions SET agent_message = ? WHERE id = ?").run(s.agent_message.replace(/\. ansai .*$/, "") + `. ${holdNote(h)}`, id);
          emit("sessions");
        }
      }
    }
    if (h.until > at) continue;
    if (!h.resume) {
      dropHold(id);
      continue;
    }
    // Noted before typing: a restart in between must not type it twice.
    h.sent = at;
    h.tries++;
    keep(id, h);
    addPaused(id, at - h.at); // the wait doesn't count toward the project's time limit
    const text =
      h.kind === "limit"
        ? "ansai: this account's usage limit should have reset by now. Carry on where you stopped."
        : "ansai: your turn stopped on an error from Claude's servers. Carry on where you stopped.";
    try {
      await send(id, text);
    } catch (e) {
      console.error(`[ansai] couldn't carry ${id} on after its wait:`, e instanceof Error ? e.message : e);
      dropHold(id);
      db.query("UPDATE sessions SET agent_message = ? WHERE id = ? AND status = 'running'").run(
        "Stopped, and ansai couldn't carry it on: its input box isn't on its screen",
        id,
      );
      emit("sessions");
      notify("input", {
        title: `Needs you · ${s.title}`,
        body: "Its wait is over, but ansai couldn't tell it to carry on: a menu or a question is on its screen. Open it and answer.",
        url: `/s/${id}`,
        tag: `s-${id}`,
      }).catch(() => {});
    }
  }
}
