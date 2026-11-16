// A Claude autopilot run that stops at its account's usage limit used to sit in Review holding
// its autopilot slot until you answered, so a night's queue stopped at the first limit. Now the
// run is held: its slot goes to tasks on other accounts, tasks on the same account wait, and
// at the reset ansai tells the run to carry on. A server error gets one retry a few minutes later.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

const { db, now, getSetting, setSetting } = await import("./db");
const { autopilotTick, setProjectAutopilot, setTaskStarter } = await import("./autopilot");
const { handleHook } = await import("./hooks");
const holds = await import("./holds");
const { listAccounts } = await import("./accounts");
const { runDeadline } = await import("./runs");

const MIN = 60_000;
let started: string[] = [];
let typed: [string, string][] = [];
let failTyping = false;

function run(id: string, o: { task?: string; project?: string; account?: string; auto?: boolean } = {}) {
  db.query(
    `INSERT INTO sessions (id, project_id, task_id, account_id, tool, title, cwd, argv, tmux_name, status, agent_state, created_at, auto, msg_cursor)
     VALUES (?, ?, ?, ?, 'claude', ?, '/tmp', '[]', ?, 'running', 'working', ?, ?, 0)`,
  ).run(id, o.project ?? "p1", o.task ?? null, o.account ?? "claude-default", `Run ${id}`, `ansai-${id}`, now(), o.auto === false ? 0 : 1);
}
function queue(id: string, project: string) {
  db.query("INSERT INTO tasks (id, project_id, title, status, queued, created_at, updated_at) VALUES (?, ?, ?, 'todo', 1, 1, 1)").run(id, project, id);
}
/** The limits snapshot of the default account: its 5-hour window is used up until `reset`. */
function snapshot(reset: number, pct = 100) {
  const data = { five_hour: { utilization: pct, resets_at: new Date(reset).toISOString() }, seven_day: { utilization: 40, resets_at: new Date(reset + 86400_000).toISOString() } };
  db.query("INSERT OR REPLACE INTO usage_limits (account_id, data, at) VALUES ('claude-default', ?, ?)").run(JSON.stringify(data), now());
}
const task = (id: string) => db.query("SELECT status, last_failure FROM tasks WHERE id = ?").get(id) as { status: string; last_failure: string | null };
const message = (id: string) => (db.query("SELECT agent_message FROM sessions WHERE id = ?").get(id) as { agent_message: string | null }).agent_message;
const hold = (id: string) => getSetting<import("./holds").Hold | null>(`run-hold:${id}`, null);
const fail = (id: string, error = "rate_limit") => handleHook("claude", "StopFailure", id, { error });

function clean() {
  db.exec("DELETE FROM shifts; DELETE FROM task_reviews; DELETE FROM sessions; DELETE FROM tasks; DELETE FROM usage_limits; DELETE FROM projects WHERE id IN ('p1', 'p2', 'p3');");
  db.exec("DELETE FROM settings WHERE key LIKE 'run-hold:%' OR key LIKE 'run-paused:%' OR key = 'autopilot_max'; DELETE FROM accounts WHERE id = 'claude-other';");
}

beforeEach(() => {
  clean();
  db.exec(`INSERT OR IGNORE INTO accounts (id, tool, name, dir, is_default, created_at) VALUES ('claude-default', 'claude', 'Default login', NULL, 1, 0);
    INSERT INTO accounts (id, tool, name, dir, is_default, created_at) VALUES ('claude-other', 'claude', 'Other', '/tmp/claude-other', 0, 1);`);
  for (const p of ["p1", "p2", "p3"]) db.query("INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, 0)").run(p, p, `/tmp/hold-${p}`);
  setProjectAutopilot("p1", { on: true, tool: "claude", accountId: null });
  setProjectAutopilot("p2", { on: true, tool: "claude", accountId: "claude-other" });
  setProjectAutopilot("p3", { on: true, tool: "claude", accountId: null });
  db.query("INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) VALUES ('t1', 'p1', 'T', 'doing', 0, 0)").run();
  started = [];
  typed = [];
  failTyping = false;
  setTaskStarter((async (id: string) => {
    started.push(id);
    return {} as never;
  }) as never);
  holds.setSender(async (id, text) => {
    if (failTyping) throw new Error("no input box");
    typed.push([id, text]);
  });
});
afterAll(clean);

