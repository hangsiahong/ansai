// Autopilot scheduling: which queued tasks start, in what order, and how many at once.
// A fake starter records starts instead of launching agents in tmux.
import { beforeEach, describe, expect, test } from "bun:test";

const { db, now } = await import("./db");
const { autopilotTick, setTaskStarter, updateSettings } = await import("./autopilot");

let started: string[] = [];
let failing = new Set<string>();
let n = 0;

// What runTask does, minus tmux: a running auto session, task in Doing, unqueued.
setTaskStarter((async (id: string) => {
  if (failing.has(id)) throw new Error("agent isn't installed");
  started.push(id);
  const sid = `s${++n}`;
  db.query(
    `INSERT INTO sessions (id, project_id, task_id, tool, title, cwd, argv, tmux_name, status, agent_state, created_at, auto)
     SELECT ?, project_id, id, 'claude', title, '/tmp', '[]', ?, 'running', 'working', ?, 1 FROM tasks WHERE id = ?`,
  ).run(sid, `ansai-${sid}`, now(), id);
  db.query("UPDATE tasks SET status = 'doing', queued = 0 WHERE id = ?").run(id);
  return {} as never;
}) as never);

let created = 0;
function task(id: string, project: string, o: { priority?: number; queued?: boolean; status?: string; worktree?: boolean } = {}) {
  db.query(
    `INSERT INTO tasks (id, project_id, title, status, priority, queued, created_at, updated_at, worktree_path, worktree_branch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, project, id, o.status ?? "todo", o.priority ?? 0, o.queued === false ? 0 : 1, ++created, 0, o.worktree ? `/tmp/wt/${id}` : null, o.worktree ? `ansai/${id}` : null);
}
const finish = (id: string) => {
  db.query("UPDATE tasks SET status = 'review', summary = 'done' WHERE id = ?").run(id);
  db.query("UPDATE sessions SET status = 'exited' WHERE task_id = ?").run(id);
};

beforeEach(() => {
  db.exec("DELETE FROM sessions; DELETE FROM tasks; DELETE FROM projects;");
  for (const p of ["p1", "p2", "p3"]) db.query("INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, 0)").run(p, p, `/tmp/${p}`);
  started = [];
  failing = new Set();
  updateSettings({ autopilotMax: 2 });
});

describe("autopilot", () => {
  test("starts up to the limit, highest priority first, then oldest", async () => {
    task("old", "p1");
    task("urgent", "p2", { priority: 3 });
    task("newer", "p3");
    await autopilotTick();
    expect(started).toEqual(["urgent", "old"]);
    await autopilotTick();
    expect(started).toEqual(["urgent", "old"]); // full
    finish("old");
    await autopilotTick();
    expect(started).toEqual(["urgent", "old", "newer"]);
  });

  test("tasks sharing a project folder (no worktree) run one at a time", async () => {
    task("a", "p1");
    task("b", "p1");
    await autopilotTick();
    expect(started).toEqual(["a"]);
    finish("a");
    await autopilotTick();
    expect(started).toEqual(["a", "b"]);
  });

  test("tasks with their own worktrees run side by side in one project", async () => {
    task("a", "p1", { worktree: true });
    task("b", "p1", { worktree: true });
    await autopilotTick();
    expect(started).toEqual(["a", "b"]);
  });

  test("an agent that stopped to ask you still holds its slot", async () => {
    task("asking", "p1");
    task("x", "p2");
    task("y", "p3");
    await autopilotTick();
    // "asking" stops mid-task with a question: review, but no finish_task summary yet.
    db.query("UPDATE tasks SET status = 'review' WHERE id = 'asking'").run();
    await autopilotTick();
    expect(started).toEqual(["asking", "x"]);
  });

  test("only queued To-do tasks in a project start", async () => {
    task("not-queued", "p1", { queued: false });
    task("doing", "p2", { status: "doing" });
    db.query("INSERT INTO tasks (id, project_id, title, status, queued, created_at, updated_at) VALUES ('inbox', NULL, 'inbox', 'todo', 1, 0, 0)").run();
    await autopilotTick();
    expect(started).toEqual([]);
  });

  test("a task that fails to start is unqueued instead of retried forever", async () => {
    failing.add("broken");
    task("broken", "p1", { priority: 2 });
    task("fine", "p2");
    await autopilotTick();
    expect(started).toEqual(["fine"]);
    expect((db.query("SELECT queued FROM tasks WHERE id = 'broken'").get() as { queued: number }).queued).toBe(0);
  });

  test("the limit is a setting (1 to 6)", async () => {
    updateSettings({ autopilotMax: 1 });
    task("a", "p1");
    task("b", "p2");
    await autopilotTick();
    expect(started).toEqual(["a"]);
  });
});
