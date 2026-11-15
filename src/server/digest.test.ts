// "While you were away": which tasks, shifts and messages count as new since you last looked.
import { beforeEach, expect, test } from "bun:test";

const { db, now } = await import("./db");
const { digest, markSeen, seenAt } = await import("./digest");

beforeEach(() => {
  db.exec("DELETE FROM shifts; DELETE FROM messages; DELETE FROM sessions; DELETE FROM tasks;");
  db.query("INSERT OR IGNORE INTO projects (id, name, path, created_at) VALUES ('dp', 'dp', '/tmp/digest-dp-none', 0)").run();
});

function task(id: string, o: { status: string; at: number; source?: string; created?: number }) {
  db.query(
    `INSERT INTO tasks (id, project_id, title, status, source, created_at, updated_at, done_at) VALUES (?, 'dp', ?, ?, ?, ?, ?, ?)`,
  ).run(id, id, o.status, o.source ?? "you", o.created ?? 0, o.at, o.status === "done" ? o.at : null);
}

test("finished = reached Review or Done since then; filed = agent tasks created since then", async () => {
  const since = now() - 60_000;
  task("old-review", { status: "review", at: since - 1000 });
  task("new-review", { status: "review", at: since + 1000 });
  task("new-done", { status: "done", at: since + 2000 });
  task("still-doing", { status: "doing", at: since + 3000 });
  task("agent-new", { status: "todo", at: since + 4000, source: "agent", created: since + 4000 });
  task("agent-old", { status: "todo", at: since + 4000, source: "agent", created: since - 4000 });
  task("mine-new", { status: "todo", at: since + 4000, created: since + 4000 });
  const d = await digest(since);
  expect(d.finished).toEqual(["new-done", "new-review"]);
  expect(d.filed).toEqual(["agent-new"]);
  expect(d.projects).toEqual([]); // no agent sessions, and the path isn't a repo
});

test("ended shifts and team messages since then are counted", async () => {
  const since = now() - 60_000;
  db.query(
    `INSERT INTO sessions (id, project_id, tool, title, cwd, argv, tmux_name, status, created_at) VALUES ('s1', 'dp', 'claude', 'Night run', '/tmp', '[]', 'ansai-s1', 'running', ?)`,
  ).run(since);
  db.query(`INSERT INTO shifts (session_id, until, started_at, ended_at, end_reason, nudges) VALUES ('s1', ?, ?, ?, 'idle', 7)`).run(now(), since, now());
  db.query(`INSERT INTO messages (project_id, from_label, body, created_at) VALUES ('dp', 'you', 'hi', ?)`).run(now());
  db.query(`INSERT INTO messages (project_id, from_label, body, created_at) VALUES ('dp', 'you', 'old', ?)`).run(since - 1);
  const d = await digest(since);
  expect(d.shifts.map((s) => [s.title, s.end_reason, s.nudges])).toEqual([["Night run", "idle", 7]]);
  expect(d.messages).toBe(1);
});

test("clearing moves the mark to now, for every device", () => {
  markSeen(12345);
  expect(seenAt()).toBe(12345);
  markSeen();
  expect(Math.abs(seenAt() - now())).toBeLessThan(1000);
});