describe("an autopilot run at its account's usage limit", () => {
  test("says when ansai carries it on, taken from the account's limits", () => {
    const reset = now() + 90 * MIN;
    snapshot(reset);
    run("a", { task: "t1" });
    fail("a");
    expect(task("t1")).toEqual({ status: "review", last_failure: "it hit this account's usage limit" });
    expect(hold("a")).toMatchObject({ account: "claude-default", kind: "limit", known: true, resume: true, until: reset + holds.timing.slack });
    expect(message("a")).toBe(`Stopped: it hit this account's usage limit. ansai carries on ${holds.when(reset + holds.timing.slack)}`);
  });

  test("gives its slot to a task on another account, and tasks on the same account wait", async () => {
    setSetting("autopilot_max", 1);
    snapshot(now() + 90 * MIN);
    run("a", { task: "t1" });
    fail("a");
    queue("same", "p3");
    queue("other", "p2");
    await autopilotTick();
    expect(started).toEqual(["other"]);
    expect(db.query("SELECT status, queued FROM tasks WHERE id = 'same'").get()).toEqual({ status: "todo", queued: 1 });
    // Not a matter of slots: with room for more, the account is still at its limit.
    started = [];
    setSetting("autopilot_max", 4);
    await autopilotTick();
    expect(started).toEqual(["other"]);
  });

  test("the account says until when it is held", () => {
    const reset = now() + 90 * MIN;
    snapshot(reset);
    run("a", { task: "t1" });
    expect(listAccounts().find((a) => a.id === "claude-default")!.held_until).toBeNull();
    fail("a");
    expect(listAccounts().find((a) => a.id === "claude-default")!.held_until).toBe(reset + holds.timing.slack);
    expect(listAccounts().find((a) => a.id === "claude-other")!.held_until).toBeNull();
  });

  test("at the reset it is told to carry on, once, and the account is free again", async () => {
    setSetting("autopilot_max", 2);
    const reset = now() + 90 * MIN;
    snapshot(reset);
    run("a", { task: "t1" });
    fail("a");
    await holds.resumeHeld(reset); // not yet: a minute of slack after the reset
    expect(typed).toEqual([]);
    await holds.resumeHeld(reset + holds.timing.slack);
    await holds.resumeHeld(reset + holds.timing.slack + 5000);
    expect(typed).toEqual([["a", "ansai: this account's usage limit should have reset by now. Carry on where you stopped."]]);
    expect(holds.heldUntil("claude-default")).toBeNull();
    handleHook("claude", "UserPromptSubmit", "a", {}); // Claude took the prompt
    expect(task("t1").status).toBe("doing");
    expect(hold("a")).not.toBeNull(); // remembered until the turn ends, in case it fails again
    handleHook("claude", "Stop", "a", {});
    expect(hold("a")).toBeNull();
    queue("same", "p3");
    await autopilotTick();
    expect(started).toEqual(["same"]);
  });

  test("with no reset time known it tries again in 15 minutes, and learns the time when the limits arrive", async () => {
    run("a", { task: "t1" });
    const before = now();
    fail("a");
    const h = hold("a")!;
    expect(h.known).toBe(false);
    expect(h.until).toBeGreaterThanOrEqual(before + holds.timing.unknown);
    expect(message("a")).toBe(`Stopped: it hit this account's usage limit. ansai tries again ${holds.when(h.until)}`);
    const reset = now() + 3 * 60 * MIN;
    snapshot(reset); // the poll that shows the used-up window comes minutes after the failure
    await holds.resumeHeld();
    expect(hold("a")).toMatchObject({ known: true, until: reset + holds.timing.slack });
    expect(message("a")).toBe(`Stopped: it hit this account's usage limit. ansai carries on ${holds.when(reset + holds.timing.slack)}`);
    expect(typed).toEqual([]);
  });

  test("a window that isn't used up, or has reset already, isn't taken for the reason", () => {
    snapshot(now() + 90 * MIN, 96);
    expect(holds.limitReset("claude-default")).toBeNull();
    snapshot(now() - MIN);
    expect(holds.limitReset("claude-default")).toBeNull();
  });

  test("still at the limit after carrying on: it waits again, and after enough tries it is yours", async () => {
    run("a", { task: "t1" });
    for (let n = 1; n <= holds.MAX_TRIES; n++) {
      fail("a");
      expect(hold("a")).toMatchObject({ tries: n - 1, known: false });
      await holds.resumeHeld(hold("a")!.until);
      handleHook("claude", "UserPromptSubmit", "a", {});
    }
    expect(typed.length).toBe(holds.MAX_TRIES);
    fail("a");
    expect(hold("a")).toBeNull();
    expect(message("a")).toBe("Stopped: it hit this account's usage limit");
    // As before: it waits for you, and keeps its place.
    setSetting("autopilot_max", 1);
    queue("other", "p2");
    await autopilotTick();
    expect(started).toEqual([]);
  });

  test("a held run you message yourself is yours again: ansai types nothing into it later", async () => {
    run("a", { task: "t1" });
    fail("a");
    const until = hold("a")!.until;
    handleHook("claude", "UserPromptSubmit", "a", {});
    expect(hold("a")).toBeNull();
    await holds.resumeHeld(until + 1);
    expect(typed).toEqual([]);
  });

  test("the wait doesn't count toward the project's time limit", async () => {
    setProjectAutopilot("p1", { maxMinutes: 30 });
    run("a", { task: "t1" });
    const s = () => db.query("SELECT id, auto, status, project_id, task_id, created_at FROM sessions WHERE id = 'a'").get() as Parameters<typeof runDeadline>[0];
    fail("a");
    const h = hold("a")!;
    await holds.resumeHeld(h.at + 4 * 60 * MIN);
    handleHook("claude", "UserPromptSubmit", "a", {});
    expect(runDeadline(s())).toBe(s().created_at + 30 * MIN + 4 * 60 * MIN);
  });

  test("when ansai can't type into it, it says so and the run waits for you", async () => {
    run("a", { task: "t1" });
    fail("a");
    failTyping = true;
    await holds.resumeHeld(hold("a")!.until);
    expect(hold("a")).toBeNull();
    expect(message("a")).toBe("Stopped, and ansai couldn't carry it on: its input box isn't on its screen");
  });

  test("a run that ended while held is forgotten", async () => {
    run("a", { task: "t1" });
    fail("a");
    db.query("UPDATE sessions SET status = 'exited' WHERE id = 'a'").run();
    await holds.resumeHeld(hold("a")!.until);
    expect(hold("a")).toBeNull();
    expect(typed).toEqual([]);
  });
});

