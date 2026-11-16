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
