import { db, getSetting, setSetting } from "./db";
import { eachLine } from "./files";

/**
 * Bounds for unattended work: how long an autopilot run may take (a project
 * setting), and how many tokens a session has spent so far, read from the
 * agent's own log. Kept free of session/task imports so sessionView can use it.
 */

/** Same split as Accounts: fresh = input + cache writes + output (full price); cache reads apart. */
export type RunTokens = { fresh: number; cached: number };

/** A project's time limit per autopilot run, in minutes (null = none). */
export function runLimitMinutes(projectId: string | null): number | null {
  if (!projectId) return null;
  const r = db.query("SELECT autopilot FROM projects WHERE id = ?").get(projectId) as { autopilot: string | null } | null;
  try {
    const m = JSON.parse(r?.autopilot ?? "null")?.maxMinutes;
    return typeof m === "number" && m > 0 ? m : null;
  } catch {
    return null;
  }
}

/**
 * Time a run spent waiting for its account's usage limit to reset (holds.ts). It doesn't
 * count toward the time limit: a run held for three hours would otherwise be stopped the
 * moment it carried on.
 */
const PAUSED = "run-paused:";
export const pausedMs = (sessionId: string) => getSetting<number>(PAUSED + sessionId, 0);
export const addPaused = (sessionId: string, ms: number) => setSetting(PAUSED + sessionId, pausedMs(sessionId) + Math.max(0, ms));
export const dropPaused = (sessionId: string) => void db.query("DELETE FROM settings WHERE key = ?").run(PAUSED + sessionId);

/** When a running autopilot run must stop by: only while its task is in Doing and its project has a limit. */
export function runDeadline(s: { id?: string; auto: number; status: string; project_id: string | null; task_id: string | null; created_at: number }): number | null {
  if (!s.auto || s.status !== "running" || !s.task_id) return null;
  const m = runLimitMinutes(s.project_id);
  if (!m) return null;
  const t = db.query("SELECT status FROM tasks WHERE id = ?").get(s.task_id) as { status: string } | null;
  return t?.status === "doing" ? s.created_at + m * 60_000 + (s.id ? pausedMs(s.id) : 0) : null;
}

// ------------------------------------------------------------------ tokens

type Scan = { path: string; offset: number; tokens: RunTokens; recent: string[] };
const scans = new Map<string, Scan>(); // by session id

/** Tokens a session has spent so far, as of the last scan (null until its log has some). */
export function sessionTokens(id: string): RunTokens | null {
  const t = scans.get(id)?.tokens;
  return t && t.fresh + t.cached > 0 ? t : null;
}

/** Only log lines carrying this text can hold token counts; the rest are never parsed. */
const usageMarker = (tool: string) => (tool === "claude" ? '"usage"' : '"token_count"');

/** Add one log line's usage to a scan. Exported for tests. */
export function addUsage(sc: Scan, tool: string, line: string) {
  if (!line.includes(usageMarker(tool))) return;
  const j = JSON.parse(line);
  if (tool === "claude") {
    const u = j.type === "assistant" ? j.message?.usage : null;
    const id = j.message?.id;
    if (!u || !id || sc.recent.includes(id)) return; // streaming writes one API message as several lines
    sc.recent.push(id);
    if (sc.recent.length > 64) sc.recent.shift();
    sc.tokens.fresh += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
    sc.tokens.cached += u.cache_read_input_tokens ?? 0;
  } else if (j.payload?.type === "token_count") {
    // Codex keeps a running total; its input_tokens include the cached ones.
    const t = j.payload.info?.total_token_usage;
    if (!t) return;
    const cached = t.cached_input_tokens ?? 0;
    sc.tokens = { fresh: Math.max(0, (t.input_tokens ?? 0) - cached) + (t.output_tokens ?? 0), cached };
  }
}

export const newScan = (path: string): Scan => ({ path, offset: 0, tokens: { fresh: 0, cached: 0 }, recent: [] });

/** How much of a log is in memory at a time. Logs reach hundreds of MB, and after a restart a scan starts from the top. */
const SLICE = 4 * 1024 * 1024;

/** Read what running Claude/Codex sessions have logged since the last scan. Returns true if any total changed. */
export async function scanTokens(slice = SLICE): Promise<boolean> {
  const rows = db
    .query("SELECT id, tool, transcript FROM sessions WHERE status = 'running' AND tool IN ('claude', 'codex') AND transcript IS NOT NULL")
    .all() as { id: string; tool: string; transcript: string }[];
  let changed = false;
  for (const r of rows) {
    let sc = scans.get(r.id);
    if (!sc || sc.path !== r.transcript) scans.set(r.id, (sc = newScan(r.transcript))); // Claude starts a new log after /clear
    if (Bun.file(r.transcript).size <= sc.offset) continue;
    // Counted on a copy and swapped in at the end, so a half-read log never shows as the session's total.
    const next: Scan = { path: sc.path, offset: sc.offset, tokens: { ...sc.tokens }, recent: [...sc.recent] };
    const marker = usageMarker(r.tool);
    next.offset =
      (await eachLine(
        r.transcript,
        sc.offset,
        (line) => {
          if (line.indexOf(marker) === -1) return; // most of a log is tool output: skip it without decoding
          try {
            addUsage(next, r.tool, line.toString("utf8"));
          } catch {}
        },
        { slice },
      )) ?? sc.offset;
    if (next.offset === sc.offset) continue; // no complete line yet
    scans.set(r.id, next);
    if (next.tokens.fresh + next.tokens.cached !== sc.tokens.fresh + sc.tokens.cached) changed = true;
  }
  return changed;
}