describe("a session of yours at the usage limit", () => {
  test("is left to you, but autopilot starts nothing new on that account meanwhile", async () => {
    const reset = now() + 90 * MIN;
    snapshot(reset);
    run("mine", { auto: false });
    fail("mine");
    expect(message("mine")).toBe("Stopped: it hit this account's usage limit");
    queue("same", "p3");
    queue("other", "p2");
    await autopilotTick();
    expect(started).toEqual(["other"]);
    await holds.resumeHeld(reset + holds.timing.slack);
    expect(typed).toEqual([]); // nothing is typed into your session
    started = [];
    await autopilotTick();
    expect(started).toContain("same");
  });
});

describe("an autopilot run stopped by a server error", () => {
  test("is told to carry on once, three minutes later, and keeps its slot meanwhile", async () => {
    setSetting("autopilot_max", 1);
    run("a", { task: "t1" });
    fail("a", "overloaded");
    const h = hold("a")!;
    expect(h).toMatchObject({ kind: "retry", resume: true });
    expect(h.until - h.at).toBe(holds.timing.retry);
    expect(message("a")).toBe(`Stopped: Claude's servers were overloaded. ansai tries again ${holds.when(h.until)}`);
    queue("other", "p2");
    queue("same", "p3");
    await autopilotTick();
    expect(started).toEqual([]); // one slot, and the run is about to go on
    await holds.resumeHeld(h.until);
    expect(typed).toEqual([["a", "ansai: your turn stopped on an error from Claude's servers. Carry on where you stopped."]]);
    handleHook("claude", "UserPromptSubmit", "a", {});
    fail("a", "server_error"); // again: now it is yours
    expect(hold("a")).toBeNull();
    expect(message("a")).toBe("Stopped: Claude's servers had an error");
    await holds.resumeHeld(now() + 60 * MIN);
    expect(typed.length).toBe(1);
  });

  test("a session of yours isn't retried", () => {
    run("mine", { auto: false });
    fail("mine", "overloaded");
    expect(hold("mine")).toBeNull();
    expect(message("mine")).toBe("Stopped: Claude's servers were overloaded");
  });

  test("an error that needs you (a login that stopped working) isn't waited out", () => {
    run("a", { task: "t1" });
    fail("a", "authentication_failed");
    expect(hold("a")).toBeNull();
  });
});
