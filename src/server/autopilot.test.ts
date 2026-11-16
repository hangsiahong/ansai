// Autopilot scheduling: which queued tasks start, in what order, and how many at once.
// A fake starter records starts instead of launching agents in tmux.
import { beforeEach, describe, expect, test } from "bun:test";

const { db, now } = await import("./db");
const { autopilotTick, setTaskStarter, updateSettings } = await import("./autopilot");
const { listTasks, updateTask } = await import("./tasks");

let started: string[] = [];
let failing = new Set<string>();
let n = 0;

// What runTask does, minus tmux: a running auto session, task in Doing, unqueued.
setTaskStarter((async (id: string) => {
  if (failing.has(id)) throw new Error("agent isn't installed");
  // runTask refuses a task that still has an agent open.
  if (db.query("SELECT 1 FROM sessions WHERE task_id = ? AND status = 'running'").get(id)) throw new Error("this task already has a running agent session");
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

  test("in a Git project, a session you're chatting with in the project folder doesn't hold queued tasks back", async () => {
    // Queued tasks in a Git repo get their own worktree, so only non-Git folders are serialized (t0v255m4a6z).
    const repo = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "ansai-ap-git-"));
    for (const args of [["init", "-q"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]])
      Bun.spawnSync(["git", "-C", repo, ...args]);
    db.query("INSERT INTO projects (id, name, path, created_at) VALUES ('pg', 'pg', ?, 0)").run(repo);
    task("hand", "pg", { status: "doing", queued: false });
    db.query(
      `INSERT INTO sessions (id, project_id, task_id, tool, title, cwd, argv, tmux_name, status, agent_state, created_at, auto)
       VALUES ('sh', 'pg', 'hand', 'claude', 'hand', ?, '[]', 'ansai-sh', 'running', 'working', 0, 0)`,
    ).run(repo);
    task("q", "pg");
    await autopilotTick();
    expect(started).toEqual(["q"]);
    task("q2", "p1"); // a non-Git folder with nothing running still starts too
    await autopilotTick();
    expect(started).toEqual(["q", "q2"]);
  });

  test("tasks with their own worktrees run side by side in one project", async () => {
    task("a", "p1", { worktree: true });
    task("b", "p1", { worktree: true });
    await autopilotTick();
    expect(started).toEqual(["a", "b"]);
  });

  test("queued tasks wait until every prerequisite is done", async () => {
    task("prerequisite-a", "p1", { worktree: true });
    task("prerequisite-b", "p2", { worktree: true });
    task("downstream", "p3", { worktree: true, priority: 3 });
    db.query("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ('downstream', 'prerequisite-a'), ('downstream', 'prerequisite-b')").run();
    await autopilotTick();
    expect(started).toEqual(["prerequisite-a", "prerequisite-b"]);
    db.query("UPDATE tasks SET status = 'done' WHERE id IN ('prerequisite-a', 'prerequisite-b')").run();
    await autopilotTick();
    expect(started).toEqual(["prerequisite-a", "prerequisite-b", "downstream"]);
  });

  test("dependencies are exposed as blocked-by state and cycles are rejected", () => {
    task("first", "p1", { queued: false });
    task("second", "p1", { queued: false });
    updateTask("second", { dependencies: ["first"] });
    expect(listTasks().find((t) => t.id === "second")?.blocked_by?.map((d) => d.title)).toEqual(["first"]);
    expect(() => updateTask("first", { dependencies: ["second"] })).toThrow("cycle");
    expect(() => updateTask("second", { dependencies: ["first", "first"] })).not.toThrow();
    expect(listTasks().find((t) => t.id === "second")?.dependencies).toHaveLength(1);
  });

  test("dependencies cannot cross projects", () => {
    task("same", "p1", { queued: false });
    task("other-project", "p2", { queued: false });
    expect(() => updateTask("same", { dependencies: ["other-project"] })).toThrow("same project");
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

describe("a queued task that still has an agent open", () => {
  const openAgent = (taskId: string, createdAt: number) =>
    db.query(
      `INSERT INTO sessions (id, project_id, task_id, tool, title, cwd, argv, tmux_name, status, agent_state, created_at, auto)
       VALUES (?, 'p1', ?, 'claude', 'old', '/tmp', '[]', ?, 'running', 'waiting', ?, 1)`,
    ).run(`old-${taskId}`, taskId, `ansai-old-${taskId}`, createdAt);
  const state = (id: string) => db.query("SELECT status, queued FROM tasks WHERE id = ?").get(id);

  test("an agent left open by an earlier run holds the task in the queue (it used to go to Doing with nobody on it)", async () => {
    task("a", "p1", { worktree: true });
    task("b", "p1", { worktree: true });
    openAgent("a", now() - 3600_000);
    db.query("UPDATE tasks SET updated_at = ? WHERE id = 'a'").run(now()); // sent back to To do and queued just now
    await autopilotTick();
    expect(state("a")).toEqual({ status: "todo", queued: 1 });
    expect(started).toEqual(["b"]); // and it doesn't hold a slot
    // closing the old agent lets the task start by itself
    db.query("UPDATE sessions SET status = 'closed' WHERE id = 'old-a'").run();
    await autopilotTick();
    expect(started).toEqual(["b", "a"]);
  });

  test("an agent started just before ansai restarted is this run: the task goes to Doing", async () => {
    task("a", "p1", { worktree: true });
    db.query("UPDATE tasks SET updated_at = ? WHERE id = 'a'").run(now() - 5000); // queued, then...
    openAgent("a", now() - 1000); // ...its agent started, and ansai went down before noting it
    await autopilotTick();
    expect(state("a")).toEqual({ status: "doing", queued: 0 });
    expect(started).toEqual([]);
  });
});
