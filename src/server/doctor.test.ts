// The doctor: each detector over fixtures, then gathering from the database, then filing tasks.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DoingRow, DoingRun, Finding, PlanRow, WorkingRow } from "./doctor";

const { db, setSetting } = await import("./db");
const d = await import("./doctor");
const { updateSettings } = await import("./autopilot");
const { gitOut } = await import("./git");
const { getTask, updateTask } = await import("./tasks");

const MIN = 60_000;
const AT = Date.parse("2026-11-16T12:00:00Z");
const ROOT = realpathSync(resolve(import.meta.dir, "../.."));

describe("signature", () => {
  test("blanks out what varies between occurrences and keeps the route and message", () => {
    expect(d.signature("[ansai] GET /api/tasks/t3h050f200c/changes failed: Error: git diff: fatal: bad object 9f3a2c1d")).toBe(
      "[ansai] GET /api/tasks/<id>/changes failed: Error: git diff: fatal: bad object <id>",
    );
    expect(d.signature('[ansai] autopilot couldn\'t start "Fix the login": tmux exited 1 in /home/me/projects/x/.worktrees/a')).toBe(
      '[ansai] autopilot couldn\'t start "…": tmux exited N in <path>',
    );
    expect(d.signature("[ansai] couldn't type a team message into s6p2g3t3x0n: the pane is gone")).toBe(d.signature("[ansai] couldn't type a team message into s1f222l215h: the pane is gone"));
  });

  test("a web app error is the same bug on any device; its stack frames are evidence, not identity", () => {
    const a = d.signature("[ansai] web app error on iphone (page at /p/funs-ansai): TypeError: x is undefined | at Board (index.js) | at render (index.js)");
    const b = d.signature("[ansai] web app error on pixel-7 (page at /p/funs-ansai): TypeError: x is undefined | at Other (index.js)");
    expect(a).toBe(b);
    expect(a).toBe("[ansai] web app error (page at /p/funs-ansai): TypeError: x is undefined");
  });
});

describe("errors ansai logs", () => {
  const log = () => new d.ErrorLog("/srv/ansai", AT - 2 * 60 * MIN);
  const boom = () => {
    const e = new Error("no such table: nope");
    e.stack = "Error: no such table: nope\n    at listThings (/srv/ansai/src/server/tasks.ts:88:11)\n    at guarded (/srv/ansai/src/server/index.ts:106:20)";
    return e;
  };

  test("a request that fails with a 500 twice in an hour is a finding, with samples and the files from its stack", () => {
    const l = log();
    l.record(["[ansai] GET /api/tasks/t1aaaaaaaaa failed:", boom()], AT - 30 * MIN);
    expect(d.errorFindings(l.recent(AT), AT)).toEqual([]);
    l.record(["[ansai] GET /api/tasks/t2bbbbbbbbb failed:", boom()], AT - 5 * MIN);
    const [f] = d.errorFindings(l.recent(AT), AT);
    expect(f!.priority).toBe(2);
    expect(f!.key).toMatch(/^error:/);
    expect(f!.latest).toBe(AT - 5 * MIN);
    expect(f!.title).toContain("A request keeps failing");
    expect(f!.details).toContain("src/server/tasks.ts:88");
    expect(f!.details).toContain("src/server/index.ts: guard()");
    expect(f!.details).toContain("t2bbbbbbbbb"); // the samples keep the real ids
    expect(f!.details).not.toContain("/srv/ansai/");
  });

  test("any other error needs three in the last hour; older ones and those during startup don't count", () => {
    const l = log();
    l.record(["[ansai] push failed:", 500, "oops"], AT - 3 * 60 * MIN); // before `since`: startup
    l.record(["[ansai] push failed:", 500, "oops"], AT - 90 * MIN); // outside the hour
    l.record(["[ansai] push failed:", 502, "oops"], AT - 20 * MIN);
    l.record(["[ansai] push failed:", 503, "oops"], AT - 10 * MIN);
    expect(d.errorFindings(l.recent(AT), AT)).toEqual([]);
    l.record(["[ansai] push failed:", 500, "oops"], AT - MIN);
    const [f] = d.errorFindings(l.recent(AT), AT);
    expect(f!.priority).toBe(1);
    expect(f!.details).toContain("3 times in the last hour");
    expect(f!.details).toContain("src/server/push.ts");
  });

  test("an error repeating every few seconds stays bounded", () => {
    const l = log();
    for (let i = 0; i < 1000; i++) l.record(["[ansai] team delivery:", new Error("tmux: no server")], AT - 30 * MIN + i * 1000);
    const [st] = l.recent(AT);
    expect(st!.times.length).toBe(d.ErrorLog.MAX_TIMES);
    expect(st!.samples.length).toBe(3);
    expect(d.errorFindings(l.recent(AT), AT)[0]!.details).toContain("100+ times");
  });

  test("console.error still prints, and what it prints is recorded", async () => {
    const printed: unknown[][] = [];
    const real = console.error;
    console.error = (...a: unknown[]) => void printed.push(a);
    try {
      d.watchErrors(Date.now() - 10 * MIN);
      console.error("[ansai] POST /api/things failed:", new Error("kaput"));
      console.error("[ansai] POST /api/things failed:", new Error("kaput"));
      expect(printed.length).toBe(2);
      const g = await d.gather(Date.now());
      expect(g.errors.find((e) => e.sig.includes("/api/things"))?.times.length).toBe(2);
    } finally {
      console.error = real;
    }
  });
});

