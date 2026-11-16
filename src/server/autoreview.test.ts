// Automatic independent review: what gets queued at finish_task, who reviews, what goes back
// to the implementer, and the reviewers that get stuck. Fakes stand in for launching agents.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

const { db, now, setSetting } = await import("./db");
const { mcpHttp } = await import("./mcp");
const ar = await import("./autoreview");
const { closeFinishedAgents, CLOSE_AFTER_MS } = await import("./autopilot");
const { listTasks } = await import("./tasks");
const { describeHistory } = await import("./team");
const { getSession } = await import("./sessions");
import type { ReviewStart } from "./tasks";

type Started = { task: string; tool: string; o: ReviewStart };
let started: Started[] = [];
let installed = new Set(["claude", "codex"]);
let closed: string[] = [];
let n = 0;

/** What startTaskReview does once its session exists (onCreated), minus tmux. */
function reviewer(taskId: string, tool: string, round: number, at = now()) {
  const sid = `rev${++n}`;
  db.query(
    `INSERT INTO sessions (id, project_id, task_id, tool, title, cwd, argv, tmux_name, status, agent_state, created_at, msg_cursor)
     SELECT ?, project_id, id, ?, 'Review · ' || title, '/tmp', '[]', ?, 'running', 'working', ?, (SELECT COALESCE(MAX(id), 0) FROM messages) FROM tasks WHERE id = ?`,
  ).run(sid, tool, `ansai-${sid}`, at, taskId);
  db.query(
    `INSERT INTO task_reviews (task_id, session_id, reviewer_tool, status, findings, updated_at, round, sent_back) VALUES (?, ?, ?, 'running', '[]', ?, ?, 0)
     ON CONFLICT(task_id) DO UPDATE SET session_id=excluded.session_id, reviewer_tool=excluded.reviewer_tool, status='running', summary=NULL, findings='[]', updated_at=excluded.updated_at, round=excluded.round, sent_back=0`,
  ).run(taskId, sid, tool, at, round);
  return sid;
}

ar.setReviewDeps({
  start: async (task, tool, o) => {
    started.push({ task, tool, o });
    reviewer(task, tool, o.round ?? 0);
  },
  installed: (tool) => installed.has(tool),
  close: async (id) => {
    closed.push(id);
    db.query("UPDATE sessions SET status = 'closed' WHERE id = ?").run(id);
  },
});
afterAll(() => ar.setReviewDeps(null));

