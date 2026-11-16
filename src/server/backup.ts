import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { backupDatabase, backupDir } from "./db";

/**
 * Backups of ansai's database (tasks, sessions, accounts, messages, settings), in
 * ~/.ansai/backups. One a day while ansai runs, plus one before every schema update
 * (db.ts). Old ones are removed: the last KEEP_DAILY daily copies and the last
 * KEEP_UPDATES pre-update copies stay.
 *
 * To restore: stop ansai, copy the backup over ~/.ansai/ansai.db, delete ansai.db-wal
 * and ansai.db-shm, start ansai.
 */
const KEEP_DAILY = 7;
const KEEP_UPDATES = 5;
const DAY = 24 * 3600_000;

type Backup = { file: string; kind: "daily" | "update"; at: number };

export function listBackups(): Backup[] {
  let names: string[];
  try {
    names = readdirSync(backupDir);
  } catch {
    return [];
  }
  const out: Backup[] = [];
  for (const file of names) {
    const m = /^ansai-(daily|before-v\d+)-\d{8}T\d{6}(-\d+)?\.db$/.exec(file);
    if (!m) continue; // not ours: never touched
    try {
      out.push({ file, kind: m[1] === "daily" ? "daily" : "update", at: statSync(join(backupDir, file)).mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Remove backups beyond what's kept. Returns the files removed. */
export function pruneBackups(): string[] {
  const all = listBackups();
  const drop = [...all.filter((b) => b.kind === "daily").slice(KEEP_DAILY), ...all.filter((b) => b.kind === "update").slice(KEEP_UPDATES)];
  const gone: string[] = [];
  for (const b of drop) {
    try {
      unlinkSync(join(backupDir, b.file));
      gone.push(b.file);
    } catch {}
  }
  return gone;
}

/** Make today's backup unless one was made in the last day. Returns the new file, or null. */
export function dailyBackup(at = Date.now()): string | null {
  const last = listBackups().find((b) => b.kind === "daily");
  if (last && at - last.at < DAY) return null;
  const file = backupDatabase("daily", new Date(at));
  pruneBackups();
  return file;
}

export function startBackupLoop() {
  const tick = () => {
    try {
      const file = dailyBackup();
      if (file) console.log(`[ansai] daily database backup: ${file}`);
    } catch (e) {
      console.error("[ansai] daily database backup failed:", e);
    }
  };
  setTimeout(tick, 60_000); // not during startup
  setInterval(tick, 3600_000);
}