describe("a task left in Doing", () => {
  const run = (o: Partial<DoingRun> = {}): DoingRun => ({ id: "s1", tool: "claude", status: "exited", exit_code: null, auto: 1, created_at: AT - 60 * MIN, ended_at: AT - 20 * MIN, ...o });
  const row = (o: Partial<DoingRow> = {}): DoingRow => ({ id: "t1", title: "Fix it", created_at: AT - 90 * MIN, updated_at: AT - 60 * MIN, attempts: 0, last_failure: null, runs: [run()], ...o });

  test("all its agents ended over 15 minutes ago and nobody touched it since", () => {
    const [f] = d.stuckDoing([row()], AT);
    expect(f!.key).toBe("stuck-doing");
    expect(f!.latest).toBe(AT - 20 * MIN);
    expect(f!.details).toContain("task t1");
    expect(f!.details).toContain("onExited");
  });

  test("not while an agent still runs, not too soon, and not without any agent run", () => {
    expect(d.stuckDoing([row({ runs: [run(), run({ id: "s2", status: "running", ended_at: null })] })], AT)).toEqual([]);
    expect(d.stuckDoing([row({ runs: [run({ ended_at: AT - 10 * MIN })] })], AT)).toEqual([]);
    expect(d.stuckDoing([row({ runs: [] })], AT)).toEqual([]);
  });

  test("not when the user moved or edited it after its agent ended, but yes when ansai created it in Doing afterwards", () => {
    expect(d.stuckDoing([row({ updated_at: AT - 18 * MIN })], AT)).toEqual([]);
    expect(d.stuckDoing([row({ created_at: AT - 18 * MIN, updated_at: AT - 18 * MIN })], AT)).toHaveLength(1);
  });

  test("several stuck tasks are one finding", () => {
    const [f] = d.stuckDoing([row(), row({ id: "t2", title: "Other" })], AT);
    expect(f!.title).toContain("2 tasks");
  });
});

describe("working with nothing on screen", () => {
  const row = (o: Partial<WorkingRow> = {}): WorkingRow => ({ id: "s1", title: "Agent", tool: "claude", task_id: "t1", agent_state_at: AT - 60 * MIN, agent_message: null, activity: AT - 25 * MIN, ...o });

  test("a pane quiet for 20 minutes while ansai shows the agent working", () => {
    const [f] = d.silentWorking([row({ screen: "❯ \n  ? for shortcuts" })], AT);
    expect(f!.key).toBe("silent-working");
    expect(f!.details).toContain("? for shortcuts");
    expect(f!.latest).toBe(AT - 25 * MIN);
  });

  test("not when the pane printed lately, when ansai hasn't seen the pane, or when the turn just started", () => {
    expect(d.silentWorking([row({ activity: AT - 5 * MIN })], AT)).toEqual([]);
    expect(d.silentWorking([row({ activity: null })], AT)).toEqual([]);
    expect(d.silentWorking([row({ agent_state_at: AT - 5 * MIN })], AT)).toEqual([]);
  });
});

