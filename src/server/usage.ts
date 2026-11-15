import { existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { db, now } from "./db";

/**
 * Token usage comes from each CLI's own local logs (Claude Code transcripts,
 * Codex rollout files). They are append-only JSONL, so we remember a byte
 * offset per file and only ever read what was appended since the last scan.
 * Only lines containing the marker bytes are JSON-parsed.
 */

const WINDOW_DAYS = 8;
const KEEP_DAYS = 35;

type Progress = { offset: number };
const getProgress = db.query("SELECT offset FROM usage_files WHERE path = ?");
const setProgress = db.query(
  "INSERT INTO usage_files (path, account_id, offset) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, account_id = excluded.account_id",
);
const insertEvent = db.query(
  `INSERT OR IGNORE INTO usage_events (account_id, key, ts, tokens, output, model, input, cache_write, cache_read)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const upsertLimits = db.query(
  "INSERT INTO usage_limits (account_id, data, at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET data = excluded.data, at = excluded.at WHERE excluded.at >= usage_limits.at",
);

const SLICE = 4 * 1024 * 1024;

/**
 * Read complete lines from `offset` in fixed slices, yielding to the event loop
 * between slices so terminals stay responsive while gigabytes of logs are scanned.
 * Returns the offset just past the last complete line.
 */
async function readNewLines(path: string, offset: number, marker: string, onLine: (line: string, at: number) => void): Promise<number> {
  const file = Bun.file(path);
  const size = file.size;
  let pos = offset; // file offset of buf[0]
  let buf: Buffer = Buffer.alloc(0);
  let read = offset;
  while (read < size) {
    const chunk = Buffer.from(await file.slice(read, Math.min(read + SLICE, size)).arrayBuffer());
    read += chunk.length;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(10, start);
      if (nl === -1) break;
      const line = buf.subarray(start, nl);
      if (line.indexOf(marker) !== -1) onLine(line.toString("utf8"), pos + start);
      start = nl + 1;
    }
    buf = buf.subarray(start);
    pos += start;
    await Bun.sleep(1); // let sockets breathe
  }
  return pos;
}

async function scanTree(
  accountId: string,
  root: string,
  marker: string,
  handle: (line: string, key: string) => void,
  opts: { includeNewest?: boolean } = {},
) {
  if (!existsSync(root)) return;
  const cutoff = now() - WINDOW_DAYS * 86400_000;
  const files: { path: string; mtime: number; size: number }[] = [];
  for await (const rel of new Bun.Glob("**/*.jsonl").scan({ cwd: root, onlyFiles: true })) {
    const path = join(root, rel);
    try {
      const st = statSync(path);
      files.push({ path, mtime: st.mtimeMs, size: st.size });
    } catch {}
  }
  // The newest file still carries the last known rate limits even when it's old.
  const newest = opts.includeNewest ? files.reduce<(typeof files)[number] | null>((m, f) => (!m || f.mtime > m.mtime ? f : m), null) : null;
  for (const { path, mtime, size } of files) {
    if (mtime < cutoff && path !== newest?.path) continue;
    const st = { size };
    let offset = (getProgress.get(path) as Progress | null)?.offset ?? 0;
    if (st.size === offset) continue;
    if (st.size < offset) offset = 0; // rewritten; event keys dedupe re-reads
    const lines: [string, string][] = [];
    const end = await readNewLines(path, offset, marker, (line, at) => lines.push([line, `${relative(root, path)}:${at}`]));
    db.transaction(() => {
      for (const [line, key] of lines) {
        try {
          handle(line, key);
        } catch {}
      }
      setProgress.run(path, accountId, end);
    })();
    await Bun.sleep(1);
  }
}

export async function scanClaude(accountId: string, configDir: string) {
  await scanTree(accountId, join(configDir, "projects"), '"usage"', (line) => {
    const j = JSON.parse(line);
    if (j.type !== "assistant") return;
    const u = j.message?.usage;
    if (!u) return;
    const ts = Date.parse(j.timestamp);
    if (!Number.isFinite(ts)) return;
    const out = u.output_tokens ?? 0;
    const input = u.input_tokens ?? 0;
    const write = u.cache_creation_input_tokens ?? 0;
    const read = u.cache_read_input_tokens ?? 0;
    // Streaming writes the same API message more than once; message id + request id is unique.
    insertEvent.run(accountId, `${j.message?.id}:${j.requestId}`, ts, input + out + write + read, out, j.message?.model ?? null, input, write, read);
  });
}

export async function scanCodex(accountId: string, codexHome: string) {
  await scanTree(accountId, join(codexHome, "sessions"), '"token_count"', (line, key) => {
    const j = JSON.parse(line);
    const p = j.payload;
    if (p?.type !== "token_count") return;
    const ts = Date.parse(j.timestamp);
    if (!Number.isFinite(ts)) return;
    const last = p.info?.last_token_usage;
    if (last) {
      // OpenAI-style usage: input_tokens includes cached_input_tokens, and output_tokens already
      // includes reasoning_output_tokens (adding them again double-counted).
      const cached = last.cached_input_tokens ?? 0;
      const input = Math.max(0, (last.input_tokens ?? 0) - cached);
      const out = last.output_tokens ?? 0;
      insertEvent.run(accountId, key, ts, last.total_tokens ?? input + cached + out, out, null, input, 0, cached);
    }
    if (p.rate_limits) upsertLimits.run(accountId, JSON.stringify(p.rate_limits), ts);
  }, { includeNewest: true });
}

export function prune() {
  db.query("DELETE FROM usage_events WHERE ts < ?").run(now() - KEEP_DAYS * 86400_000);
}

/**
 * Headline numbers are fresh tokens: input + cache writes + output, the work that
 * costs full price. Cache reads (re-reading context already cached, a small fraction
 * of the price) are reported on their own, for the last 7 days.
 */
export type TokenSummary = { five_hour: number; today: number; week: number; daily: number[]; cache_read_week: number; total_week: number };

const FRESH = "(input + cache_write + output)";

export function tokenSummary(accountId: string): TokenSummary {
  const t = now();
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const day0 = midnight.getTime() - 6 * 86400_000;
  const r = db
    .query(
      `SELECT
         COALESCE(SUM(CASE WHEN ts > ? THEN ${FRESH} END), 0) AS five_hour,
         COALESCE(SUM(CASE WHEN ts >= ? THEN ${FRESH} END), 0) AS today,
         COALESCE(SUM(CASE WHEN ts > ? THEN ${FRESH} END), 0) AS week,
         COALESCE(SUM(CASE WHEN ts > ? THEN cache_read END), 0) AS cache_read_week,
         COALESCE(SUM(CASE WHEN ts > ? THEN tokens END), 0) AS total_week
       FROM usage_events WHERE account_id = ? AND ts >= ?`,
    )
    .get(
      t - 5 * 3600_000,
      midnight.getTime(),
      t - 7 * 86400_000,
      t - 7 * 86400_000,
      t - 7 * 86400_000,
      accountId,
      Math.min(day0, t - 7 * 86400_000),
    ) as Omit<TokenSummary, "daily">;
  const rows = db
    .query(
      `SELECT CAST((ts - ?) / 86400000 AS INTEGER) AS d, SUM(${FRESH}) AS n FROM usage_events
       WHERE account_id = ? AND ts >= ? GROUP BY d`,
    )
    .all(day0, accountId, day0) as { d: number; n: number }[];
  const daily = Array(7).fill(0);
  for (const x of rows) if (x.d >= 0 && x.d < 7) daily[x.d] = x.n;
  return { ...r, daily };
}

export function storedLimits(accountId: string): { data: any; at: number } | null {
  const r = db.query("SELECT data, at FROM usage_limits WHERE account_id = ?").get(accountId) as { data: string; at: number } | null;
  return r ? { data: JSON.parse(r.data), at: r.at } : null;
}
