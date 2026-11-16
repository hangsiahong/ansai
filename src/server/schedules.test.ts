import { beforeEach, describe, expect, test } from "bun:test";

const { db, now } = await import("./db");
const { deleteSchedule, listSchedules, nextAt, saveSchedule, scheduleTick, setScheduleEnabled } = await import("./schedules");
const { autopilotTick, setTaskStarter, updateSettings } = await import("./autopilot");

const base = {
  title: "Morning triage", prompt: "Review open issues and summarize the top priorities.", tool: "codex" as const,
  cadence: "weekdays" as const, localTime: "09:00", timezone: "America/New_York",
};

beforeEach(() => {
  db.exec("DELETE FROM sessions; DELETE FROM schedule_occurrences; DELETE FROM tasks; DELETE FROM schedules; DELETE FROM projects;");
  db.query("INSERT INTO projects (id,name,path,created_at) VALUES ('p1','Project','/tmp/p1',0)").run();
});

describe("recurring schedules", () => {
  test("save and edit schedule choices and local timezone", () => {
    const s = saveSchedule("p1", null, base) as { id: string; timezone: string; tool: string };
    expect(s.timezone).toBe("America/New_York");
    expect(s.tool).toBe("codex");
    const updated = saveSchedule("p1", s.id, { ...base, title: "Updated triage", cadence: "daily" }) as { title: string; cadence: string };
    expect(updated).toMatchObject({ title: "Updated triage", cadence: "daily" });
  });

  test("pause and enable persist without deleting the schedule", () => {
    const s = saveSchedule("p1", null, base) as { id: string };
    setScheduleEnabled("p1", s.id, false);
    expect((listSchedules("p1")[0] as { enabled: number }).enabled).toBe(0);
    setScheduleEnabled("p1", s.id, true);
    expect((listSchedules("p1")[0] as { enabled: number }).enabled).toBe(1);
  });

  test("a due occurrence creates one distinct task and delayed ticks do not duplicate it", () => {
    const s = saveSchedule("p1", null, base) as { id: string };
    const due = now() - 60_000;
    db.query("UPDATE schedules SET next_at=? WHERE id=?").run(due, s.id);
    expect(scheduleTick(now() + 1)).toBe(1);
    expect(scheduleTick(now() + 2)).toBe(0);
    const runs = db.query("SELECT o.task_id,t.title,t.body,o.status FROM schedule_occurrences o JOIN tasks t ON t.id=o.task_id WHERE o.schedule_id=?").all(s.id) as { task_id: string; title: string; body: string; status: string }[];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ title: base.title, body: base.prompt, status: "needs_attention" });
  });

  test("delete removes future schedule but keeps its reviewable task occurrence", () => {
    const s = saveSchedule("p1", null, base) as { id: string };
    db.query("INSERT INTO tasks (id,project_id,title,created_at,updated_at) VALUES ('t1','p1','Run',0,0)").run();
    db.query("INSERT INTO schedule_occurrences (id,schedule_id,scheduled_for,task_id,status,created_at) VALUES ('o1',?,1,'t1','completed',1)").run(s.id);
    deleteSchedule("p1", s.id);
    expect(db.query("SELECT id FROM schedules WHERE id=?").get(s.id)).toBeNull();
    expect(db.query("SELECT task_id,schedule_id FROM schedule_occurrences WHERE id='o1'").get()).toEqual({ task_id: "t1", schedule_id: null });
  });

  test("scheduled starts use the saved agent/model and wait for the global run limit", async () => {
    db.query("INSERT INTO projects (id,name,path,autopilot,created_at) VALUES ('p2','Busy','/tmp/p2',?,0)").run(JSON.stringify({ on: true, tool: "claude", accountId: null, yolo: false }));
    db.query("UPDATE projects SET autopilot=? WHERE id='p1'").run(JSON.stringify({ on: true, tool: "claude", accountId: null, yolo: false }));
    const s = saveSchedule("p1", null, { ...base, model: "gpt-test", effort: "high" }) as { id: string };
    db.query("UPDATE schedules SET next_at=? WHERE id=?").run(now() - 60_000, s.id);
    scheduleTick();
    db.query("INSERT INTO tasks (id,project_id,title,status,created_at,updated_at) VALUES ('busy','p2','Busy','doing',0,0)").run();
    db.query(`INSERT INTO sessions (id,project_id,task_id,tool,title,cwd,argv,tmux_name,status,created_at,auto)
      VALUES ('busy-session','p2','busy','claude','Busy','/tmp','[]','busy-session','running',0,1)`).run();
    updateSettings({ autopilotMax: 1 });
    let started: { tool: string; model?: string | null; effort?: string | null } | null = null;
    setTaskStarter((async (_id: string, options: { tool: string; model?: string | null; effort?: string | null }) => { started = options; return {} as never; }) as never);
    await autopilotTick();
    expect(started).toBeNull();
    expect((db.query("SELECT status FROM schedule_occurrences WHERE schedule_id=?").get(s.id) as { status: string }).status).toBe("queued");
    db.query("DELETE FROM sessions WHERE id='busy-session'").run();
    await autopilotTick();
    expect(started).toMatchObject({ tool: "codex", model: "gpt-test", effort: "high" });
  });
});

