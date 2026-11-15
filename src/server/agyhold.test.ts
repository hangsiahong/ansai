// While agy is signed out, autopilot holds agy tasks in the queue (instead of starting an
// agent that sits on agy's sign-in menu), and "Run now" refuses with the reason.
// The sign-in state is seeded, so the real `agy` is never run; a fake starter records starts.
import { beforeEach, expect, test } from "bun:test";

const { db } = await import("./db");
const { autopilotTick, setProjectAutopilot, setTaskStarter } = await import("./autopilot");
const { runTask, AGY_SIGNED_OUT } = await import("./tasks");
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
