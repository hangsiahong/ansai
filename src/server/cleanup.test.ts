// Agents that are finished with a task must not pile up (each idle one holds ~500 MB):
// marking a task Done clears its idle agents and its worktree when nothing can be lost, and
// finished unattended agents close themselves after an hour. Neither may ever touch work
// that exists nowhere else, close an agent that might still be working, or change what the
// task or a scheduled run says happened. Runs against throwaway Git repos under the test
// ANSAI_HOME, with no tmux (closing is a recorded stand-in, or the real one over a fake tmux).
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { db, now } = await import("./db");
const { getTask, patchTask, updateTask } = await import("./tasks");
const { ensureTaskWorktree } = await import("./worktrees");
const { CLOSE_AFTER_MS, closeFinishedAgents, getSettings, updateSettings } = await import("./autopilot");
const { WARM_MS, closeSession, setTmux } = await import("./sessions");
const { holdRun, dropHold } = await import("./holds");

const root = join(process.env.ANSAI_HOME!, "cleanup-repos");

function run(cwd: string, args: string[]) {
  return Bun.spawnSync(["git", "-c", "user.email=test", "-c", "user.name=test", ...args], { cwd });
}
function git(cwd: string, ...args: string[]) {
  const r = run(cwd, args);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
const write = (dir: string, rel: string, text: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const hasBranch = (repo: string, branch: string) => run(repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]).exitCode === 0;

/** A project: a new repo on `main` with one commit. */
function project(name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  write(dir, "a.txt", "a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

let n = 0;
/** A task in Review with the summary its agent filed, and (when `repo` is given) a fresh worktree. */
async function task(o: { repo?: string; status?: string; summary?: string | null } = {}) {
  const id = `cl${++n}`;
  db.query("INSERT INTO tasks (id, title, status, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    "Run the tests",
    o.status ?? "review",
    o.summary === undefined ? "All green." : o.summary,
    now(),
    now(),
  );
  const wt = o.repo ? await ensureTaskWorktree(getTask(id)!, o.repo) : null;
  if (o.repo && !wt) throw new Error("expected a worktree");
  return { id, wt: wt! };
}

/** A running session on the task, as the hooks leave it: "waiting" is idle at its prompt. `idleMs`: how long it has been in that state. */
function agent(taskId: string, o: { state?: string | null; auto?: boolean; tool?: string; title?: string; idleMs?: number; at?: number; status?: string } = {}) {
  const sid = `cla${++n}`;
  const state = o.state === undefined ? "waiting" : o.state;
  db.query(
    `INSERT INTO sessions (id, task_id, tool, title, cwd, argv, tmux_name, status, agent_state, agent_state_at, created_at, auto)
     VALUES (?, ?, ?, ?, '/tmp', '[]', ?, ?, ?, ?, ?, ?)`,
  ).run(sid, taskId, o.tool ?? "claude", o.title ?? "Agent", `ansai-${sid}`, o.status ?? "running", state, state ? (o.at ?? Date.now()) - (o.idleMs ?? 0) : null, now(), o.auto === false ? 0 : 1);
  return sid;
}

/** A stand-in for closing a session: notes what it was asked to close and whether the worktree was still there, and marks it closed unless it fails. */
function closer(wtPath: string | null, failFor: string[] = []) {
  const calls: { id: string; worktreeThere: boolean }[] = [];
  const close = async (id: string) => {
    calls.push({ id, worktreeThere: !!wtPath && existsSync(wtPath) });
    if (failFor.includes(id)) throw new Error("tmux said no");
    db.query("UPDATE sessions SET status = 'closed' WHERE id = ?").run(id);
  };
  return { calls, close };
}

const sessionStatus = (id: string) => (db.query("SELECT status FROM sessions WHERE id = ?").get(id) as { status: string }).status;

// Each close logs a line; keep them out of the test output (and count them).
let logs: ReturnType<typeof spyOn<Console, "log">>;
beforeEach(() => {
  db.exec("DELETE FROM sessions; DELETE FROM task_reviews; DELETE FROM settings WHERE key = 'close_finished' OR key LIKE 'run-hold:%'");
  logs = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => logs.mockRestore());

describe("marking a task Done", () => {
  test("closes its idle agent, then removes the clean worktree and its branch", async () => {
    const repo = project("done-idle");
    const { id, wt } = await task({ repo });
    const sid = agent(id);
    const { calls, close } = closer(wt.path);

    const saved = await patchTask(id, { status: "done" }, close);

    // Closed once, while the worktree was still there (it goes after).
    expect(calls).toEqual([{ id: sid, worktreeThere: true }]);
    expect(existsSync(wt.path)).toBe(false);
    expect(hasBranch(repo, wt.branch)).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain(wt.path);
    expect(git(repo, "branch", "--format=%(refname:short)")).toBe("main");
    expect(getTask(id)).toMatchObject({ status: "done", worktree_path: null, worktree_branch: null });
    // The response says what went, for the toast.
    expect(saved).toMatchObject({ status: "done", worktree_path: null, cleanup: { agents: 1, worktree: true } });
  });

  test("removes a clean worktree when no agent is open", async () => {
    const repo = project("done-none");
    const { id, wt } = await task({ repo });
    const { calls, close } = closer(wt.path);

    const saved = await patchTask(id, { status: "done" }, close);

    expect(calls).toEqual([]);
    expect(existsSync(wt.path)).toBe(false);
    expect(hasBranch(repo, wt.branch)).toBe(false);
    expect(getTask(id)).toMatchObject({ status: "done", worktree_path: null, worktree_branch: null });
    expect(saved).toMatchObject({ cleanup: { agents: 0, worktree: true } });
  });

  test("removes a worktree whose commits another branch already has", async () => {
    const repo = project("done-merged");
    const { id, wt } = await task({ repo });
    write(wt.path, "one.txt", "1\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-qm", "step 1");
    git(repo, "merge", "-q", "--ff-only", wt.branch); // main has it now, however it got there

    await patchTask(id, { status: "done" }, closer(wt.path).close);

    expect(existsSync(wt.path)).toBe(false);
    expect(hasBranch(repo, wt.branch)).toBe(false);
    expect(git(repo, "show", "HEAD:one.txt")).toBe("1");
  });

  for (const state of ["working", "needs-input", null]) {
    test(`an agent that is ${state ?? "in no known state (a Codex on its first turn, agy)"} may still be working: nothing is touched`, async () => {
      const repo = project(`done-${state ?? "unknown"}`);
      const { id, wt } = await task({ repo });
      agent(id, { state });
      agent(id); // an idle one beside it doesn't change that
      const { calls, close } = closer(wt.path);

      const saved = await patchTask(id, { status: "done" }, close);

      expect(calls).toEqual([]);
      expect(existsSync(wt.path)).toBe(true);
      expect(hasBranch(repo, wt.branch)).toBe(true);
      expect(getTask(id)).toMatchObject({ status: "done", worktree_path: wt.path, worktree_branch: wt.branch });
      expect(saved).not.toHaveProperty("cleanup");
    });
  }

  test("an uncommitted or untracked file keeps the worktree, and the agent stays open", async () => {
    const repo = project("done-dirty");
    const { id, wt } = await task({ repo });
    write(wt.path, "a.txt", "edited, never committed\n");
    write(wt.path, "new.txt", "never added\n");
    agent(id);
    const { calls, close } = closer(wt.path);

    const saved = await patchTask(id, { status: "done" }, close);

    expect(calls).toEqual([]);
    expect(readFileSync(join(wt.path, "a.txt"), "utf8")).toBe("edited, never committed\n");
    expect(readFileSync(join(wt.path, "new.txt"), "utf8")).toBe("never added\n");
    expect(hasBranch(repo, wt.branch)).toBe(true);
    expect(getTask(id)).toMatchObject({ status: "done", worktree_path: wt.path });
    expect(saved).not.toHaveProperty("cleanup");
  });

  test("a commit that no other branch has keeps the worktree, and the agent stays open", async () => {
    const repo = project("done-unmerged");
    const { id, wt } = await task({ repo });
    write(wt.path, "one.txt", "1\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-qm", "only here");
    agent(id);
    const { calls, close } = closer(wt.path);

    const saved = await patchTask(id, { status: "done" }, close);

    expect(calls).toEqual([]);
    expect(existsSync(wt.path)).toBe(true);
    expect(git(repo, "log", "-1", "--format=%s", wt.branch)).toBe("only here");
    expect(getTask(id)).toMatchObject({ status: "done", worktree_path: wt.path });
    expect(saved).not.toHaveProperty("cleanup");
  });

  test("a worktree folder that is cut off from its project is left alone, and so is its agent", async () => {
    const { id } = await task();
    const lost = join(root, "cut-off");
    mkdirSync(lost, { recursive: true });
    db.query("UPDATE tasks SET worktree_path = ?, worktree_branch = 'ansai/gone' WHERE id = ?").run(lost, id);
    agent(id);
    const { calls, close } = closer(lost);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const saved = await patchTask(id, { status: "done" }, close);

      expect(calls).toEqual([]);
      expect(existsSync(lost)).toBe(true);
      expect(getTask(id)).toMatchObject({ status: "done", worktree_path: lost, worktree_branch: "ansai/gone" });
      expect(saved).not.toHaveProperty("cleanup");
      // Seen as cut off up front, not as a git failure to log.
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  test("a worktree folder that is already gone is left as it is: a rerun restores its branch", async () => {
    const repo = project("done-gone");
    const { id, wt } = await task({ repo });
    git(repo, "worktree", "remove", "--force", wt.path);
    const { calls, close } = closer(null);

    await patchTask(id, { status: "done" }, close);

    expect(calls).toEqual([]);
    expect(hasBranch(repo, wt.branch)).toBe(true);
    expect(getTask(id)).toMatchObject({ status: "done", worktree_path: wt.path });
  });

  test("an agent that won't close: the task is still Done, the other agent is closed, and the worktree stays for the one left in it", async () => {
    const repo = project("done-close-fails");
    const { id, wt } = await task({ repo });
    const a = agent(id);
    const b = agent(id);
    const { calls, close } = closer(wt.path, [a]);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const saved = await patchTask(id, { status: "done" }, close);

      expect(calls.map((c) => c.id).sort()).toEqual([a, b].sort());
      expect(errors.mock.calls.some((c) => String(c[0]).includes(a))).toBe(true);
      expect(existsSync(wt.path)).toBe(true);
      expect(hasBranch(repo, wt.branch)).toBe(true);
      expect(getTask(id)).toMatchObject({ status: "done", worktree_path: wt.path });
      expect(saved).toMatchObject({ status: "done", cleanup: { agents: 1, worktree: false } });
      expect(saved.worktree_path).toBe(wt.path);
    } finally {
      errors.mockRestore();
    }
  });

  test("a worktree that git won't remove is logged: the task is still Done", async () => {
    const repo = project("done-remove-fails");
    const { id, wt } = await task({ repo });
    agent(id);
    git(repo, "worktree", "lock", wt.path); // git refuses to remove a locked worktree
    const { calls, close } = closer(wt.path);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const saved = await patchTask(id, { status: "done" }, close);

      expect(calls).toHaveLength(1);
      expect(errors.mock.calls.some((c) => String(c[0]).includes("Run the tests"))).toBe(true);
      expect(existsSync(wt.path)).toBe(true);
      expect(getTask(id)).toMatchObject({ status: "done", worktree_path: wt.path });
      expect(saved).toMatchObject({ status: "done", cleanup: { agents: 1, worktree: false } });
    } finally {
      errors.mockRestore();
      git(repo, "worktree", "unlock", wt.path);
    }
  });

  test("any other change leaves the worktree and agent alone", async () => {
    const repo = project("done-other");
    const { id, wt } = await task({ repo });
    agent(id);
    const { calls, close } = closer(wt.path);

    for (const status of ["todo", "doing", "review"] as const) {
      await patchTask(id, { status }, close);
      expect(getTask(id)!.status).toBe(status);
    }
    await patchTask(id, { title: "Renamed", priority: 2 }, close);
    // Done to Done is no change, and clears nothing either.
    updateTask(id, { status: "done" });
    const again = await patchTask(id, { status: "done" }, close);

    expect(calls).toEqual([]);
    expect(existsSync(wt.path)).toBe(true);
    expect(again).not.toHaveProperty("cleanup");
    expect(getTask(id)).toMatchObject({ status: "done", worktree_path: wt.path });
  });

  test("a task with no worktree is marked Done and nothing else happens", async () => {
    const { id } = await task();
    agent(id);
    const { calls, close } = closer(null);

    const saved = await patchTask(id, { status: "done" }, close);

    expect(calls).toEqual([]);
    expect(getTask(id)!.status).toBe("done");
    expect(saved).not.toHaveProperty("cleanup");
  });

  test("updateTask itself clears nothing: Merge sets Done through it, after it has cleaned up", async () => {
    const repo = project("done-update-only");
    const { id, wt } = await task({ repo });
    agent(id);

    updateTask(id, { status: "done" });

    expect(existsSync(wt.path)).toBe(true);
    expect(getTask(id)).toMatchObject({ status: "done", worktree_path: wt.path });
  });
});

/** Closing through the real closeSession, over a tmux that has every running session's pane. */
describe("closing the agent of a finished task", () => {
  const realTmux = setTmux(async (args) => {
    if (args[0] === "list-panes") {
      const rows = db.query("SELECT tmux_name FROM sessions WHERE status = 'running'").all() as { tmux_name: string }[];
      return { code: 0, out: rows.map((r) => `${r.tmux_name}\t0\t\tsh\t${Math.floor(Date.now() / 1000)}\t0`).join("\n"), err: "" };
    }
    return { code: 0, out: "", err: "" };
  });
  afterAll(() => void setTmux(realTmux));

  /** A scheduled run that finished: its occurrence holds what the agent found. */
  function scheduledRun(taskId: string) {
    db.query("INSERT INTO schedule_occurrences (id, schedule_id, scheduled_for, task_id, status, outcome, created_at) VALUES (?, NULL, ?, ?, 'completed', 'Found nothing to fix.', ?)").run(
      `o${taskId}`,
      now(),
      taskId,
      now(),
    );
  }
  const occurrence = (taskId: string) => db.query("SELECT status, outcome FROM schedule_occurrences WHERE task_id = ?").get(taskId);
  const taskRow = (taskId: string) => db.query("SELECT status, summary, queued, attempts, last_failure, done_at FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown>;

  test("marking Done: the task stays Done, isn't re-queued, and the scheduled run keeps its outcome", async () => {
    const repo = project("real-done");
    const { id, wt } = await task({ repo });
    scheduledRun(id);
    const sid = agent(id);
    const outcome = occurrence(id);

    const saved = await patchTask(id, { status: "done" }); // the real closeSession

    expect(sessionStatus(sid)).toBe("closed");
    expect(existsSync(wt.path)).toBe(false);
    expect(taskRow(id)).toMatchObject({ status: "done", summary: "All green.", queued: 0, attempts: 0, last_failure: null });
    expect(occurrence(id)).toEqual(outcome);
    expect(saved).toMatchObject({ cleanup: { agents: 1, worktree: true } });
  });

  test("a Review task with its summary: closing the agent leaves it in Review, with the run's outcome as the agent filed it", async () => {
    const { id } = await task();
    scheduledRun(id);
    const sid = agent(id);
    const before = { task: taskRow(id), occurrence: occurrence(id) };

    await closeSession(sid);

    expect(sessionStatus(sid)).toBe("closed");
    expect({ task: taskRow(id), occurrence: occurrence(id) }).toEqual(before);
  });

  test("the hourly check closes it for real, and the task and scheduled run are as they were", async () => {
    const repo = project("real-sweep");
    const { id, wt } = await task({ repo });
    scheduledRun(id);
    const sid = agent(id, { idleMs: CLOSE_AFTER_MS + 60_000 });
    const before = { task: taskRow(id), occurrence: occurrence(id) };

    expect(await closeFinishedAgents()).toEqual([sid]);

    expect(sessionStatus(sid)).toBe("closed");
    expect({ task: taskRow(id), occurrence: occurrence(id) }).toEqual(before);
    expect(existsSync(wt.path)).toBe(true);
    expect(hasBranch(repo, wt.branch)).toBe(true);
  });
});

describe("finished autopilot agents close after an hour", () => {
  const at = Date.now();
  const HOUR = CLOSE_AFTER_MS;
  const minutes = (m: number) => m * 60_000;

  /** One idle session of a finished task, and what a sweep at `at` closed. */
  async function sweep(o: { agent?: Parameters<typeof agent>[1]; task?: Parameters<typeof task>[0] } = {}) {
    const t = await task(o.task);
    const sid = agent(t.id, { idleMs: HOUR + minutes(1), at, ...o.agent });
    const { calls, close } = closer(t.wt?.path ?? null);
    const closed = await closeFinishedAgents(at, close);
    expect(calls.map((c) => c.id)).toEqual(closed);
    return { sid, closed, ...t };
  }

  test("the window is an hour, and no shorter than the 55 minutes resuming its conversation stays worth it", () => {
    expect(HOUR).toBe(minutes(60));
    expect(HOUR).toBeGreaterThanOrEqual(WARM_MS);
  });

  test("closes an idle agent whose task is in Review with its summary; the worktree, branch and task stay", async () => {
    const repo = project("sweep-review");
    const { sid, closed, id, wt } = await sweep({ task: { repo } });

    expect(closed).toEqual([sid]);
    expect(existsSync(wt.path)).toBe(true);
    expect(hasBranch(repo, wt.branch)).toBe(true);
    expect(getTask(id)).toMatchObject({ status: "review", summary: "All green.", worktree_path: wt.path, worktree_branch: wt.branch });
  });

  test("closes an idle agent whose task is Done", async () => {
    const { sid, closed } = await sweep({ task: { status: "done", summary: null } });
    expect(closed).toEqual([sid]);
  });

  test("closes a Codex agent too, and every qualifying session of the task", async () => {
    const t = await task();
    const a = agent(t.id, { idleMs: HOUR + 1, at });
    const b = agent(t.id, { idleMs: HOUR + 1, at, tool: "codex" });
    const { close } = closer(null);
    expect((await closeFinishedAgents(at, close)).sort()).toEqual([a, b].sort());
  });

  test("exactly an hour idle closes it; 59 minutes does not", async () => {
    expect((await sweep({ agent: { idleMs: HOUR } })).closed).toHaveLength(1);
    expect((await sweep({ agent: { idleMs: minutes(59) } })).closed).toEqual([]);
    expect((await sweep({ agent: { idleMs: 0 } })).closed).toEqual([]);
  });

  test("time is the clock handed in: the same session is closed later and not earlier", async () => {
    const t = await task();
    agent(t.id, { idleMs: 0, at });
    const { close } = closer(null);
    expect(await closeFinishedAgents(at + HOUR - 1, close)).toEqual([]);
    expect(await closeFinishedAgents(at + HOUR, close)).toHaveLength(1);
  });

  const stays: [string, Parameters<typeof sweep>[0]][] = [
    ["a session you started by hand", { agent: { auto: false } }],
    ["a session still working", { agent: { state: "working" } }],
    ["a session waiting on an approval", { agent: { state: "needs-input" } }],
    ["a session with no state (a Codex on its first turn, agy)", { agent: { state: null } }],
    ["an agy session, which never reports a state", { agent: { tool: "agy", state: null } }],
    ["a shell", { agent: { tool: "shell" } }],
    ["a session that has already exited", { agent: { status: "exited" } }],
    ["a Review task with no summary (the agent stopped to ask something)", { task: { summary: null } }],
    ["a task still in Doing", { task: { status: "doing" } }],
    ["a task still in To do", { task: { status: "todo" } }],
    ["an independent reviewer (by its title)", { agent: { title: "Review · Run the tests" } }],
  ];
  for (const [name, o] of stays) {
    test(`keeps ${name}`, async () => {
      const r = await sweep(o);
      expect(r.closed).toEqual([]);
    });
  }

  test("keeps an independent reviewer that has a review row", async () => {
    const t = await task();
    const sid = agent(t.id, { idleMs: HOUR + 1, at });
    db.query("INSERT INTO task_reviews (task_id, session_id, reviewer_tool, status, updated_at) VALUES (?, ?, 'claude', 'running', ?)").run(t.id, sid, now());
    expect(await closeFinishedAgents(at, closer(null).close)).toEqual([]);
  });

  test("keeps an agent on an active shift, and closes it once the shift is over", async () => {
    const t = await task();
    const sid = agent(t.id, { idleMs: HOUR + 1, at });
    db.query("INSERT INTO shifts (session_id, until, started_at) VALUES (?, ?, ?)").run(sid, at + minutes(30), at - minutes(30));
    const { close } = closer(null);
    expect(await closeFinishedAgents(at, close)).toEqual([]);
    db.query("UPDATE shifts SET ended_at = ?, end_reason = 'time' WHERE session_id = ?").run(at, sid);
    expect(await closeFinishedAgents(at, close)).toEqual([sid]);
  });

  test("keeps a run held for a usage limit", async () => {
    const t = await task({ status: "review", summary: "Half of it." });
    const sid = agent(t.id, { idleMs: HOUR + 1, at });
    expect(holdRun(sid, "rate_limit", true)).not.toBeNull();
    const { close } = closer(null);
    try {
      expect(await closeFinishedAgents(at, close)).toEqual([]);
    } finally {
      dropHold(sid, true);
    }
    expect(await closeFinishedAgents(at, close)).toEqual([sid]);
  });

  test("the setting turns it off, and it is on until then", async () => {
    expect(getSettings().closeFinished).toBe(true);
    const t = await task();
    agent(t.id, { idleMs: HOUR + 1, at });
    const { close } = closer(null);

    expect(updateSettings({ closeFinished: false }).closeFinished).toBe(false);
    expect(await closeFinishedAgents(at, close)).toEqual([]);
    expect(updateSettings({ closeFinished: true }).closeFinished).toBe(true);
    expect(await closeFinishedAgents(at, close)).toHaveLength(1);
    // Other settings don't switch it.
    updateSettings({ closeFinished: false });
    expect(updateSettings({ autopilotMax: 3 }).closeFinished).toBe(false);
    updateSettings({ autopilotMax: 2 });
  });

  test("a session that won't close is logged and the others still close", async () => {
    const t = await task();
    const a = agent(t.id, { idleMs: HOUR + 1, at });
    const b = agent(t.id, { idleMs: HOUR + 1, at });
    const { calls, close } = closer(null, [a]);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const closed = await closeFinishedAgents(at, close);
      expect(calls.map((c) => c.id).sort()).toEqual([a, b].sort());
      expect(closed).toEqual([b]);
      expect(errors.mock.calls.some((c) => String(c[0]).includes(a))).toBe(true);
      // One log line per close, naming the session.
      expect(logs.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining(b)]);
    } finally {
      errors.mockRestore();
    }
  });
});
