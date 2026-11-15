import { Database } from "bun:sqlite";
import { config } from "./config";

export const db = new Database(config.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");

// Schema migrations, keyed by PRAGMA user_version.
const migrations: string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    pinned INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    tool TEXT NOT NULL,
    name TEXT NOT NULL,
    dir TEXT,
    email TEXT,
    plan TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (tool, name)
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    position REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    tool TEXT NOT NULL,
    title TEXT NOT NULL,
    cwd TEXT NOT NULL,
    argv TEXT NOT NULL,
    tmux_name TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'running',
    exit_code INTEGER,
    agent_state TEXT,
    created_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX sessions_status ON sessions(status);
  CREATE INDEX tasks_project ON tasks(project_id, status, position);
  `,
];

{
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}

export const now = () => Date.now();

export function newId(prefix = ""): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return prefix + Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 10);
}
