// Shifts: when an agent on shift keeps going, when it is allowed to stop, and
// how a shift ends. Agents are kept "working" so nothing gets typed into tmux.
import { beforeEach, describe, expect, test } from "bun:test";

const { db, now } = await import("./db");
const shifts = await import("./shifts");
const { handleHook } = await import("./hooks");
const { mcpHttp } = await import("./mcp");
const team = await import("./team");

const HOUR = 3600_000;

function agent(id: string, o: { tool?: string; state?: string; task?: string | null; status?: string } = {}) {
  db.query(
    `INSERT INTO sessions (id, project_id, task_id, tool, title, cwd, argv, tmux_name, status, agent_state, created_at, msg_cursor)
     VALUES (?, 'sp1', ?, ?, ?, '/tmp', '[]', ?, ?, ?, ?, (SELECT COALESCE(MAX(id), 0) FROM messages))`,
  ).run(id, o.task ?? null, o.tool ?? "claude", `Agent ${id}`, `ansai-${id}`, o.status ?? "running", o.state ?? "working", now());
}
const taskStatus = (id: string) => (db.query("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string }).status;
const shift = (id: string) => shifts.shiftView(id)!;

beforeEach(() => {
  db.exec("DELETE FROM shifts; DELETE FROM messages; DELETE FROM sessions; DELETE FROM tasks;");
  db.query("INSERT OR IGNORE INTO projects (id, name, path, created_at) VALUES ('sp1', 'sp1', '/tmp/shift-sp1', 0)").run();
  db.query("INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) VALUES ('t1', 'sp1', 'T', 'doing', 0, 0)").run();
});

describe("starting", () => {
  test("only running Claude or Codex agents, for a minute to a day", () => {
    agent("a");
    agent("sh", { tool: "shell" });
    agent("gy", { tool: "agy" });
    agent("old", { status: "exited" });
    expect(() => shifts.startShift("sh", { until: now() + HOUR })).toThrow(/shell/);
    expect(() => shifts.startShift("gy", { until: now() + HOUR })).toThrow(/Claude Code and Codex/);
    expect(() => shifts.startShift("old", { until: now() + HOUR })).toThrow(/isn't running/);
    expect(() => shifts.startShift("a", { until: now() + 10_000 })).toThrow(/minute/);
    expect(() => shifts.startShift("a", { until: now() + 25 * HOUR })).toThrow(/24 hours/);
    const v = shifts.startShift("a", { until: now() + HOUR, focus: "  polish the chat  " });
    expect(v.active).toBe(true);
    expect(v.focus).toBe("polish the chat");
  });

  test("extending a running shift keeps its counters; a new shift after one ended starts fresh", () => {
    agent("a");
    shifts.startShift("a", { until: now() + HOUR });
    handleHook("claude", "Stop", "a", {});
    expect(shift("a").nudges).toBe(1);
    shifts.startShift("a", { until: now() + 2 * HOUR });
    expect(shift("a").nudges).toBe(1);
    shifts.endShift("a", "you");
    expect(shift("a").active).toBe(false);
    shifts.startShift("a", { until: now() + HOUR });
    expect(shift("a")).toMatchObject({ active: true, nudges: 0, end_reason: null });
  });

  test("a project shift covers its running Claude and Codex agents only", () => {
    agent("a");
    agent("c", { tool: "codex" });
    agent("sh", { tool: "shell" });
    agent("gone", { status: "closed" });
    expect(shifts.startProjectShift("sp1", { until: now() + HOUR })).toEqual({ started: 2 });
    expect(shifts.shiftView("sh")).toBeNull();
    expect(shifts.shiftView("gone")).toBeNull();
    expect(shifts.endProjectShift("sp1")).toEqual({ ended: 2 });
    expect(shift("a").end_reason).toBe("you");
  });
});

describe("Claude keeps going", () => {
  test("Stop on shift blocks with the next prompt; the task stays in Doing", () => {
    agent("a", { task: "t1" });
    shifts.startShift("a", { until: now() + HOUR, focus: "make the backlog faster" });
    const out = handleHook("claude", "Stop", "a", {});
    expect(out?.decision).toBe("block");
    expect(out?.reason).toContain("ansai shift");
    expect(out?.reason).toContain("make the backlog faster");
    expect(out?.reason).toContain("end_shift");
    expect(taskStatus("t1")).toBe("doing");
    expect(shift("a").nudges).toBe(1);
  });

  test("without a shift, Stop ends the turn as before", () => {
    agent("a", { task: "t1" });
    expect(handleHook("claude", "Stop", "a", {})).toBeUndefined();
    expect(taskStatus("t1")).toBe("review");
  });

  test("two nudges in a row with no tool use end the shift: the agent ran out of work", () => {
    agent("a", { task: "t1" });
    shifts.startShift("a", { until: now() + HOUR });
    expect(handleHook("claude", "Stop", "a", {})?.decision).toBe("block"); // first nudge
    expect(handleHook("claude", "Stop", "a", {})?.decision).toBe("block"); // idle once
    expect(handleHook("claude", "Stop", "a", {})).toBeUndefined(); // idle twice: stop
    expect(shift("a")).toMatchObject({ active: false, end_reason: "idle", nudges: 2 });
    expect(taskStatus("t1")).toBe("review");
  });

  test("tool use between stops counts as work and resets the idle count", () => {
    agent("a");
    shifts.startShift("a", { until: now() + HOUR });
    for (let i = 0; i < 5; i++) {
      expect(handleHook("claude", "Stop", "a", {})?.decision).toBe("block");
      handleHook("claude", "PostToolUse", "a", {});
    }
    expect(shift("a")).toMatchObject({ active: true, nudges: 5, idle: 0 });
  });

  test("once time is up, Stop ends the shift and the turn", () => {
    agent("a", { task: "t1" });
    shifts.startShift("a", { until: now() + HOUR });
    db.query("UPDATE shifts SET until = ? WHERE session_id = 'a'").run(now() - 1);
    expect(handleHook("claude", "Stop", "a", {})).toBeUndefined();
    expect(shift("a").end_reason).toBe("time");
    expect(taskStatus("t1")).toBe("review");
  });

  test("team messages waiting at Stop come first; the shift nudges on the next Stop", () => {
    agent("a");
    agent("b");
    shifts.startShift("b", { until: now() + HOUR });
    team.postMessage({ from: db.query("SELECT * FROM sessions WHERE id = 'a'").get() as never, to: "b", body: "check src/x.ts" });
    expect(handleHook("claude", "Stop", "b", {})?.hookSpecificOutput?.additionalContext).toContain("check src/x.ts");
    expect(shift("b").nudges).toBe(0);
    expect(handleHook("claude", "Stop", "b", {})?.decision).toBe("block");
  });

  test("looking at ansai's backlog or team list isn't work: the shift still ends when nothing is left", () => {
    agent("a", { task: "t1" });
    shifts.startShift("a", { until: now() + HOUR });
    expect(handleHook("claude", "Stop", "a", {})?.decision).toBe("block"); // first nudge
    handleHook("claude", "PreToolUse", "a", { tool_name: "mcp__ansai__list_tasks" });
    handleHook("claude", "PostToolUse", "a", { tool_name: "mcp__ansai__list_tasks" });
    expect(handleHook("claude", "Stop", "a", {})?.decision).toBe("block"); // idle once
    handleHook("claude", "PostToolUse", "a", { tool_name: "mcp__ansai__list_agents" });
    expect(handleHook("claude", "Stop", "a", {})).toBeUndefined(); // idle twice: it used to go on like this all night
    expect(shift("a")).toMatchObject({ active: false, end_reason: "idle" });
  });

  test("a real tool after a look at the backlog is work", () => {
    agent("a");
    shifts.startShift("a", { until: now() + HOUR });
    for (let i = 0; i < 4; i++) {
      expect(handleHook("claude", "Stop", "a", {})?.decision).toBe("block");
      handleHook("claude", "PostToolUse", "a", { tool_name: "mcp__ansai__list_tasks" });
      handleHook("claude", "PostToolUse", "a", { tool_name: "Edit" });
    }
    expect(shift("a")).toMatchObject({ active: true, nudges: 4, idle: 0 });
  });

  /** Nudge a working Claude until its shift lets it stop; how many nudges it got. */
  const nudgesUntilStopped = (id: string, limit = 300) => {
    for (let n = 0; n < limit; n++) {
      handleHook("claude", "PostToolUse", id, { tool_name: "Bash" });
      if (!handleHook("claude", "Stop", id, {})) return n;
    }
    return limit;
  };

  test("the hourly nudge cap ends a runaway shift", () => {
    agent("a");
    shifts.startShift("a", { until: now() + HOUR });
    expect(nudgesUntilStopped("a")).toBe(30);
    expect(shift("a")).toMatchObject({ active: false, end_reason: "cap", nudges: 30 });
  });

  test("quiet hours don't save up nudges: a long shift is still held to 30 in an hour", () => {
    agent("a");
    shifts.startShift("a", { until: now() + 4 * HOUR });
    // 7.5 hours in, 5 nudges so far, the last one two hours ago. It used to be allowed 235 more in a row.
    db.query("UPDATE shifts SET started_at = ?, nudges = 5 WHERE session_id = 'a'").run(now() - 7.5 * HOUR);
    db.query("INSERT OR REPLACE INTO settings (key, value) VALUES ('shift-nudges:a', ?)").run(JSON.stringify([now() - 2 * HOUR]));
    expect(nudgesUntilStopped("a")).toBe(30);
    expect(shift("a").end_reason).toBe("cap");
  });

  test("nudges from more than an hour ago don't count against the cap, and a new shift starts clean", () => {
    agent("a");
    shifts.startShift("a", { until: now() + HOUR });
    const old = Array.from({ length: 30 }, (_, i) => now() - HOUR - 1000 - i);
    db.query("INSERT OR REPLACE INTO settings (key, value) VALUES ('shift-nudges:a', ?)").run(JSON.stringify(old));
    handleHook("claude", "PostToolUse", "a", {});
    expect(handleHook("claude", "Stop", "a", {})?.decision).toBe("block");
    shifts.endShift("a", "you");
    expect(db.query("SELECT 1 FROM settings WHERE key = 'shift-nudges:a'").get()).toBeNull();
  });
});

describe("Codex", () => {
  test("a finished turn on shift keeps the task in Doing (the next prompt is typed in)", () => {
    agent("c", { tool: "codex", task: "t1" });
    shifts.startShift("c", { until: now() + HOUR });
    handleHook("codex", "turn", "c", { type: "agent-turn-complete", "last-assistant-message": "done with step 1" });
    expect(taskStatus("t1")).toBe("doing");
    expect((db.query("SELECT agent_state FROM sessions WHERE id = 'c'").get() as { agent_state: string }).agent_state).toBe("waiting");
  });

  test("without a shift, the turn hands the task back for review", () => {
    agent("c", { tool: "codex", task: "t1" });
    handleHook("codex", "turn", "c", { type: "agent-turn-complete" });
    expect(taskStatus("t1")).toBe("review");
  });
});

describe("ending", () => {
  const rpc = (sid: string, name: string, args: object) =>
    mcpHttp(
      new Request(`http://127.0.0.1/mcp?s=${sid}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }),
    ).then((r) => r.json() as Promise<{ result: { content: { text: string }[]; isError: boolean } }>);

  test("the agent ends its shift with end_shift and a summary", async () => {
    agent("a");
    expect((await rpc("a", "end_shift", { summary: "x" })).result.content[0]!.text).toContain("not on a shift");
    shifts.startShift("a", { until: now() + HOUR });
    expect((await rpc("a", "end_shift", {})).result.isError).toBe(true);
    const r = await rpc("a", "end_shift", { summary: "Fixed the chat scroll and added tests." });
    expect(r.result.isError).toBe(false);
    expect(shift("a")).toMatchObject({ active: false, end_reason: "agent", summary: "Fixed the chat scroll and added tests." });
    expect(handleHook("claude", "Stop", "a", {})).toBeUndefined();
  });

  test("the loop ends shifts that ran out of time or whose agent is gone", async () => {
    agent("a");
    agent("b");
    shifts.startShift("a", { until: now() + HOUR });
    shifts.startShift("b", { until: now() + HOUR });
    db.query("UPDATE shifts SET until = ? WHERE session_id = 'a'").run(now() - 1);
    db.query("UPDATE sessions SET status = 'exited' WHERE id = 'b'").run();
    await shifts.nudgeIdle();
    expect(shift("a").end_reason).toBe("time");
    expect(shift("b").end_reason).toBe("exited");
  });

  test("an ended shift gets a report of the commits made meanwhile", async () => {
    agent("a");
    shifts.startShift("a", { until: now() + HOUR });
    shifts.endShift("a", "you");
    for (let i = 0; i < 50 && !shift("a").report; i++) await Bun.sleep(20);
    expect(shift("a").report).toEqual({ commits: [], moreCommits: 0 }); // /tmp is no git repo
  });
});

describe("stopping", () => {
  test("Esc while the agent is mid-turn ends its shift; Esc on an idle agent doesn't", () => {
    agent("busy", { state: "working" });
    agent("idle", { state: "waiting" });
    shifts.startShift("busy", { until: now() + HOUR });
    shifts.startShift("idle", { until: now() + HOUR });
    shifts.stopPressed("busy", ["Down"]);
    expect(shift("busy").active).toBe(true);
    shifts.stopPressed("busy", ["Escape"]);
    expect(shift("busy")).toMatchObject({ active: false, end_reason: "you" });
    shifts.stopPressed("idle", ["Escape"]);
    expect(shift("idle").active).toBe(true);
  });

  test("a Codex agent working on a typed nudge counts as mid-turn", () => {
    agent("c", { tool: "codex", state: "waiting" });
    shifts.startShift("c", { until: now() + HOUR });
    db.query("UPDATE sessions SET agent_state_at = ? WHERE id = 'c'").run(now() - 60_000);
    db.query("UPDATE shifts SET last_nudge_at = ? WHERE session_id = 'c'").run(now() - 30_000);
    shifts.stopPressed("c", ["Escape"]);
    expect(shift("c").end_reason).toBe("you");
  });
});

describe("older hook files", () => {
  test("PreToolUse alone counts as work (agents started before PostToolUse was hooked)", () => {
    agent("old");
    shifts.startShift("old", { until: now() + HOUR });
    for (let i = 0; i < 4; i++) {
      expect(handleHook("claude", "Stop", "old", {})?.decision).toBe("block");
      handleHook("claude", "PreToolUse", "old", {});
    }
    expect(shift("old")).toMatchObject({ active: true, idle: 0 });
  });
});

describe("hooks whose reply Claude doesn't read", () => {
  test("Stop lets the agent stop (the next prompt gets typed in) and doesn't hand the task back", () => {
    agent("old", { task: "t1" });
    shifts.startShift("old", { until: now() + HOUR });
    expect(handleHook("claude", "Stop", "old", {}, false)).toBeUndefined();
    expect(shift("old")).toMatchObject({ active: true, nudges: 0 }); // no nudge recorded that Claude never saw
    expect((db.query("SELECT agent_state FROM sessions WHERE id = 'old'").get() as { agent_state: string }).agent_state).toBe("waiting");
    expect(taskStatus("t1")).toBe("doing");
  });

  test("team messages stay queued instead of vanishing into /dev/null", () => {
    agent("a");
    agent("old");
    team.postMessage({ from: db.query("SELECT * FROM sessions WHERE id = 'a'").get() as never, to: "old", body: "ping" });
    expect(handleHook("claude", "UserPromptSubmit", "old", {}, false)).toBeUndefined();
    expect(handleHook("claude", "Stop", "old", {}, false)).toBeUndefined();
    expect(team.takePending("old")).toContain("ping");
  });
});
