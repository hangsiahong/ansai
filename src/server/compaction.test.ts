// Agent-timed compaction: ansai tells a long-running Claude its size, the agent calls
// the compact tool at a good stopping point, and ansai compacts it and hands it its
// next step, so autonomous work carries on without the user. No tmux: typing is captured.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const { db, now } = await import("./db");
const { handleHook } = await import("./hooks");
const { mcpHttp } = await import("./mcp");
const compaction = await import("./compaction");
const team = await import("./team");
const { getSession } = await import("./sessions");
const { subscribeChat, unsubscribeChat } = await import("./transcripts");

const typed: [string, string][] = [];
const saved = { ...compaction.timing };
beforeAll(() => {
  compaction.setSender(async (id, text) => void typed.push([id, text]));
  Object.assign(compaction.timing, { afterStop: 5, afterCompact: 5, giveUp: 60_000 });
  db.query("INSERT OR IGNORE INTO projects (id, name, path, created_at) VALUES ('cp', 'cp', '/tmp/cp', 0)").run();
});
afterAll(() => Object.assign(compaction.timing, saved));
beforeEach(() => {
  typed.length = 0;
  for (const { id } of db.query("SELECT id FROM sessions").all() as { id: string }[]) compaction.dropCompaction(id);
  db.exec("DELETE FROM messages; DELETE FROM sessions; DELETE FROM tasks;");
});

const settle = () => Bun.sleep(30);
function agent(id: string, o: { tool?: string; task?: string; transcript?: string } = {}) {
  if (o.task) db.query("INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) VALUES (?, 'cp', 'Build it', 'doing', 0, 0)").run(o.task);
  db.query(
    `INSERT INTO sessions (id, project_id, task_id, tool, title, cwd, argv, tmux_name, status, agent_state, created_at, msg_cursor, transcript)
     VALUES (?, 'cp', ?, ?, ?, '/tmp', '[]', ?, 'running', 'working', ?, (SELECT COALESCE(MAX(id), 0) FROM messages), ?)`,
  ).run(id, o.task ?? null, o.tool ?? "claude", `Agent ${id}`, `ansai-${id}`, now(), o.transcript ?? null);
}
const state = (id: string) => db.query("SELECT agent_state, agent_message FROM sessions WHERE id = ?").get(id) as { agent_state: string; agent_message: string | null };
const taskStatus = (id: string) => (db.query("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string }).status;
async function listTools(session: string) {
  const res = await mcpHttp(
    new Request(`http://127.0.0.1/mcp?s=${session}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }),
  );
  return ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools;
}
async function compactTool(session: string, args: object) {
  const res = await mcpHttp(
    new Request(`http://127.0.0.1/mcp?s=${session}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "compact", arguments: args } }),
    }),
  );
  return ((await res.json()) as { result: { content: { text: string }[]; isError: boolean } }).result;
}

describe("telling the agent its size", () => {
  test("past 150k it hears once per mark, between steps", async () => {
    const file = join(process.env.ANSAI_HOME!, `compaction-${crypto.randomUUID()}.jsonl`);
    const usage = { input_tokens: 5, cache_read_input_tokens: 160_000, cache_creation_input_tokens: 0, output_tokens: 100 };
    writeFileSync(file, JSON.stringify({ type: "assistant", uuid: "a1", timestamp: new Date().toISOString(), message: { model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "ok" }], usage } }) + "\n");
    agent("n1", { transcript: file });
    const ws = { readyState: 1, send: () => {} };
    await subscribeChat("n1", ws as never); // the tail that follows its log
    try {
      expect(handleHook("claude", "PostToolUse", "n1", {})).toBeUndefined(); // started before ansai had the tool: no note
      await listTools("n1");
      const note = handleHook("claude", "PostToolUse", "n1", {})?.hookSpecificOutput?.additionalContext ?? "";
      expect(note).toContain("160k tokens");
      expect(note).toContain("compact tool");
      expect(handleHook("claude", "PostToolUse", "n1", {})).toBeUndefined(); // not again at the same mark
    } finally {
      unsubscribeChat("n1", ws as never);
    }
  });
});

