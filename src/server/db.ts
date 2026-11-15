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
  // v2: tasks may live in the Inbox (no project); priority + done_at.
  `
  CREATE TABLE tasks_v2 (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    priority INTEGER NOT NULL DEFAULT 0,
    position REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    done_at INTEGER
  );
  INSERT INTO tasks_v2 (id, project_id, title, body, status, position, created_at, updated_at)
    SELECT id, project_id, title, body, status, position, created_at, updated_at FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_v2 RENAME TO tasks;
  CREATE INDEX tasks_project ON tasks(project_id, status, position);
  CREATE INDEX sessions_task ON sessions(task_id);
  `,
  // v3: token usage read incrementally from each tool's local logs.
  `
  CREATE TABLE usage_files (
    path TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    offset INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE usage_events (
    account_id TEXT NOT NULL,
    key TEXT NOT NULL,
    ts INTEGER NOT NULL,
    tokens INTEGER NOT NULL,
    output INTEGER NOT NULL,
    model TEXT,
    PRIMARY KEY (account_id, key)
  );
  CREATE INDEX usage_events_ts ON usage_events(account_id, ts);
  CREATE TABLE usage_limits (
    account_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  `,
  // v4: agent status from hooks; web push subscriptions.
  `
  ALTER TABLE sessions ADD COLUMN agent_state_at INTEGER;
  ALTER TABLE sessions ADD COLUMN agent_message TEXT;
  CREATE TABLE push_subs (
    endpoint TEXT PRIMARY KEY,
    keys TEXT NOT NULL,
    user TEXT,
    prefs TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    last_ok_at INTEGER
  );
  `,
  // v5: key/value settings (device allow-list, …).
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // v6: where each agent writes its conversation log (for the chat view).
  `
  ALTER TABLE sessions ADD COLUMN transcript TEXT;
  `,
  // v7: agents work the backlog — queue, plan progress, summaries, autopilot per project.
  `
  ALTER TABLE tasks ADD COLUMN queued INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN plan TEXT;
  ALTER TABLE tasks ADD COLUMN summary TEXT;
  ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'you';
  ALTER TABLE projects ADD COLUMN autopilot TEXT;
  ALTER TABLE sessions ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;
  `,
  // v8: each task can keep an isolated Git worktree for its agent sessions.
  `
  ALTER TABLE tasks ADD COLUMN worktree_path TEXT;
  ALTER TABLE tasks ADD COLUMN worktree_branch TEXT;
  `,
  // v9: the model and reasoning effort each agent is actually running with (read from its log).
  `
  ALTER TABLE sessions ADD COLUMN model TEXT;
  ALTER TABLE sessions ADD COLUMN effort TEXT;
  `,
  // v10: agents talk to each other (and you): direct messages and a project-wide channel.
  // msg_cursor = the newest message id already delivered to that session.
  `
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    from_session TEXT,
    from_label TEXT NOT NULL,
    to_session TEXT,
    to_label TEXT,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX messages_project ON messages(project_id, id);
  CREATE INDEX messages_to ON messages(to_session, id);
  ALTER TABLE sessions ADD COLUMN msg_cursor INTEGER NOT NULL DEFAULT 0;
  `,
  // v11: token usage split into its parts. Cache reads are most of the total but cost a
  // fraction of fresh input, so one sum overstated real use 5-7x. The last 8 days of logs
  // are rescanned to fill the new columns (that's all the Accounts page shows).
  `
  ALTER TABLE usage_events ADD COLUMN input INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE usage_events ADD COLUMN cache_write INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE usage_events ADD COLUMN cache_read INTEGER NOT NULL DEFAULT 0;
  DELETE FROM usage_events;
  DELETE FROM usage_files;
  `,
  // v12: shifts keep an agent working until a set time (src/server/shifts.ts). One row per session; the last shift's report stays.
  `
  CREATE TABLE shifts (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    until INTEGER NOT NULL,
    focus TEXT,
    started_at INTEGER NOT NULL,
    nudges INTEGER NOT NULL DEFAULT 0,
    idle INTEGER NOT NULL DEFAULT 0,
    worked INTEGER NOT NULL DEFAULT 0,
    last_nudge_at INTEGER,
    ended_at INTEGER,
    end_reason TEXT,
    summary TEXT,
    report TEXT
  );
  `,
  // v13: autopilot runs that die mid-task: how often it was retried, and why the last run stopped.
  `
  ALTER TABLE tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN last_failure TEXT;
  `,
  // v14: explicit task ordering dependencies.
  `
  CREATE TABLE task_dependencies (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, depends_on_task_id),
    CHECK (task_id != depends_on_task_id)
  );
  CREATE INDEX task_dependencies_prerequisite ON task_dependencies(depends_on_task_id);
  `,
  // v15: recurring prompts and durable, uniquely keyed occurrences.
  `
  CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    title TEXT NOT NULL,
    tool TEXT NOT NULL,
    account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    model TEXT,
    effort TEXT,
    cadence TEXT NOT NULL,
    local_time TEXT NOT NULL,
    timezone TEXT NOT NULL,
    next_at INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX schedules_due ON schedules(enabled, next_at);
  CREATE TABLE schedule_occurrences (
    id TEXT PRIMARY KEY,
    schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL,
    scheduled_for INTEGER NOT NULL,
    task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
    tool TEXT,
    account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    model TEXT,
    effort TEXT,
    status TEXT NOT NULL,
    outcome TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(schedule_id, scheduled_for)
  );
  CREATE INDEX schedule_occurrences_schedule ON schedule_occurrences(schedule_id, created_at DESC);
  `,
  // v16: independent reviewer runs and their anchored findings, one current review per task.
  `
  CREATE TABLE task_reviews (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    reviewer_tool TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    summary TEXT,
    findings TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX task_reviews_session ON task_reviews(session_id);
  `,
];

export function getSetting<T>(key: string, fallback: T): T {
  const r = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  return r ? (JSON.parse(r.value) as T) : fallback;
}
export function setSetting(key: string, value: unknown) {
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
}

{
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (current < migrations.length) {
    // Table rebuilds must not fire ON DELETE actions; FK enforcement can only be toggled outside a transaction.
    db.exec("PRAGMA foreign_keys = OFF");
    for (let v = current; v < migrations.length; v++) {
      db.transaction(() => {
        db.exec(migrations[v]!);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      })();
    }
    db.exec("PRAGMA foreign_keys = ON");
  }
}

export const now = () => Date.now();

export function newId(prefix = ""): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return prefix + Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 10);
}