const { runScheduleNow } = await import("./schedules");

describe("weekly days and manual runs", () => {
  const dayOf = (ts: number) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(ts);
  const weekly = { ...base, cadence: "weekly" as const };

  test("a weekly schedule runs on the day you pick, and keeps it when edited", () => {
    const s = saveSchedule("p1", null, { ...weekly, weekday: "Thu" }) as { id: string; next_at: number };
    expect(dayOf(s.next_at)).toBe("Thu");
    const edited = saveSchedule("p1", s.id, { ...weekly, title: "Renamed" }) as { next_at: number };
    expect(dayOf(edited.next_at)).toBe("Thu"); // used to move to the day of the edit
    const moved = saveSchedule("p1", s.id, { ...weekly, weekday: "Sat" }) as { next_at: number };
    expect(dayOf(moved.next_at)).toBe("Sat");
    expect(() => saveSchedule("p1", s.id, { ...weekly, weekday: "Funday" })).toThrow(/weekday/);
  });

  test("Run now is filed under when it ran, not under the next slot", () => {
    const s = saveSchedule("p1", null, base) as { id: string; next_at: number };
    const before = now();
    runScheduleNow("p1", s.id);
    const o = db.query("SELECT scheduled_for FROM schedule_occurrences WHERE schedule_id = ?").get(s.id) as { scheduled_for: number };
    expect(o.scheduled_for).toBeGreaterThanOrEqual(before);
    expect(o.scheduled_for).toBeLessThan(s.next_at);
  });
});

const { finishTask } = await import("./tasks");
const { handleHook } = await import("./hooks");

describe("what a scheduled run's history says when its agent's turn ends", () => {
  /** A scheduled run whose agent is mid-turn on the task. */
  function working(sid: string) {
    const s = saveSchedule("p1", null, { ...base, title: `Run ${sid}` }) as { id: string };
    const task = runScheduleNow("p1", s.id);
    db.query("UPDATE tasks SET status='doing' WHERE id=?").run(task.id);
    db.query("UPDATE schedule_occurrences SET status='running', outcome=NULL WHERE task_id=?").run(task.id);
    db.query(`INSERT INTO sessions (id,project_id,task_id,tool,title,cwd,argv,tmux_name,status,agent_state,created_at,auto)
      VALUES (?,'p1',?,'claude','Run','/tmp','[]',?,'running','working',0,1)`).run(sid, task.id, `ansai-${sid}`);
    return task.id;
  }
  const occurrence = (taskId: string) => db.query("SELECT status,outcome FROM schedule_occurrences WHERE task_id=?").get(taskId) as { status: string; outcome: string | null };

  test("the summary the agent gave stays as the result, not \"Finished — your turn.\"", () => {
    const taskId = working("sched-done");
    finishTask(taskId, "Found 3 stale issues; closed 2 and left a note on the third.");
    handleHook("claude", "Stop", "sched-done", {});
    expect(occurrence(taskId)).toEqual({ status: "completed", outcome: "Found 3 stale issues; closed 2 and left a note on the third." });
  });

  test("a long summary is cut to 1000 characters", () => {
    const taskId = working("sched-long");
    finishTask(taskId, "x".repeat(1500));
    handleHook("claude", "Stop", "sched-long", {});
    expect(occurrence(taskId)).toEqual({ status: "completed", outcome: "x".repeat(1000) });
  });

  test("a turn that ends without a summary needs you, and says it finished", () => {
    const taskId = working("sched-none");
    handleHook("claude", "Stop", "sched-none", {});
    expect(occurrence(taskId)).toEqual({ status: "needs_attention", outcome: "Finished — your turn." });
  });
});

