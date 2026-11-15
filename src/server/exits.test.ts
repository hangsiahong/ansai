// What happens to a task when its agent's session ends: autopilot retries crashes once,
// and never retries something you stopped, a clean exit, or an agent waiting on a question.
import { beforeEach, describe, expect, test } from "bun:test";

const { db, now } = await import("./db");
const { onExited, AUTO_RETRIES } = await import("./hooks");
const { finishTask } = await import("./tasks");

let n = 0;
function run(task: string, o: { auto?: boolean; status?: string; attempts?: number } = {}) {
  db.query(
    `INSERT INTO tasks (id, project_id, title, status, attempts, created_at, updated_at) VALUES (?, 'px', 'T', ?, ?, 0, 0)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status`,
  ).run(task, o.status ?? "doing", o.attempts ?? 0);
  const sid = `x${++n}`;
  db.query(
    `INSERT INTO sessions (id, project_id, task_id, tool, title, cwd, argv, tmux_name, status, agent_state, created_at, auto)
     VALUES (?, 'px', ?, 'claude', 'T', '/tmp', '[]', ?, 'running', 'working', ?, ?)`,
  ).run(sid, task, `ansai-${sid}`, now(), o.auto === false ? 0 : 1);
  return sid;
}
/** Like the reconciler: mark the session ended, then report it. */
function end(sid: string, code: number | null, how: "closed" | "vanished" | "exited") {
  db.query("UPDATE sessions SET status = ? WHERE id = ?").run(how === "closed" ? "closed" : "exited", sid);
  onExited(sid, code, how);
}
const task = (id: string) => db.query("SELECT status, queued, attempts, last_failure, summary FROM tasks WHERE id = ?").get(id) as {
  status: string;
  queued: number;
  attempts: number;
  last_failure: string | null;
  summary: string | null;
};

beforeEach(() => {
  db.exec("DELETE FROM sessions; DELETE FROM tasks; DELETE FROM projects;");
  db.query("INSERT INTO projects (id, name, path, created_at) VALUES ('px', 'px', '/tmp/px', 0)").run();
});

describe("autopilot runs that die mid-task", () => {
  test(`a crash is re-queued ${AUTO_RETRIES} time(s) with the reason, then waits in Review`, () => {
    end(run("t1"), 1, "exited");
    expect(task("t1")).toMatchObject({ status: "todo", queued: 1, attempts: 1, last_failure: "the agent exited with code 1" });
    expect(task("t1").summary).toContain("stopped before finishing");
    db.query("UPDATE tasks SET status = 'doing', queued = 0 WHERE id = 't1'").run(); // autopilot started it again
    end(run("t1"), null, "vanished");
    expect(task("t1")).toMatchObject({ status: "review", queued: 0, attempts: 1 });
    expect(task("t1").last_failure).toContain("terminal disappeared");
  });

  test("a vanished terminal (reboot) counts as a failure", () => {
    end(run("t2"), null, "vanished");
    expect(task("t2")).toMatchObject({ status: "todo", queued: 1 });
  });
});

describe("never retried", () => {
  test("you closed the session", () => {
    end(run("t3"), null, "closed");
    expect(task("t3")).toMatchObject({ status: "review", queued: 0, last_failure: null });
  });
  test("a clean exit (code 0)", () => {
    end(run("t4"), 0, "exited");
    expect(task("t4")).toMatchObject({ status: "review", queued: 0, last_failure: null });
  });
  test("a run you started yourself (not autopilot): Review, with the reason", () => {
    end(run("t5", { auto: false }), 137, "exited");
    expect(task("t5")).toMatchObject({ status: "review", queued: 0, last_failure: "the agent exited with code 137" });
  });
  test("an agent that stopped to ask you something (task already in Review)", () => {
    end(run("t6", { status: "review" }), 1, "exited");
    expect(task("t6")).toMatchObject({ status: "review", queued: 0, attempts: 0 });
  });
});

test("finishing a task resets its retry count", () => {
  run("t7", { attempts: 1 });
  db.query("UPDATE tasks SET last_failure = 'x' WHERE id = 't7'").run();
  finishTask("t7", "done");
  expect(task("t7")).toMatchObject({ attempts: 0, last_failure: null, status: "review" });
});
