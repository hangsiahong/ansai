import { db } from "./db";

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

/** When a running autopilot run must stop by: only while its task is in Doing and its project has a limit. */
export function runDeadline(s: { auto: number; status: string; project_id: string | null; task_id: string | null; created_at: number }): number | null {
  if (!s.auto || s.status !== "running" || !s.task_id) return null;
  const m = runLimitMinutes(s.project_id);
  if (!m) return null;
  const t = db.query("SELECT status FROM tasks WHERE id = ?").get(s.task_id) as { status: string } | null;
  return t?.status === "doing" ? s.created_at + m * 60_000 : null;
}

// ------------------------------------------------------------------ tokens

type Scan = { path: string; offset: number; tokens: RunTokens; recent: string[] };
const scans = new Map<string, Scan>(); // by session id

/** Tokens a session has spent so far, as of the last scan (null until its log has some). */
export function sessionTokens(id: string): RunTokens | null {
  const t = scans.get(id)?.tokens;
  return t && t.fresh + t.cached > 0 ? t : null;
}

/** Add one log line's usage to a scan. Exported for tests. */
export function addUsage(sc: Scan, tool: string, line: string) {
  if (!line.includes(tool === "claude" ? '"usage"' : '"token_count"')) return;
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

/** Read what running Claude/Codex sessions have logged since the last scan. Returns true if any total changed. */
export async function scanTokens(): Promise<boolean> {
  const rows = db
    .query("SELECT id, tool, transcript FROM sessions WHERE status = 'running' AND tool IN ('claude', 'codex') AND transcript IS NOT NULL")
    .all() as { id: string; tool: string; transcript: string }[];
  let changed = false;
  for (const r of rows) {
    let sc = scans.get(r.id);
    if (!sc || sc.path !== r.transcript) scans.set(r.id, (sc = newScan(r.transcript))); // Claude starts a new log after /clear
    const file = Bun.file(r.transcript);
    const size = file.size;
    if (size <= sc.offset) continue;
    const text = await file.slice(sc.offset, size).text();
    const end = text.lastIndexOf("\n");
    if (end < 0) continue;
    const before = sc.tokens.fresh + sc.tokens.cached;
    for (const line of text.slice(0, end).split("\n")) {
      try {
        addUsage(sc, r.tool, line);
      } catch {}
    }
    sc.offset += Buffer.byteLength(text.slice(0, end + 1));
    if (sc.tokens.fresh + sc.tokens.cached !== before) changed = true;
  }
  return changed;
}
