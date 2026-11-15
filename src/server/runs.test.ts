// Bounds for autopilot runs: tokens spent so far, read from the agent's log, and the
// per-project time limit that stops a run and hands its task back for review.
import { beforeEach, describe, expect, test } from "bun:test";

const { db, now } = await import("./db");
const { addUsage, newScan, runDeadline } = await import("./runs");
const { enforceRunLimits } = await import("./limits");
const { setViewer } = await import("./viewers");

describe("tokens so far", () => {
  test("Claude: each API message counts once, cache reads apart", () => {
    const sc = newScan("/x.jsonl");
    const msg = (id: string) =>
      JSON.stringify({ type: "assistant", message: { id, usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 50_000, output_tokens: 200 } } });
    // Streaming writes one message as a line per content block, each with the same usage.
    for (const line of [msg("m1"), msg("m1"), msg("m2"), JSON.stringify({ type: "user", message: { content: "hi" } })]) addUsage(sc, "claude", line);
    expect(sc.tokens).toEqual({ fresh: 2 * 1210, cached: 100_000 });
  });

  test("Codex: its running total, with cached input taken out of input", () => {
    const sc = newScan("/r.jsonl");
    const count = (input: number, cached: number, output: number) =>
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } });
    addUsage(sc, "codex", count(5000, 3000, 400));
    addUsage(sc, "codex", count(12_000, 9000, 900));
    expect(sc.tokens).toEqual({ fresh: 3000 + 900, cached: 9000 });
  });
});

// ---------------------------------------------------------------- time limit

let n = 0;
function project(maxMinutes: number | null) {
  db.query("UPDATE projects SET autopilot = ? WHERE id = 'px'").run(JSON.stringify({ on: true, tool: "claude", accountId: null, yolo: false, maxMinutes }));
}
function run(minutesAgo: number, o: { auto?: boolean; taskStatus?: string } = {}) {
  const sid = `r${++n}`;
  const tid = `t${n}`;
  db.query("INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) VALUES (?, 'px', 'T', ?, 0, 0)").run(tid, o.taskStatus ?? "doing");
  db.query(
    `INSERT INTO sessions (id, project_id, task_id, tool, title, cwd, argv, tmux_name, status, agent_state, created_at, auto)
     VALUES (?, 'px', ?, 'claude', 'T', '/tmp', '[]', ?, 'running', 'working', ?, ?)`,
  ).run(sid, tid, `ansai-${sid}`, now() - minutesAgo * 60_000, o.auto === false ? 0 : 1);
  return { sid, tid };
}
const session = (id: string) => db.query("SELECT * FROM sessions WHERE id = ?").get(id) as any;
const task = (id: string) => db.query("SELECT status, queued, last_failure, summary FROM tasks WHERE id = ?").get(id) as any;

beforeEach(() => {
  db.exec("DELETE FROM sessions; DELETE FROM tasks; DELETE FROM projects;");
  db.query("INSERT INTO projects (id, name, path, created_at) VALUES ('px', 'px', '/tmp/px', 0)").run();
});

describe("runDeadline", () => {
  test("an autopilot run in Doing gets its project's limit", () => {
    project(30);
    const { sid } = run(10);
    expect(runDeadline(session(sid))).toBe(session(sid).created_at + 30 * 60_000);
  });

  test("none without a limit, for runs you started, or once the task left Doing", () => {
    project(null);
    expect(runDeadline(session(run(10).sid))).toBeNull();
    project(30);
    expect(runDeadline(session(run(10, { auto: false }).sid))).toBeNull();
    expect(runDeadline(session(run(10, { taskStatus: "review" }).sid))).toBeNull();
  });
});

describe("enforceRunLimits", () => {
  test("a run past its limit stops: task to Review with the reason, and the session is no longer autopilot's", async () => {
    project(15);
    const late = run(20);
    await enforceRunLimits();
    expect(task(late.tid)).toMatchObject({ status: "review", queued: 0, last_failure: "hit the 15-minute time limit for autopilot runs" });
    expect(task(late.tid).summary).toContain("Autopilot stopped this run");
    expect(session(late.sid).auto).toBe(0);
  }, 15_000);

  test("a run inside its limit keeps going", async () => {
    project(15);
    const early = run(5);
    await enforceRunLimits();
    expect(task(early.tid).status).toBe("doing");
    expect(session(early.sid).auto).toBe(1);
  });

  test("a run you're looking at isn't cut off", async () => {
    project(15);
    const watched = run(20);
    const conn = {};
    setViewer(watched.sid, conn, true);
    await enforceRunLimits();
    expect(task(watched.tid).status).toBe("doing");
    setViewer(watched.sid, conn, false);
  });
});

const { sampleBusy } = await import("./limits");
describe("sampleBusy", () => {
  const screens = (...list: string[]) => {
    let i = 0;
    return async () => list[Math.min(i++, list.length - 1)]!;
  };
  test("busy when any look shows the footer, even if the first catches a gap between requests", async () => {
    expect(await sampleBusy(screens("❯ ", "❯ ", "⏵⏵ auto mode on · esc to interrupt"), 5, 1)).toBe(true);
  });
  test("idle only when every look is quiet", async () => {
    expect(await sampleBusy(screens("❯ "), 5, 1)).toBe(false);
  });
});