describe("the compact tool", () => {
  test("its turn ends in a compaction, not a finished task; then it gets its next step", async () => {
    agent("c1", { task: "t1" });
    const r = await compactTool("c1", { keep: "Task t1: build the parser.\nDone: lexer (committed).", next: "Write the parser tests." });
    expect(r.isError).toBe(false);
    expect(r.content[0]!.text).toContain("Compaction queued");

    expect(handleHook("claude", "Stop", "c1", {})).toBeUndefined(); // the turn ends…
    expect(state("c1")).toEqual({ agent_state: "working", agent_message: "Compacting the conversation" }); // …but it isn't "done"
    expect(taskStatus("t1")).toBe("doing");
    await settle();
    expect(typed).toEqual([["c1", "/compact Task t1: build the parser. Done: lexer (committed)."]]);

    handleHook("claude", "PreCompact", "c1", { trigger: "manual" });
    handleHook("claude", "SessionStart", "c1", { source: "compact" });
    expect(state("c1").agent_state).toBe("working");
    await settle();
    expect(typed[1]![1]).toBe("ansai: your conversation was compacted, as you asked. Carry on: Write the parser tests.");
    expect(taskStatus("t1")).toBe("doing");
  });

  test("with no next step it waits for you afterwards, like any finished turn", async () => {
    agent("c2", { task: "t2" });
    await compactTool("c2", { keep: "the plan" });
    handleHook("claude", "Stop", "c2", {});
    await settle();
    handleHook("claude", "SessionStart", "c2", { source: "compact" });
    await settle();
    expect(typed.map((t) => t[1])).toEqual(["/compact the plan"]);
    expect(state("c2").agent_state).toBe("waiting");
    expect(taskStatus("t2")).toBe("review");
  });

  test("a long note is cut to what Claude Code still takes as a typed command, and comes back in full with the next step", async () => {
    agent("c6");
    const keep = `${"Keep the plan. ".repeat(60)}\nIds: t523w5g6k18, src/server/late-file.ts`;
    const r = await compactTool("c6", { keep, next: "carry on" });
    expect(r.content[0]!.text).toContain(`Your note is ${keep.length} characters`);
    handleHook("claude", "Stop", "c6", {});
    await settle();
    const cmd = typed[0]![1];
    expect(cmd.startsWith("/compact Keep the plan.")).toBe(true);
    expect(cmd.length).toBeLessThanOrEqual("/compact ".length + compaction.KEEP_MAX);
    expect(cmd).not.toContain("\n");
    expect(cmd).not.toContain("t523w5g6k18");

    handleHook("claude", "SessionStart", "c6", { source: "compact" });
    await settle();
    expect(typed[1]![1]).toBe(`ansai: your conversation was compacted, as you asked. Your notes from before compacting, in full (only their start fit after /compact):\n${keep}\n\nCarry on: carry on`);
  });

  test("a note that fits after /compact isn't repeated, and a long one isn't sent back when the compaction didn't happen", async () => {
    agent("c7");
    await compactTool("c7", { keep: "x ".repeat(300), next: "go" });
    handleHook("claude", "Stop", "c7", {});
    await settle();
    handleHook("claude", "SessionStart", "c7", { source: "compact" });
    await settle();
    expect(typed[1]![1]).toBe("ansai: your conversation was compacted, as you asked. Carry on: go");

    typed.length = 0;
    await compactTool("c7", { keep: "y ".repeat(400), next: "go" });
    handleHook("claude", "Stop", "c7", {});
    await settle();
    compaction.compacted("c7", "failed");
    await settle();
    expect(typed[1]![1]).toBe("ansai: the compaction you asked for didn't happen, so your conversation is as it was. Carry on: go");
  });

  test("if the compaction never reports back, the agent still gets its next step", async () => {
    compaction.timing.giveUp = 40;
    try {
      agent("c3");
      await compactTool("c3", { keep: "k", next: "keep going" });
      handleHook("claude", "Stop", "c3", {});
      await Bun.sleep(80);
      expect(typed[1]![1]).toBe("ansai: the compaction you asked for didn't happen, so your conversation is as it was. Carry on: keep going");
    } finally {
      compaction.timing.giveUp = 60_000;
    }
  });

  test("a turn that ends without asking is a normal end of turn", () => {
    agent("c4", { task: "t4" });
    handleHook("claude", "Stop", "c4", {});
    expect(state("c4").agent_state).toBe("waiting");
    expect(taskStatus("t4")).toBe("review");
  });

  test("it needs something to keep, and only Claude can use it", async () => {
    agent("c5");
    expect((await compactTool("c5", { keep: "  " })).isError).toBe(true);
    agent("x1", { tool: "codex" });
    expect((await compactTool("x1", { keep: "k" })).content[0]!.text).toContain("Only Claude agents");
  });
});