function project(id: string, autopilot?: object) {
  db.query("INSERT OR REPLACE INTO projects (id, name, path, created_at, autopilot) VALUES (?, ?, ?, 0, ?)").run(id, id, `/tmp/${id}`, autopilot ? JSON.stringify(autopilot) : null);
}
function task(id: string, o: { project?: string; worktree?: boolean; status?: string } = {}) {
  db.query(
    `INSERT INTO tasks (id, project_id, title, status, created_at, updated_at, worktree_path, worktree_branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, o.project ?? "ap", `Task ${id}`, o.status ?? "doing", now(), now(), o.worktree === false ? null : `/tmp/wt/${id}`, `ansai/${id}`);
}
/** The implementer: an autopilot agent (auto) unless said otherwise. Working, so messages aren't typed in over tmux. */
function implementer(id: string, taskId: string, o: { tool?: string; auto?: boolean; state?: string; createdAt?: number; stateAt?: number; account?: string | null } = {}) {
  db.query(
    `INSERT INTO sessions (id, project_id, task_id, account_id, tool, title, cwd, argv, tmux_name, status, agent_state, agent_state_at, created_at, msg_cursor, auto)
     SELECT ?, project_id, id, ?, ?, title, '/tmp', '[]', ?, 'running', ?, ?, ?, (SELECT COALESCE(MAX(id), 0) FROM messages), ? FROM tasks WHERE id = ?`,
  ).run(id, o.account ?? null, o.tool ?? "claude", `ansai-${id}`, o.state ?? "working", o.stateAt ?? now(), o.createdAt ?? now(), o.auto === false ? 0 : 1, taskId);
}

async function call(session: string, name: string, args: object) {
  const res = await mcpHttp(
    new Request(`http://127.0.0.1/mcp?s=${session}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  return ((await res.json()) as { result: { content: { text: string }[]; isError: boolean } }).result;
}
const row = (id: string) => db.query("SELECT status, summary, auto_review FROM tasks WHERE id = ?").get(id) as { status: string; summary: string | null; auto_review: number };
const reviewerOf = (taskId: string) => (db.query("SELECT session_id AS s FROM task_reviews WHERE task_id = ?").get(taskId) as { s: string }).s;
const review = (id: string) => listTasks().find((t) => t.id === id)!.review!;
const messagesTo = (sid: string) => db.query("SELECT from_label, body FROM messages WHERE to_session = ? ORDER BY id").all(sid) as { from_label: string; body: string }[];
const findings = (taskId: string, list: { severity: string; file?: string; message?: string }[]) =>
  db.query("UPDATE task_reviews SET findings = ? WHERE task_id = ?").run(JSON.stringify(list.map((f, i) => ({ file: f.file ?? "src/a.ts", line: i + 1, severity: f.severity, message: f.message ?? `problem ${i}` }))), taskId);

beforeEach(() => {
  db.exec("DELETE FROM messages; DELETE FROM task_reviews; DELETE FROM sessions; DELETE FROM tasks; DELETE FROM settings WHERE key LIKE 'run-hold:%';");
  project("ap");
  for (const tool of ["claude", "codex"]) db.query("INSERT OR IGNORE INTO accounts (id, tool, name, is_default, created_at) VALUES (?, ?, 'Default login', 1, 0)").run(`${tool}-default`, tool);
  started = [];
  closed = [];
  installed = new Set(["claude", "codex"]);
});

describe("queueing at finish_task", () => {
  test("an autopilot agent's finished task is queued for review, and the agent is told", async () => {
    task("t1");
    implementer("impl", "t1");
    const r = await call("impl", "finish_task", { summary: "Added the thing." });
    expect(r.isError).toBe(false);
    expect(r.content[0]!.text).toContain("independent reviewer");
    expect(row("t1")).toMatchObject({ status: "review", auto_review: 1 });
  });

  test("not for a session you started, a task without a worktree, or a project that turned it off", async () => {
    task("mine");
    implementer("s-mine", "mine", { auto: false });
    task("nowt", { worktree: false });
    implementer("s-nowt", "nowt");
    project("off", { on: true, tool: "claude", accountId: null, yolo: false, review: false });
    task("off", { project: "off" });
    implementer("s-off", "off");
    for (const [s, t] of [["s-mine", "mine"], ["s-nowt", "nowt"], ["s-off", "off"]] as const) {
      const r = await call(s, "finish_task", { summary: "done" });
      expect(r.content[0]!.text).not.toContain("reviewer");
      expect(row(t)).toMatchObject({ status: "review", auto_review: 0 });
    }
  });

  test("round 2 after the findings went back; nothing after round 2; a new run starts at round 1 again", async () => {
    task("t2");
    implementer("impl", "t2", { createdAt: now() - 60_000 });
    await call("impl", "finish_task", { summary: "first" });
    await ar.reviewTick();
    findings("t2", [{ severity: "high" }]);
    await call(reviewerOf("t2"), "finish_review", { summary: "one bug" });
    expect(review("t2")).toMatchObject({ round: 1, sent_back: true });

    db.query("UPDATE tasks SET status = 'doing' WHERE id = 't2'").run(); // the message woke it
    const again = await call("impl", "finish_task", { summary: "Fixed the bug." });
    expect(again.content[0]!.text).toContain("second review");
    expect(row("t2").auto_review).toBe(2);
    await ar.reviewTick();
    expect(started[1]).toMatchObject({ task: "t2", o: { round: 2, previous: { fix: "Fixed the bug.", findings: [{ severity: "high", file: "src/a.ts" }] } } });

    await call(reviewerOf("t2"), "finish_review", { summary: "fixed" });
    await call("impl", "finish_task", { summary: "and again" });
    expect(row("t2").auto_review).toBe(0);

    // You ran the task again: a new agent, a new first review.
    db.query("UPDATE sessions SET status = 'closed' WHERE id = 'impl'").run();
    implementer("impl2", "t2", { createdAt: now() + 1000 });
    await call("impl2", "finish_task", { summary: "redo" });
    expect(row("t2").auto_review).toBe(1);
  });
});

describe("starting reviews", () => {
  const queued = (id: string, o: { tool?: string; account?: string | null } = {}) => {
    task(id, { status: "review" });
    implementer(`impl-${id}`, id, { tool: o.tool, account: o.account });
    db.query("UPDATE tasks SET summary = 'done', auto_review = 1 WHERE id = ?").run(id);
  };

  test("the other agent reviews, two at a time, oldest first", async () => {
    queued("a", { tool: "claude" });
    queued("b", { tool: "codex" });
    queued("c");
    await ar.reviewTick();
    expect(started.map((s) => [s.task, s.tool])).toEqual([["a", "codex"], ["b", "claude"]]);
    expect(row("a").auto_review).toBe(0);
    expect(row("c").auto_review).toBe(1);
    expect(review("a")).toMatchObject({ status: "running", round: 1, reviewer_tool: "codex" });
    await ar.reviewTick();
    expect(started).toHaveLength(2); // full
    db.query("UPDATE sessions SET status = 'closed' WHERE id = (SELECT session_id FROM task_reviews WHERE task_id = 'a')").run();
    await ar.reviewTick();
    expect(started.map((s) => s.task)).toEqual(["a", "b", "c"]);
  });

  test("falls back to the implementer's agent when the other isn't installed or is at its limit; waits when neither can run", async () => {
    queued("x", { tool: "claude" });
    installed.delete("codex");
    await ar.reviewTick();
    expect(started[0]).toMatchObject({ task: "x", tool: "claude" });

    queued("y", { tool: "claude" });
    installed.add("codex");
    const hold = (account: string) => setSetting(`run-hold:held-${account}`, { account, kind: "limit", at: now(), until: now() + 3600_000, known: true, resume: false, tries: 0 });
    hold("codex-default");
    await ar.reviewTick();
    expect(started[1]).toMatchObject({ task: "y", tool: "claude", o: { accountId: "claude-default" } });

    queued("z", { tool: "claude" });
    hold("claude-default");
    await ar.reviewTick();
    expect(started).toHaveLength(2);
    expect(row("z").auto_review).toBe(1); // still queued for when one is free
  });

  test("a queued review is dropped when the task moved on", async () => {
    queued("m");
    db.query("UPDATE tasks SET status = 'done' WHERE id = 'm'").run();
    queued("d");
    db.query("UPDATE tasks SET status = 'doing' WHERE id = 'd'").run();
    await ar.reviewTick();
    expect(started).toHaveLength(0);
    expect([row("m").auto_review, row("d").auto_review]).toEqual([0, 0]);
  });

  test("a review that can't start isn't retried forever", async () => {
    queued("f");
    ar.setReviewDeps({ start: async () => { throw new Error("codex is not installed"); }, installed: () => true, close: async () => {} });
    await ar.reviewTick();
    expect(row("f").auto_review).toBe(0);
    ar.setReviewDeps({
      start: async (task, tool, o) => { started.push({ task, tool, o }); reviewer(task, tool, o.round ?? 0); },
      installed: (tool) => installed.has(tool),
      close: async (id) => { closed.push(id); db.query("UPDATE sessions SET status = 'closed' WHERE id = ?").run(id); },
    });
  });
});

describe("sending findings back", () => {
  function reviewed(id: string, list: { severity: string; message?: string }[], o: { round?: number; implState?: string } = {}) {
    task(id, { status: "review" });
    implementer(`impl-${id}`, id, { tool: "claude" });
    db.query("UPDATE tasks SET summary = 'done' WHERE id = ?").run(id);
    const sid = reviewer(id, "codex", o.round ?? 1);
    findings(id, list);
    return sid;
  }

  test("high findings go to the implementer once, with the rest as its judgment", async () => {
    const sid = reviewed("h", [{ severity: "high", message: "Null input crashes the parser." }, { severity: "low", message: "Name is vague." }]);
    const r = await call(sid, "finish_review", { summary: "one crash" });
    expect(r.content[0]!.text).toContain("went to the agent");
    const [m, ...more] = messagesTo("impl-h");
    expect(more).toHaveLength(0);
    expect(m!.from_label).toBe(ar.SEND_BACK_LABEL);
    expect(m!.body).toContain("Codex");
    expect(m!.body).toContain("1 serious problem:");
    expect(m!.body).toContain("[high] src/a.ts:1 — Null input crashes the parser.");
    expect(m!.body).toContain("Also noted (your judgment):\n- [low] src/a.ts:2 — Name is vague.");
    expect(m!.body).toContain("call finish_task again");
    expect(review("h")).toMatchObject({ status: "complete", sent_back: true });
    expect(describeHistory(getSession("impl-h")!)).toContain("ansai (Auto-review) → you");
    expect(ar.sendBack(sid)).toBe(false);
    expect(messagesTo("impl-h")).toHaveLength(1);
  });

  test("nothing goes back without a high finding, after round 2, by your own review, or to an agent that's gone", async () => {
    const low = reviewed("l", [{ severity: "medium" }, { severity: "low" }]);
    expect((await call(low, "finish_review", { summary: "minor" })).content[0]!.text).not.toContain("went to the agent");
    const second = reviewed("r2", [{ severity: "high" }], { round: 2 });
    await call(second, "finish_review", { summary: "still broken" });
    const manual = reviewed("r0", [{ severity: "high" }], { round: 0 });
    await call(manual, "finish_review", { summary: "broken" });
    const gone = reviewed("g", [{ severity: "high" }]);
    db.query("UPDATE sessions SET status = 'closed' WHERE id = 'impl-g'").run();
    await call(gone, "finish_review", { summary: "broken" });
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
  });

  test("a long list is cut to fit one message", () => {
    const long = Array.from({ length: 40 }, (_, i) => ({ file: `src/f${i}.ts`, line: 1, severity: "high" as const, message: "x".repeat(900) }));
    const body = ar.sendBackMessage("codex", "T", long);
    expect(body.length).toBeLessThan(8000);
    expect(body).toContain("40 serious problems");
    expect(body.endsWith("A second review checks that.")).toBe(true);
  });
});

describe("stuck reviewers", () => {
  const MIN = 60_000;
  function running(id: string, o: { age: number; idle?: number }) {
    task(id, { status: "review" });
    const sid = reviewer(id, "codex", 1, now() - o.age);
    if (o.idle !== undefined) db.query("UPDATE sessions SET agent_state = 'waiting', agent_state_at = ? WHERE id = ?").run(now() - o.idle, sid);
    return sid;
  }

  test("idle without finish_review: told once, then closed; past 30 minutes: closed; findings kept", async () => {
    const quiet = running("q", { age: 5 * MIN, idle: 4 * MIN });
    const fine = running("ok", { age: 5 * MIN });
    const long = running("long", { age: 31 * MIN });
    findings("long", [{ severity: "high" }]);
    await ar.reviewTick();
    expect(messagesTo(quiet).map((m) => m.from_label)).toEqual([ar.SYSTEM_LABEL]);
    expect(messagesTo(fine)).toHaveLength(0);
    expect(closed).toEqual([long]);
    expect(review("long")).toMatchObject({ status: "stopped", findings: [{ severity: "high" }] });
    expect(review("long").summary).toContain("30 minutes");

    await ar.reviewTick();
    expect(messagesTo(quiet)).toHaveLength(1);
    db.query("UPDATE sessions SET agent_state_at = ? WHERE id = ?").run(now() - 11 * MIN, quiet);
    await ar.reviewTick();
    expect(closed).toEqual([long, quiet]);
    expect(review("q").status).toBe("stopped");
  });
});

describe("closing finished agents", () => {
  test("an implementer waiting on its review isn't closed; once the review is done it is", async () => {
    task("w", { status: "review" });
    implementer("impl-w", "w", { state: "waiting", stateAt: Date.now() - CLOSE_AFTER_MS - 60_000 });
    db.query("UPDATE tasks SET summary = 'done', auto_review = 1 WHERE id = 'w'").run();
    const close = async () => {};
    expect(await closeFinishedAgents(Date.now(), close)).toEqual([]);
    db.query("UPDATE tasks SET auto_review = 0 WHERE id = 'w'").run();
    const sid = reviewer("w", "codex", 1);
    expect(await closeFinishedAgents(Date.now(), close)).toEqual([]);
    db.query("UPDATE task_reviews SET status = 'complete' WHERE session_id = ?").run(sid);
    expect(await closeFinishedAgents(Date.now(), close)).toEqual(["impl-w"]);
  });
});