describe("compaction never handed back", () => {
  const session = (o: Partial<NonNullable<PlanRow["session"]>> = {}) => ({ title: "Agent", status: "running", agent_state: "working", agent_state_at: AT - 30 * MIN, agent_message: null, ...o });
  const plan = (o: Partial<PlanRow> = {}): PlanRow => ({ sessionId: "s1", phase: "compacting", at: AT - 25 * MIN, sent: true, session: session(), ...o });

  test("compacting long past its 5-minute give-up", () => {
    const [f] = d.stuckCompactions([plan()], AT);
    expect(f!.key).toBe("compaction-stuck");
    expect(f!.details).toContain("/compact was typed");
    expect(d.stuckCompactions([plan({ at: AT - 10 * MIN })], AT)).toEqual([]);
  });

  test("asked for, then the turn ended and the agent sat idle", () => {
    const idle = session({ agent_state: "waiting", agent_state_at: AT - 22 * MIN });
    expect(d.stuckCompactions([plan({ phase: "asked", at: AT - 40 * MIN, session: idle })], AT)).toHaveLength(1);
    // Still working on the turn it asked in: nothing is late yet.
    expect(d.stuckCompactions([plan({ phase: "asked", at: AT - 40 * MIN })], AT)).toEqual([]);
    // You interrupted it: that turn is yours.
    expect(d.stuckCompactions([plan({ phase: "asked", at: AT - 40 * MIN, session: { ...idle, agent_message: "Interrupted" } })], AT)).toEqual([]);
    // Idle since before it asked: the ask came from an earlier state.
    expect(d.stuckCompactions([plan({ phase: "asked", at: AT - 10 * MIN, session: idle })], AT)).toEqual([]);
  });

  test("not for an agent that isn't running", () => {
    expect(d.stuckCompactions([plan({ session: session({ status: "exited" }) }), plan({ session: null })], AT)).toEqual([]);
  });
});

describe("schedules and shifts the clock passed by", () => {
  test("a schedule whose time passed half an hour ago without moving on", () => {
    expect(d.lateSchedules([{ id: "sc1", title: "Nightly", project_id: "p", next_at: AT - 40 * MIN }], AT)).toHaveLength(1);
    expect(d.lateSchedules([{ id: "sc1", title: "Nightly", project_id: "p", next_at: AT - 5 * MIN }], AT)).toEqual([]);
  });

  test("a shift past its end, or whose agent stopped, that is still active", () => {
    const sh = { session_id: "s1", until: AT + 60 * MIN, started_at: AT - 120 * MIN, title: "Agent", session_status: "running", session_ended_at: null };
    expect(d.overrunShifts([sh], AT)).toEqual([]);
    expect(d.overrunShifts([{ ...sh, until: AT - 15 * MIN }], AT)).toHaveLength(1);
    expect(d.overrunShifts([{ ...sh, session_status: "exited", session_ended_at: AT - 15 * MIN }], AT)).toHaveLength(1);
    expect(d.overrunShifts([{ ...sh, session_status: "exited", session_ended_at: AT - 2 * MIN }], AT)).toEqual([]);
  });
});

const clean = () => {
  db.exec("DELETE FROM task_reviews; DELETE FROM shifts; DELETE FROM sessions; DELETE FROM tasks; DELETE FROM schedules; DELETE FROM projects;");
  db.exec("DELETE FROM settings WHERE key LIKE 'doctor%' OR key LIKE 'compact-plan:%'");
};

