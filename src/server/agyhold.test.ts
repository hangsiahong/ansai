// While agy is signed out, autopilot holds agy tasks in the queue (instead of starting an
// agent that sits on agy's sign-in menu), and "Run now" refuses with the reason.
// The sign-in state is seeded, so the real `agy` is never run; a fake starter records starts.
import { beforeEach, expect, test } from "bun:test";

const { db } = await import("./db");
const { autopilotTick, setProjectAutopilot, setTaskStarter } = await import("./autopilot");
const { runTask, taskPrompt, getTask, AGY_SIGNED_OUT } = await import("./tasks");
const { noteAgySignedOut } = await import("./agyauth");

let started: string[] = [];
setTaskStarter((async (id: string) => {
  started.push(id);
  return {} as never;
}) as never);

beforeEach(() => {
  db.exec("DELETE FROM sessions; DELETE FROM tasks; DELETE FROM projects; DELETE FROM accounts WHERE tool = 'agy';");
  db.query("INSERT INTO projects (id, name, path, created_at) VALUES ('p1', 'p1', '/tmp/p1', 0)").run();
  db.query("INSERT INTO tasks (id, project_id, title, status, queued, created_at, updated_at) VALUES ('t1', 'p1', 'T', 'todo', 1, 0, 0)").run();
  started = [];
  noteAgySignedOut(""); // no agy accounts: the default login's key
});

test("autopilot keeps an agy task queued while agy is signed out", async () => {
  setProjectAutopilot("p1", { on: true, tool: "agy" });
  await autopilotTick();
  expect(started).toEqual([]);
  expect(db.query("SELECT status, queued FROM tasks WHERE id = 't1'").get()).toEqual({ status: "todo", queued: 1 });
});

test("other agents still start", async () => {
  setProjectAutopilot("p1", { on: true, tool: "claude" });
  await autopilotTick();
  expect(started).toEqual(["t1"]);
});

test("running an agy task by hand says why it can't start", async () => {
  await expect(runTask("t1", { tool: "agy" })).rejects.toThrow(AGY_SIGNED_OUT);
});

// agy can't call finish_task, so a task of its in Review never gets a summary. That used
// to read as "stopped to ask you something" and hold its place in the queue for good.
function finishedRun(tool: string) {
  db.query("INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) VALUES ('t0', 'p1', 'Earlier', 'review', 0, 0)").run();
  db.query(
    `INSERT INTO sessions (id, project_id, task_id, tool, title, cwd, argv, tmux_name, status, agent_state, created_at, auto, msg_cursor)
     VALUES ('s0', 'p1', 't0', ?, 'Earlier', '/tmp/p1', '[]', 'ansai-s0', 'running', 'waiting', 0, 1, 0)`,
  ).run(tool);
  setProjectAutopilot("p1", { on: true, tool: "claude" });
}

test("an agy run whose turn ended doesn't hold up the queue", async () => {
  finishedRun("agy");
  await autopilotTick();
  expect(started).toEqual(["t1"]);
});

test("a Claude run that stopped without finishing still does", async () => {
  finishedRun("claude");
  await autopilotTick();
  expect(started).toEqual([]);
});

// Told to call finish_task, agy spent minutes searching the laptop for a tool it doesn't have.
test("agy's task prompt doesn't send it looking for ansai's tools", () => {
  const t = getTask("t1")!;
  expect(taskPrompt(t)).toContain("finish_task");
  const forAgy = taskPrompt(t, false);
  expect(forAgy).not.toMatch(/finish_task|add_task|ansai/);
  expect(forAgy).toContain("Backlog task: T");
  expect(forAgy).toContain("how to verify it");
});
