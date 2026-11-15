import { beforeEach, describe, expect, test } from "bun:test";

const { db, now } = await import("./db");
const { deleteSchedule, listSchedules, saveSchedule, scheduleTick, setScheduleEnabled } = await import("./schedules");
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
