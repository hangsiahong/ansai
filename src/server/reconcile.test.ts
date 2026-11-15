// State reconciliation:
// - reconcile() in sessions.ts: detects dead/vanished tmux panes and marks sessions exited
// - onExited() in hooks.ts: recovers tasks from doing to review with exit summary, guarding against multi-session runs
// - handleHook() in hooks.ts: state machine transitions (UserPromptSubmit, Stop, Notification, Codex turn complete)
import { beforeEach, describe, expect, test } from "bun:test";

const { db, now } = await import("./db");
const { getSession, reconcile } = await import("./sessions");
const { getTask } = await import("./tasks");
const { handleHook, onExited } = await import("./hooks");
const team = await import("./team");

function makeTask(
  id: string,
  o: { status?: string; summary?: string | null; project?: string } = {},
) {
  db.query(
    `INSERT INTO tasks (id, project_id, title, status, summary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, o.project ?? "p1", `Task ${id}`, o.status ?? "doing", o.summary ?? null, now(), now());
  return getTask(id)!;
}

function makeSession(
  id: string,
  taskId: string | null = null,
  o: { status?: string; agentState?: string | null; tool?: string; project?: string } = {},
) {
  db.query(
    `INSERT INTO sessions (id, project_id, task_id, tool, title, cwd, argv, tmux_name, status, agent_state, created_at, msg_cursor)
     VALUES (?, ?, ?, ?, ?, '/tmp', '[]', ?, ?, ?, ?, (SELECT COALESCE(MAX(id), 0) FROM messages))`,
  ).run(
    id,
    o.project ?? "p1",
    taskId,
    o.tool ?? "claude",
    `Session ${id}`,
    `ansai-${id}`,
    o.status ?? "running",
    o.agentState ?? "working",
    now(),
  );
  return getSession(id)!;
}

beforeEach(() => {
  db.exec("DELETE FROM messages; DELETE FROM sessions; DELETE FROM tasks;");
  db.query(
    "INSERT INTO projects (id, name, path, created_at) VALUES ('p1', 'p1', '/tmp/p1', 0) ON CONFLICT(id) DO NOTHING",
  ).run();
});

describe("reconcile()", () => {
  test("a session whose tmux process is gone becomes exited, setting ended_at and recovering doing task", async () => {
    const t = makeTask("t1", { status: "doing" });
    const s = makeSession("s_vanished", t.id, { status: "running" });

    // With no tmux running for s_vanished, reconcile detects it vanished
    const changed = await reconcile();
    expect(changed).toBe(true);

    const updatedSession = getSession(s.id)!;
    expect(updatedSession.status).toBe("exited");
    expect(updatedSession.exit_code).toBeNull();
    expect(updatedSession.ended_at).not.toBeNull();

    // onExited should have been called, transitioning task to review
    const updatedTask = getTask(t.id)!;
    expect(updatedTask.status).toBe("review");
    expect(updatedTask.summary).toContain("ended before the task was marked complete");
  });

  test("subsequent reconcile calls do not re-trigger onExited for already exited sessions", async () => {
    const t = makeTask("t2", { status: "doing" });
    const s = makeSession("s_once", t.id, { status: "running" });

    // First reconcile triggers transition
    await reconcile();
    expect(getSession(s.id)!.status).toBe("exited");

    // Clear summary to detect if onExited runs again
    db.query("UPDATE tasks SET summary = 'custom-user-summary' WHERE id = ?").run(t.id);

    // Second reconcile should detect no change in session state
    const changed = await reconcile();
    expect(changed).toBe(false);

    // Summary must not be overwritten
    expect(getTask(t.id)!.summary).toBe("custom-user-summary");
  });

  test("ignores closed sessions", async () => {
    const s = makeSession("s_closed", null, { status: "closed" });
    await reconcile();
    expect(getSession(s.id)!.status).toBe("closed");
  });
});

describe("onExited()", () => {
  test("moves task from doing to review with exit code summary when process crashes", () => {
    const t = makeTask("t_crash", { status: "doing" });
    const s = makeSession("s_crash", t.id, { status: "running" });

    onExited(s.id, 137);

    const recovered = getTask(t.id)!;
    expect(recovered.status).toBe("review");
    expect(recovered.summary).toContain("exited with code 137 before the task was marked complete");
  });

  test("moves task from doing to review with ended summary when exit code is null", () => {
    const t = makeTask("t_killed", { status: "doing" });
    const s = makeSession("s_killed", t.id, { status: "running" });

    onExited(s.id, null);

    const recovered = getTask(t.id)!;
    expect(recovered.status).toBe("review");
    expect(recovered.summary).toContain("ended before the task was marked complete");
  });

  test("preserves existing task summary instead of overwriting it", () => {
    const t = makeTask("t_summary", { status: "doing", summary: "Agent already provided progress report." });
    const s = makeSession("s_sum", t.id, { status: "running" });

    onExited(s.id, 1);

    const recovered = getTask(t.id)!;
    expect(recovered.status).toBe("review");
    expect(recovered.summary).toBe("Agent already provided progress report.");
  });

  test("does NOT move task to review while another session is still running that task", () => {
    const t = makeTask("t_multi", { status: "doing" });
    const s1 = makeSession("s_first", t.id, { status: "running" });
    const s2 = makeSession("s_rerun", t.id, { status: "running" });

    // First session exits (e.g. killed to rerun)
    onExited(s1.id, 1);

    // Task must remain in doing because s_rerun is still actively running
    const stillDoing = getTask(t.id)!;
    expect(stillDoing.status).toBe("doing");
    expect(stillDoing.summary).toBeNull();

    // Once the second session exits, the task moves to review
    db.query("UPDATE sessions SET status = 'exited' WHERE id = ?").run(s1.id);
    onExited(s2.id, 0);

    const finished = getTask(t.id)!;
    expect(finished.status).toBe("review");
  });

  test("does not alter tasks that are already done or in review", () => {
    const tDone = makeTask("t_done", { status: "done", summary: "Complete" });
    const sDone = makeSession("s_done", tDone.id, { status: "running" });

    onExited(sDone.id, 1);

    const task = getTask(tDone.id)!;
    expect(task.status).toBe("done");
    expect(task.summary).toBe("Complete");
  });

  test("drops active file claims when the session exits", () => {
    const s = makeSession("s_claim", null, { status: "running" });
    team.claimFiles(s, ["src/server/reconcile.ts"], "working on tests");
    expect(team.claimsOf(s).some((c) => c.startsWith("src/server/reconcile.ts"))).toBe(true);

    onExited(s.id, 0);

    expect(team.claimsOf(s)).toEqual([]);
  });
});

describe("handleHook() state moves", () => {
  test("UserPromptSubmit moves task from review back to doing and sets agent state to working", () => {
    const t = makeTask("t_prompt", { status: "review" });
    const s = makeSession("s_prompt", t.id, { status: "running", agentState: "waiting" });

    handleHook("claude", "UserPromptSubmit", s.id, {});

    expect(getTask(t.id)!.status).toBe("doing");
    expect(getSession(s.id)!.agent_state).toBe("working");
  });

  test("Stop with no waking messages moves task to review and sets agent state to waiting", () => {
    const t = makeTask("t_stop", { status: "doing" });
    const s = makeSession("s_stop", t.id, { status: "running", agentState: "working" });

    const reply = handleHook("claude", "Stop", s.id, {});

    expect(reply).toBeUndefined();
    expect(getTask(t.id)!.status).toBe("review");
    expect(getSession(s.id)!.agent_state).toBe("waiting");
  });

  test("Stop with pending waking messages keeps task in doing and agent in working", () => {
    const t = makeTask("t_wake", { status: "doing" });
    const s = makeSession("s_wake", t.id, { status: "running", agentState: "working" });

    // Direct message wakes
    team.postMessage({ from: null, to: s.id, body: "Continue with the remaining tasks" });

    const reply = handleHook("claude", "Stop", s.id, {});

    expect(reply?.hookSpecificOutput?.hookEventName).toBe("Stop");
    expect(reply?.hookSpecificOutput?.additionalContext).toContain("Continue with the remaining tasks");
    expect(getTask(t.id)!.status).toBe("doing");
    expect(getSession(s.id)!.agent_state).toBe("working");
  });

  test("Notification idle vs needs-input transitions", () => {
    const s = makeSession("s_notif", null, { status: "running", agentState: "working" });

    // 1. Idle notification: notification_type = "idle_prompt" -> state waiting
    handleHook("claude", "Notification", s.id, { notification_type: "idle_prompt", message: "Ready" });
    expect(getSession(s.id)!.agent_state).toBe("waiting");

    // 2. Idle notification: message contains "waiting for your input" -> state waiting
    handleHook("claude", "Notification", s.id, { message: "Claude is waiting for your input." });
    expect(getSession(s.id)!.agent_state).toBe("waiting");

    // 3. Approval/permission prompt: regular notification -> state needs-input
    handleHook("claude", "Notification", s.id, { notification_type: "permission_prompt", message: "Allow file edit?" });
    expect(getSession(s.id)!.agent_state).toBe("needs-input");
    expect(getSession(s.id)!.agent_message).toBe("Allow file edit?");
  });

  test("Codex agent-turn-complete moves task from doing to review and records last assistant message", () => {
    const t = makeTask("t_codex", { status: "doing" });
    const s = makeSession("s_codex", t.id, { status: "running", tool: "codex", agentState: "working" });

    handleHook("codex", "turn", s.id, {
      type: "agent-turn-complete",
      "last-assistant-message": "Fixed all test cases and verified green.",
    });

    expect(getTask(t.id)!.status).toBe("review");
    expect(getSession(s.id)!.agent_state).toBe("waiting");
    expect(getSession(s.id)!.agent_message).toBe("Fixed all test cases and verified green.");
  });

  test("ignores closed sessions", () => {
    const t = makeTask("t_closed_task", { status: "doing" });
    const s = makeSession("s_closed_hook", t.id, { status: "closed", agentState: "working" });

    const reply = handleHook("claude", "Stop", s.id, {});
    expect(reply).toBeUndefined();
    expect(getTask(t.id)!.status).toBe("doing");
    expect(getSession(s.id)!.agent_state).toBe("working");
  });
});
