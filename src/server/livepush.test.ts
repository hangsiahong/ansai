// What the UI's live stream (/ws/events) carries, and when: it goes to a phone on every change, so its size matters.
import { beforeEach, describe, expect, test } from "bun:test";

const { db, now } = await import("./db");
const { applyPanes, getSession, listActivity, listSessions, parsePanes, sessionView } = await import("./sessions");
const { DONE_PREVIEW, listTasks, taskText } = await import("./tasks");
const { emit, onChange } = await import("./events");
type Topic = Parameters<typeof emit>[0];

function makeTask(id: string, status: string, body: string, summary: string | null = null) {
  db.query(`INSERT INTO tasks (id, project_id, title, body, status, summary, created_at, updated_at, done_at) VALUES (?, 'p1', ?, ?, ?, ?, ?, ?, ?)`).run(
    id, `Task ${id}`, body, status, summary, now(), now(), status === "done" ? now() : null,
  );
}

function makeSession(id: string, taskId: string | null, agentState = "working") {
  db.query(
    `INSERT INTO sessions (id, project_id, task_id, tool, title, cwd, argv, tmux_name, status, agent_state, created_at)
     VALUES (?, 'p1', ?, 'claude', ?, '/tmp', ?, ?, 'running', ?, ?)`,
  ).run(id, taskId, `Session ${id}`, JSON.stringify(["claude", "--append-system-prompt", "x".repeat(5000)]), `ansai-${id}`, agentState, now());
  return getSession(id)!;
}

const pane = (name: string, activity: number) => [name, 0, "", "claude", activity, 0].join("\t");

/** The topics pushed while `fn` runs (emit delivers them on the next microtask). */
async function pushed(fn: () => void): Promise<Topic[]> {
  const seen: Topic[] = [];
  const off = onChange((t) => seen.push(t));
  fn();
  await Promise.resolve();
  await Promise.resolve();
  off();
  return seen.sort();
}

beforeEach(() => {
  db.exec("DELETE FROM sessions; DELETE FROM tasks;");
  db.query("INSERT INTO projects (id, name, path, created_at) VALUES ('p1', 'p1', '/tmp/p1', 0) ON CONFLICT(id) DO NOTHING").run();
});

describe("tasks in the live list", () => {
  test("a done task's long body and summary are cut, and taskText has them whole", () => {
    const body = "b".repeat(DONE_PREVIEW * 5);
    const summary = "s".repeat(DONE_PREVIEW * 3);
    makeTask("t_done", "done", body, summary);
    makeTask("t_open", "todo", body, summary);
    makeTask("t_short", "done", "short", "also short");
    const byId = new Map(listTasks().map((t) => [t.id, t]));

    expect(byId.get("t_done")).toMatchObject({ body: body.slice(0, DONE_PREVIEW), summary: summary.slice(0, DONE_PREVIEW), cut: true });
    expect(taskText("t_done")).toEqual({ body, summary });
    expect(byId.get("t_open")).toMatchObject({ body, summary });
    expect(byId.get("t_open")!.cut).toBeUndefined();
    expect(byId.get("t_short")).toMatchObject({ body: "short", summary: "also short" });
    expect(byId.get("t_short")!.cut).toBeUndefined();
    expect(taskText("nope")).toBeNull();
  });
});

describe("sessions in the live list", () => {
  test("lists leave out argv (the launch prompt); a single session still has it", () => {
    const s = makeSession("s_argv", null);
    const listed = listSessions().find((x) => x.id === s.id)!;
    expect("argv" in listed).toBe(false);
    expect(sessionView(s).argv).toEqual(["claude", "--append-system-prompt", "x".repeat(5000)]);
  });

  test("output alone pushes the small activity message, not the session or task lists", async () => {
    makeTask("t1", "doing", "");
    const s = makeSession("s_act", "t1");
    await pushed(() => applyPanes(parsePanes(pane(s.tmux_name, 1_763_250_000))));

    expect(await pushed(() => applyPanes(parsePanes(pane(s.tmux_name, 1_763_250_030))))).toEqual(["activity"]);
    expect(listActivity()).toEqual([{ id: s.id, activity_at: 1_763_250_030_000, current_command: "claude", clients: 0, tokens: null }]);
    expect(await pushed(() => applyPanes(parsePanes(pane(s.tmux_name, 1_763_250_030))))).toEqual([]);
  });

  test("an agent going idle resends the sessions, not every task", async () => {
    makeTask("t2", "doing", "");
    const s = makeSession("s_idle", "t2");
    await pushed(() => applyPanes(parsePanes(pane(s.tmux_name, 1_763_250_000))));

    db.query("UPDATE sessions SET agent_state = 'waiting' WHERE id = ?").run(s.id);
    expect(await pushed(() => applyPanes(parsePanes(pane(s.tmux_name, 1_763_250_000))))).toEqual(["sessions"]);
  });

  test("a task's agent closing still resends the tasks", async () => {
    makeTask("t3", "doing", "");
    const s = makeSession("s_close", "t3");
    await pushed(() => applyPanes(parsePanes(pane(s.tmux_name, 1_763_250_000))));

    db.query("UPDATE sessions SET status = 'closed' WHERE id = ?").run(s.id);
    expect(await pushed(() => applyPanes(parsePanes(pane(s.tmux_name, 1_763_250_000))))).toEqual(["sessions", "tasks"]);
  });

  test("a full sessions push in the same moment makes the activity one redundant", async () => {
    expect(await pushed(() => (emit("activity"), emit("sessions")))).toEqual(["sessions"]);
  });
});