// New York clocks go forward on 14 March 2027 (02:00 becomes 03:00) and back on 7 November 2027.
describe("days the clocks change", () => {
  const NY = "America/New_York";
  const at = (iso: string) => Date.parse(iso);

  test("an ordinary day is unchanged", () => {
    expect(nextAt(at("2027-03-10T17:00:00Z"), "09:00", NY, "daily")).toBe(at("2027-03-11T14:00:00Z"));
    expect(nextAt(at("2027-03-10T13:59:00Z"), "09:00", NY, "daily")).toBe(at("2027-03-10T14:00:00Z"));
    expect(nextAt(at("2027-03-12T14:00:00Z"), "09:00", NY, "weekdays", undefined, "2027-03-12")).toBe(at("2027-03-15T13:00:00Z"));
  });

  test("a weekly run at a time the clocks skip happens right after the jump (it used to throw on every tick)", () => {
    const lastSunday = at("2027-03-07T07:30:00Z"); // 02:30 EST
    expect(nextAt(lastSunday, "02:30", NY, "weekly", "Sun", "2027-03-07")).toBe(at("2027-03-14T07:00:00Z")); // 03:00 EDT
    // and the week after it is back at 02:30
    expect(nextAt(at("2027-03-14T07:00:00Z"), "02:30", NY, "weekly", "Sun", "2027-03-14")).toBe(at("2027-03-21T06:30:00Z"));
  });

  test("a daily run at a skipped time isn't dropped for that day", () => {
    expect(nextAt(at("2027-03-13T07:30:00Z"), "02:30", NY, "daily", undefined, "2027-03-13")).toBe(at("2027-03-14T07:00:00Z"));
  });

  test("a time that comes twice when clocks go back runs once", () => {
    const first = nextAt(at("2027-11-06T05:30:00Z"), "01:30", NY, "daily", undefined, "2027-11-06");
    expect(first).toBe(at("2027-11-07T05:30:00Z")); // the first 01:30 (EDT)
    expect(nextAt(first, "01:30", NY, "daily", undefined, "2027-11-07")).toBe(at("2027-11-08T06:30:00Z"));
  });

  test("one schedule that can't run doesn't stop the others", () => {
    const broken = saveSchedule("p1", null, { ...base, title: "Broken" }) as { id: string };
    const fine = saveSchedule("p1", null, { ...base, title: "Fine" }) as { id: string };
    db.query("UPDATE schedules SET next_at=?, timezone='Nowhere/Nope' WHERE id=?").run(now() - 120_000, broken.id);
    db.query("UPDATE schedules SET next_at=? WHERE id=?").run(now() - 60_000, fine.id);
    expect(() => scheduleTick()).not.toThrow();
    const ran = db.query("SELECT schedule_id FROM schedule_occurrences").all() as { schedule_id: string }[];
    expect(ran.map((r) => r.schedule_id)).toEqual([fine.id]);
    expect(db.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 }); // the broken one left no half-made task
  });
});