describe("gathering from the database", () => {
  beforeEach(() => {
    clean();
    db.query("INSERT INTO projects (id, name, path, created_at) VALUES ('p', 'p', '/tmp/p', 0)").run();
  });
  afterAll(clean);

  const session = (id: string, o: { task?: string; title?: string; status?: string; state?: string | null; stateAt?: number; ended?: number | null } = {}) =>
    db
      .query(
        `INSERT INTO sessions (id, project_id, task_id, tool, title, cwd, argv, tmux_name, status, agent_state, agent_state_at, created_at, ended_at)
         VALUES (?, 'p', ?, 'claude', ?, '/tmp', '[]', ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, o.task ?? null, o.title ?? id, `ansai-${id}`, o.status ?? "exited", o.state ?? null, o.stateAt ?? null, AT - 120 * MIN, o.ended === undefined ? AT - 30 * MIN : o.ended);

  test("a stuck task is found; reviewer sessions don't count as its runs", async () => {
    db.query("INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) VALUES ('t1', 'p', 'Stuck', 'doing', ?, ?)").run(AT - 200 * MIN, AT - 100 * MIN);
    db.query("INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) VALUES ('t2', 'p', 'Only reviewed', 'doing', ?, ?)").run(AT - 200 * MIN, AT - 100 * MIN);
    session("s1", { task: "t1" });
    session("s2", { task: "t2", title: "Review · Only reviewed" });
    session("s3", { task: "t2" });
    db.query("INSERT INTO task_reviews (task_id, session_id, reviewer_tool, updated_at) VALUES ('t2', 's3', 'codex', 0)").run();
    const found = d.detect(await d.gather(AT), AT);
    expect(found.map((f) => f.key)).toEqual(["stuck-doing"]);
    expect(found[0]!.details).toContain("task t1");
    expect(found[0]!.details).not.toContain("task t2");
  });

  test("compaction plans come from settings, with their session", async () => {
    session("s1", { status: "running", state: "working", stateAt: AT - 30 * MIN, ended: null });
    setSetting("compact-plan:s1", { keep: "k", next: "n", phase: "compacting", at: AT - 30 * MIN, sent: true });
    const g = await d.gather(AT);
    expect(g.plans).toEqual([{ sessionId: "s1", phase: "compacting", at: AT - 30 * MIN, sent: true, session: expect.objectContaining({ status: "running" }) }]);
    // An agent mid-compaction is the compaction detector's, not a silent worker as well.
    expect(g.working).toEqual([]);
    expect(d.detect(g, AT).map((f) => f.key)).toEqual(["compaction-stuck"]);
  });

  test("a working agent whose pane ansai hasn't seen yet is left alone", async () => {
    session("s1", { status: "running", state: "working", stateAt: AT - 90 * MIN, ended: null });
    const g = await d.gather(AT);
    expect(g.working).toEqual([expect.objectContaining({ id: "s1", activity: null })]);
    expect(d.detect(g, AT)).toEqual([]);
  });
});

describe("filing", () => {
  beforeEach(() => {
    clean();
    db.query("INSERT INTO projects (id, name, path, created_at) VALUES ('ansai', 'ansai', ?, 0)").run(ROOT);
  });
  afterAll(clean);

  const finding = (key: string, o: Partial<Finding> = {}): Finding => ({ key, title: `Problem ${key}`, details: `Evidence for ${key}`, priority: 2, latest: AT - 10 * MIN, ...o });
  const doctorTasks = () => db.query("SELECT * FROM tasks WHERE title LIKE 'Doctor: %' ORDER BY created_at").all() as { id: string; title: string; body: string; priority: number; queued: number; source: string; status: string }[];

  test("a release folder's source checkout is its origin; a dev checkout is itself", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-"));
    try {
      const release = join(dir, "release");
      await gitOut(dir, ["init", "-q", release]);
      await gitOut(dir, ["init", "-q", join(dir, "dev")]);
      expect(d.sourceCheckouts(release)).toEqual([realpathSync(release)]);
      await gitOut(release, ["remote", "add", "origin", join(dir, "dev")]);
      expect(d.sourceCheckouts(release)).toEqual([realpathSync(join(dir, "dev")), realpathSync(release)]);
      await gitOut(release, ["remote", "set-url", "origin", "https://github.com/someone/ansai.git"]);
      expect(d.sourceCheckouts(release)).toEqual([realpathSync(release)]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ansai's project is the one at its source checkout, unless doctor:project says otherwise", () => {
    expect(d.doctorProject().id).toBe("ansai");
    db.query("INSERT INTO projects (id, name, path, created_at) VALUES ('other', 'other', '/tmp/other', 0)").run();
    setSetting("doctor:project", "other");
    expect(d.doctorProject().id).toBe("other");
    setSetting("doctor:project", "gone");
    expect(d.doctorProject()).toEqual({ id: null, why: expect.stringContaining("gone") });
  });

  test("a finding becomes an agent task with the evidence and what to do; queued only when autopilot is on", () => {
    const r = d.fileFindings([finding("a", { priority: 1 })], "ansai", AT);
    expect(r.filed).toEqual([expect.objectContaining({ key: "a", why: "new" })]);
    const [t] = doctorTasks();
    expect(t).toMatchObject({ title: "Doctor: Problem a", priority: 1, queued: 0, source: "agent", status: "todo" });
    expect(t!.body).toContain("Evidence for a");
    expect(t!.body).toContain("with a test that reproduces it");
    expect(t!.body).toContain("isn't an ansai bug");
    expect(t!.body).toContain("Never weaken a test or a doctor detector");

    db.query("UPDATE projects SET autopilot = ? WHERE id = 'ansai'").run(JSON.stringify({ on: true, tool: "claude", accountId: null, yolo: false }));
    d.fileFindings([finding("b")], "ansai", AT);
    expect(doctorTasks()[1]).toMatchObject({ title: "Doctor: Problem b", queued: 1 });
  });

  test("one open task per finding; after it is done, filed again only for a problem that began a day later", () => {
    d.fileFindings([finding("a")], "ansai", AT);
    const again = d.fileFindings([finding("a", { latest: AT + 60 * MIN })], "ansai", AT + 60 * MIN);
    expect(again.skipped).toEqual([expect.objectContaining({ key: "a", why: expect.stringContaining("still open") })]);

    const id = doctorTasks()[0]!.id;
    updateTask(id, { status: "done" });
    const doneAt = getTask(id)!.done_at!;
    // Still the same old problem, or one that came back within the day: not filed.
    expect(d.fileFindings([finding("a", { latest: AT })], "ansai", doneAt + 30 * 60 * MIN).filed).toEqual([]);
    expect(d.fileFindings([finding("a", { latest: doneAt + 2 * 60 * MIN })], "ansai", doneAt + 30 * 60 * MIN).filed).toEqual([]);
    // Began more than a day after the fix: a regression.
    const back = d.fileFindings([finding("a", { latest: doneAt + 25 * 60 * MIN })], "ansai", doneAt + 30 * 60 * MIN);
    expect(back.filed).toEqual([expect.objectContaining({ key: "a", why: "came back after its fix" })]);
    expect(doctorTasks()).toHaveLength(2);
  });

  test("deleting the task dismisses its finding for good", () => {
    d.fileFindings([finding("a")], "ansai", AT);
    expect(doctorTasks()[0]!.body).toContain("Delete this task instead to stop the doctor filing this finding");
    db.query("DELETE FROM tasks").run();
    const later = AT + 30 * 24 * 60 * MIN;
    const r = d.fileFindings([finding("a", { latest: later })], "ansai", later);
    expect(r.filed).toEqual([]);
    expect(r.skipped).toEqual([expect.objectContaining({ key: "a", why: "dismissed: its task was deleted" })]);
  });

  test("at most three new tasks a day, the most urgent first; the rest wait for a later run", () => {
    const four = [finding("low", { priority: 1 }), finding("a"), finding("b"), finding("c")];
    const r = d.fileFindings(four, "ansai", AT);
    expect(r.filed.map((f) => f.key)).toEqual(["a", "b", "c"]);
    expect(r.held).toEqual([expect.objectContaining({ key: "low", why: expect.stringContaining("daily limit of 3") })]);
    expect(d.fileFindings(four, "ansai", AT + 60 * MIN).held.map((f) => f.key)).toEqual(["low"]);
    expect(d.fileFindings(four, "ansai", AT + 24 * 60 * MIN).filed.map((f) => f.key)).toEqual(["low"]);
    setSetting("doctor:max_per_day", 0);
    expect(d.fileFindings([finding("z")], "ansai", AT + 50 * 60 * MIN).held).toHaveLength(1);
  });

  test("a dry run says what it would file and writes nothing", () => {
    const r = d.fileFindings([finding("a")], "ansai", AT, true);
    expect(r.filed).toEqual([expect.objectContaining({ key: "a" })]);
    expect(doctorTasks()).toEqual([]);
    expect(db.query("SELECT 1 FROM settings WHERE key LIKE 'doctor:seen:%'").get()).toBeNull();
  });

  test("switched off in Settings, a run does nothing; on, it files into ansai's project", async () => {
    db.query("INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) VALUES ('t1', 'ansai', 'Stuck', 'doing', ?, ?)").run(AT - 200 * MIN, AT - 100 * MIN);
    db.query(
      `INSERT INTO sessions (id, project_id, task_id, tool, title, cwd, argv, tmux_name, status, created_at, ended_at)
       VALUES ('s1', 'ansai', 't1', 'claude', 'Stuck', '/tmp', '[]', 'ansai-s1', 'exited', ?, ?)`,
    ).run(AT - 120 * MIN, AT - 30 * MIN);
    const logged: unknown[] = [];
    const real = console.log;
    console.log = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      updateSettings({ doctor: false });
      expect(await d.runDoctor(AT)).toBeNull();
      expect(doctorTasks()).toEqual([]);
      updateSettings({ doctor: true });
      const r = await d.runDoctor(AT);
      expect(r!.filed.map((f) => f.key)).toEqual(["stuck-doing"]);
      expect(doctorTasks()).toHaveLength(1);
      expect(logged).toEqual([expect.stringMatching(/^\[ansai\] doctor: 1 finding · filed stuck-doing \(t\w+\)$/)]);
    } finally {
      console.log = real;
    }
  });
});
