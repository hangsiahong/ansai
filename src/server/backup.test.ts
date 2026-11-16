// Database backups: a daily copy while ansai runs, old ones pruned, and each one a
// complete database that opens on its own.
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { db, backupDatabase, backupDir } = await import("./db");
const { dailyBackup, listBackups, pruneBackups } = await import("./backup");

const DAY = 24 * 3600_000;
/** An old backup file, dated `daysAgo`. */
function old(name: string, daysAgo: number) {
  mkdirSync(backupDir, { recursive: true });
  const path = join(backupDir, name);
  writeFileSync(path, "x");
  const at = (Date.now() - daysAgo * DAY) / 1000;
  utimesSync(path, at, at);
}

beforeEach(() => rmSync(backupDir, { recursive: true, force: true }));

describe("database backups", () => {
  test("a backup is a complete database that opens by itself", () => {
    db.query("INSERT OR REPLACE INTO settings (key, value) VALUES ('backup-test', '\"kept\"')").run();
    const file = backupDatabase("daily");
    const copy = new Database(file, { readonly: true });
    expect((copy.query("SELECT value FROM settings WHERE key = 'backup-test'").get() as { value: string }).value).toBe('"kept"');
    expect((copy.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
    expect((copy.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe((db.query("PRAGMA user_version").get() as { user_version: number }).user_version);
    copy.close();
    db.query("DELETE FROM settings WHERE key = 'backup-test'").run();
  });

  test("two backups in the same second don't overwrite each other", () => {
    const at = new Date();
    expect(backupDatabase("daily", at)).not.toBe(backupDatabase("daily", at));
    expect(listBackups().length).toBe(2);
  });

  test("one daily backup a day", () => {
    expect(dailyBackup()).toContain("ansai-daily-");
    expect(dailyBackup()).toBeNull();
    expect(dailyBackup(Date.now() + DAY + 1000)).toContain("ansai-daily-");
    expect(listBackups().length).toBe(2);
  });

  test("keeps the last 7 daily, the last 5 pre-update and the last 5 pre-release backups, and never touches other files", () => {
    for (let d = 1; d <= 10; d++) old(`ansai-daily-202611${String(d).padStart(2, "0")}T030000.db`, 11 - d);
    for (let v = 10; v <= 17; v++) old(`ansai-before-v${v}-20261101T0${v - 10}0000.db`, 30 - v);
    for (let h = 1; h <= 7; h++) old(`ansai-before-release-20261110T0${h}0000.db`, 20 - h);
    old("my-own-copy.db", 400);
    old("ansai-daily-notes.txt", 400);
    const gone = pruneBackups();
    expect(gone.sort()).toEqual([
      "ansai-before-release-20261110T010000.db",
      "ansai-before-release-20261110T020000.db",
      "ansai-before-v10-20261101T000000.db",
      "ansai-before-v11-20261101T010000.db",
      "ansai-before-v12-20261101T020000.db",
      "ansai-daily-20261101T030000.db",
      "ansai-daily-20261102T030000.db",
      "ansai-daily-20261103T030000.db",
    ]);
    const left = readdirSync(backupDir);
    expect(left).toContain("my-own-copy.db");
    expect(left).toContain("ansai-daily-notes.txt");
    expect(left.length).toBe(7 + 5 + 5 + 2);
  });
});
