import { db, now } from "./db";
import { emit } from "./events";
import { notify } from "./push";
import { runDeadline, runLimitMinutes, scanTokens } from "./runs";
import { captureHistory, closeSession, getSession, reconcile, sendKeys, sendText } from "./sessions";
import { isWatched } from "./viewers";

/**
 * Autopilot runs stop at their project's time limit. The agent's turn is
 * interrupted (Esc) and the agent quits (/exit), so the session stays listed as
 * exited and can be picked up again (resuming its conversation while warm); its
 * work stays on the task's branch. The task moves to Review with a note
 * (and a "Stopped early" reason), so the next run's handoff knows why. The run
 * also stops being an autopilot run, so picking it back up isn't cut off again.
 * A run you're looking at is left alone until you leave it.
 */

type Row = { id: string; title: string; auto: number; status: string; project_id: string | null; task_id: string | null; created_at: number };

const stopping = new Set<string>();

export async function enforceRunLimits(at = Date.now()) {
  const rows = db
    .query("SELECT id, title, auto, status, project_id, task_id, created_at FROM sessions WHERE status = 'running' AND auto = 1 AND task_id IS NOT NULL")
    .all() as Row[];
  for (const s of rows) {
    const deadline = runDeadline(s);
    if (!deadline || at < deadline || stopping.has(s.id) || isWatched(s.id)) continue;
    stopping.add(s.id);
    try {
      await stopRun(s, runLimitMinutes(s.project_id)!);
    } catch (e) {
      console.error(`[ansai] couldn't stop "${s.title}" at its time limit:`, e instanceof Error ? e.message : e);
    } finally {
      stopping.delete(s.id);
    }
  }
}

const minutes = (m: number) => (m % 60 ? `${m}-minute` : `${m / 60}-hour`);

async function stopRun(s: Row, limit: number) {
  const reason = `hit the ${minutes(limit)} time limit for autopilot runs`;
  // Review first, so the close below isn't taken for a crash (and retried).
  db.query(
    `UPDATE tasks SET status = 'review', queued = 0, last_failure = ?, summary = ?, updated_at = ? WHERE id = ? AND status = 'doing'`,
  ).run(
    reason,
    `Autopilot stopped this run: it ${reason} in this project. Its work so far is on the task's branch. Continue it from the task (the last session resumes its conversation for about an hour), or raise the limit in the project's Autopilot settings.`,
    now(),
    s.task_id,
  );
  db.query("UPDATE sessions SET auto = 0 WHERE id = ?").run(s.id);
  emit("tasks");
  // End the turn first: typed mid-turn, /exit only joins the queue. Claude and Codex show
  // "esc to interrupt" exactly while a turn runs (an interrupt fires no Stop hook, so the
  // screen is the signal). Esc 2 s apart, so two presses never count as Claude's double-Esc.
  const busy = () => sampleBusy(() => captureHistory(s.id, 0).catch(() => ""));
  for (let i = 0; i < 15 && (await busy()); i++) {
    await sendKeys(s.id, ["Escape"]).catch(() => {});
    await Bun.sleep(2000);
  }
  // Esc early in a turn makes Claude rewind the prompt into its input box, and /exit typed onto
  // it would resubmit the task. Ctrl+C clears the box (on an empty one it only arms "again to exit").
  await sendKeys(s.id, ["C-c"]).catch(() => {});
  await Bun.sleep(500);
  await sendText(s.id, "/exit").catch(() => {});
  for (let i = 0; i < 20 && getSession(s.id)?.status === "running"; i++) {
    await Bun.sleep(500);
    await reconcile();
  }
  if (getSession(s.id)?.status === "running") await closeSession(s.id); // it didn't quit: stop it anyway
  notify("exited", { title: `Time limit · ${s.title}`, body: `Autopilot stopped it after ${limit} min. It's in Review.`, url: `/s/${s.id}`, tag: `s-${s.id}` }).catch(() => {});
}

/**
 * Is a turn running? Claude drops its "esc to interrupt" footer for a moment between
 * API requests, so one look can catch an idle-looking screen mid-turn (then /exit only
 * joins the queue and the run gets force-closed). Look a few times over ~2 s: busy if
 * any look shows it.
 */
export async function sampleBusy(read: () => Promise<string>, looks = 5, gapMs = 400): Promise<boolean> {
  for (let i = 0; i < looks; i++) {
    if (i) await Bun.sleep(gapMs);
    if (/esc to interrup[t]/i.test(await read())) return true;
  }
  return false;
}

/** Every few seconds: count running sessions' tokens, and stop runs past their time limit. */
export function startRunWatch(ms = 5000) {
  const tick = async () => {
    try {
      if (await scanTokens()) emit("activity");
      await enforceRunLimits();
    } catch (e) {
      console.error("[ansai] run watch:", e);
    } finally {
      setTimeout(tick, ms);
    }
  };
  setTimeout(tick, 2000);
}