// ansai is restarted while agents work (every update does it). resumeCompactions() is what
// a fresh start runs: it forgets what was in memory and reads the plans back from the database.
describe("ansai restarts in the middle", () => {
  const planSaved = (id: string) => !!db.query("SELECT 1 FROM settings WHERE key = ?").get(`compact-plan:${id}`);

  test("a compaction asked for before the restart still happens when the turn ends", async () => {
    agent("r1", { task: "tr1" });
    await compactTool("r1", { keep: "the plan", next: "Write the tests." });
    compaction.resumeCompactions();

    expect(handleHook("claude", "Stop", "r1", {})).toBeUndefined();
    expect(state("r1")).toEqual({ agent_state: "working", agent_message: "Compacting the conversation" });
    expect(taskStatus("tr1")).toBe("doing");
    await settle();
    expect(typed).toEqual([["r1", "/compact the plan"]]);
  });

  test("one already running still hands the agent its next step, and /compact isn't typed twice", async () => {
    agent("r2", { task: "tr2" });
    await compactTool("r2", { keep: "the plan", next: "Write the tests." });
    handleHook("claude", "Stop", "r2", {});
    await settle();
    compaction.resumeCompactions();
    await settle();
    expect(typed.map((t) => t[1])).toEqual(["/compact the plan"]);

    handleHook("claude", "SessionStart", "r2", { source: "compact" });
    await settle();
    expect(typed[1]![1]).toBe("ansai: your conversation was compacted, as you asked. Carry on: Write the tests.");
    expect(taskStatus("tr2")).toBe("doing");
    expect(planSaved("r2")).toBe(false);
  });

  test("a restart before /compact was typed types it afterwards, once", async () => {
    agent("r3");
    await compactTool("r3", { keep: "the plan", next: "go on" });
    handleHook("claude", "Stop", "r3", {});
    compaction.resumeCompactions(); // before the pause that lets Claude get back to its prompt
    await settle();
    expect(typed.map((t) => t[1])).toEqual(["/compact the plan"]);
  });

  test("if the compaction's report was lost while ansai was down, the agent still gets its next step, told so", async () => {
    compaction.timing.giveUp = 40;
    try {
      agent("r4");
      await compactTool("r4", { keep: "k", next: "keep going" });
      handleHook("claude", "Stop", "r4", {});
      await settle();
      compaction.resumeCompactions();
      await Bun.sleep(80);
      expect(typed[1]![1]).toBe("ansai: ansai was restarted while your conversation was being compacted, so it can't tell whether that finished. Carry on: keep going");
    } finally {
      compaction.timing.giveUp = 60_000;
    }
  });

  test("the turn ended while ansai was down: the compaction starts when Claude says it's idle", async () => {
    agent("r5", { task: "tr5" });
    await compactTool("r5", { keep: "the plan", next: "go on" });
    compaction.resumeCompactions();
    handleHook("claude", "Notification", "r5", { notification_type: "idle_prompt", message: "Claude is waiting for your input" });
    expect(state("r5")).toEqual({ agent_state: "working", agent_message: "Compacting the conversation" });
    expect(taskStatus("tr5")).toBe("doing");
    await settle();
    expect(typed).toEqual([["r5", "/compact the plan"]]);
  });

  test("the plan of an agent that ended meanwhile is dropped", async () => {
    agent("r6");
    await compactTool("r6", { keep: "the plan", next: "go on" });
    expect(planSaved("r6")).toBe(true);
    db.query("UPDATE sessions SET status = 'exited' WHERE id = 'r6'").run();
    compaction.resumeCompactions();
    expect(planSaved("r6")).toBe(false);
    expect(compaction.compactionAsked("r6")).toBe(false);
  });
});

describe("other compactions", () => {
  test("Claude's own, mid-turn, leaves it working", () => {
    agent("o1");
    handleHook("claude", "PreCompact", "o1", { trigger: "auto" });
    expect(state("o1").agent_message).toBe("Compacting the conversation");
    handleHook("claude", "SessionStart", "o1", { source: "compact" });
    expect(state("o1").agent_state).toBe("working");
  });

  test("yours ends waiting for you, and team messages don't ride along into /compact", () => {
    agent("o2");
    agent("o3");
    team.postMessage({ from: getSession("o3")!, to: "o2", body: "heads up: main moved" });
    expect(handleHook("claude", "UserPromptSubmit", "o2", { prompt: "/compact keep the API notes" })).toBeUndefined();
    handleHook("claude", "PreCompact", "o2", { trigger: "manual" });
    handleHook("claude", "SessionStart", "o2", { source: "compact" });
    expect(state("o2").agent_state).toBe("waiting");
    expect(team.takePending("o2")).toContain("main moved"); // still queued for its next turn
  });
});
