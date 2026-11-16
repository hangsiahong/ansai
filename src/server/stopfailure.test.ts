// A Claude turn that ends without a Stop hook: on an API error (StopFailure fires
// instead), or because the Stop hook never reached ansai (it was restarting).
// Before, the session showed Working and its task sat in Doing with no push.
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { db, now } = await import("./db");
const { config } = await import("./config");
const shifts = await import("./shifts");
const compaction = await import("./compaction");
const { handleHook, writeHookFiles } = await import("./hooks");

const HOUR = 3600_000;

function agent(id: string, o: { state?: string; task?: string | null; title?: string } = {}) {
  db.query(
    `INSERT INTO sessions (id, project_id, task_id, tool, title, cwd, argv, tmux_name, status, agent_state, created_at, msg_cursor)
     VALUES (?, 'fp1', ?, 'claude', ?, '/tmp', '[]', ?, 'running', ?, ?, (SELECT COALESCE(MAX(id), 0) FROM messages))`,
  ).run(id, o.task ?? null, o.title ?? `Agent ${id}`, `ansai-${id}`, o.state ?? "working", now());
}
const task = (id: string) => db.query("SELECT status, last_failure, summary FROM tasks WHERE id = ?").get(id) as { status: string; last_failure: string | null; summary: string | null };
const session = (id: string) => db.query("SELECT agent_state, agent_message FROM sessions WHERE id = ?").get(id) as { agent_state: string | null; agent_message: string | null };

beforeEach(() => {
  db.exec("DELETE FROM shifts; DELETE FROM messages; DELETE FROM task_reviews; DELETE FROM sessions; DELETE FROM tasks;");
  db.query("INSERT OR IGNORE INTO projects (id, name, path, created_at) VALUES ('fp1', 'fp1', '/tmp/fail-fp1', 0)").run();
  db.query("INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) VALUES ('t1', 'fp1', 'T', 'doing', 0, 0)").run();
});

describe("a turn that ends on an API error", () => {
  test("Claude agents are given the StopFailure hook", () => {
    writeHookFiles();
    const hooks = JSON.parse(readFileSync(join(config.dataDir, "claude-hooks.json"), "utf8")).hooks;
    expect(hooks.StopFailure[0].hooks[0].command).toContain("/claude/StopFailure?s=$ANSAI_SESSION_ID");
    expect(hooks.Stop).toBeDefined();
  });

  test("the task leaves Doing with the reason, and the session says why it stopped", () => {
    agent("a", { task: "t1" });
    expect(handleHook("claude", "StopFailure", "a", { error: "rate_limit" })).toBeUndefined();
    expect(session("a")).toEqual({ agent_state: "waiting", agent_message: "Stopped: it hit this account's usage limit" });
    expect(task("t1").status).toBe("review");
    expect(task("t1").last_failure).toBe("it hit this account's usage limit");
    expect(task("t1").summary).toBeNull(); // it isn't finished
  });

  test("an error ansai has no words for is still reported", () => {
    agent("a", { task: "t1" });
    handleHook("claude", "StopFailure", "a", { error: "quota_exploded" });
    expect(session("a").agent_message).toBe("Stopped: the API returned an error (quota exploded)");
    handleHook("claude", "UserPromptSubmit", "a", {});
    handleHook("claude", "StopFailure", "a", {});
    expect(session("a").agent_message).toBe("Stopped: the API returned an error (unknown)");
    expect(task("t1").status).toBe("review");
  });

  test("a usage limit, login or billing error ends the shift instead of nudging into it again", () => {
    agent("a", { task: "t1" });
    shifts.startShift("a", { until: now() + HOUR });
    handleHook("claude", "StopFailure", "a", { error: "rate_limit" });
    const sh = shifts.shiftView("a")!;
    expect(sh.active).toBe(false);
    expect(sh.end_reason).toBe("error");
    expect(task("t1").status).toBe("review");
  });

  test("an error that passes (overloaded) leaves the shift on: its next prompt is the retry", () => {
    agent("a", { task: "t1" });
    shifts.startShift("a", { until: now() + HOUR });
    handleHook("claude", "StopFailure", "a", { error: "overloaded" });
    expect(shifts.shiftView("a")!.active).toBe(true);
    expect(session("a").agent_state).toBe("waiting"); // nudgeIdle types the next prompt
    expect(task("t1").status).toBe("doing");
  });

  test("a reviewer's failure doesn't move the task it is reviewing", () => {
    agent("r", { task: "t1", title: "Review · T" });
    handleHook("claude", "StopFailure", "r", { error: "overloaded" });
    expect(session("r").agent_state).toBe("waiting");
    expect(task("t1").status).toBe("doing");
  });
});

describe("a Stop hook that never arrived", () => {
  const idle = { notification_type: "idle_prompt", message: "Claude is waiting for your input" };

  test("Claude's idle notice while ansai has it mid-turn ends the turn", () => {
    agent("a", { task: "t1" });
    handleHook("claude", "Notification", "a", idle);
    expect(session("a").agent_state).toBe("waiting");
    expect(task("t1").status).toBe("review");
  });

  test("an idle notice after a turn that did end changes nothing", () => {
    agent("a", { task: "t1" });
    handleHook("claude", "Stop", "a", {});
    db.query("UPDATE tasks SET status = 'done' WHERE id = 't1'").run();
    handleHook("claude", "Notification", "a", idle);
    expect(session("a").agent_state).toBe("waiting");
    expect(task("t1").status).toBe("done");
  });

  test("on shift the agent is marked idle and stays on its task: the next prompt gets typed in", () => {
    agent("a", { task: "t1" });
    shifts.startShift("a", { until: now() + HOUR });
    handleHook("claude", "Notification", "a", idle);
    expect(session("a").agent_state).toBe("waiting");
    expect(shifts.shiftView("a")!.active).toBe(true);
    expect(task("t1").status).toBe("doing");
  });

  test("an agent ansai is compacting isn't taken for one that finished", () => {
    agent("a", { task: "t1" });
    compaction.setSender(async () => {});
    compaction.requestCompaction("a", "keep this", "then do that");
    handleHook("claude", "Stop", "a", {}); // ansai starts /compact: the session shows Working meanwhile
    expect(compaction.compactionRunning("a")).toBe(true);
    handleHook("claude", "Notification", "a", idle);
    expect(task("t1").status).toBe("doing");
    compaction.dropCompaction("a");
  });
});
