// Team messaging: delivery cursor, who gets what, wake rules, rate limit, and
// the hook/MCP surfaces. Runs against a throwaway ANSAI_HOME (no tmux needed).
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

const { db, now } = await import("./db");
const team = await import("./team");
const { handleHook } = await import("./hooks");
const { mcpHttp } = await import("./mcp");
const { getSession } = await import("./sessions");


function project(id: string) {
  db.query("INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)").run(id, id, `/tmp/${id}`, now());
}
// Agents default to "working": idle ("waiting") ones would get messages typed in via tmux.
function agent(id: string, projectId: string | null, o: { tool?: string; state?: string | null; task?: string | null } = {}) {
  db.query(
    `INSERT INTO sessions (id, project_id, task_id, tool, title, cwd, argv, tmux_name, status, agent_state, created_at, msg_cursor)
     VALUES (?, ?, ?, ?, ?, '/tmp', '[]', ?, 'running', ?, ?, (SELECT COALESCE(MAX(id), 0) FROM messages))`,
  ).run(id, projectId, o.task ?? null, o.tool ?? "claude", `Agent ${id}`, `ansai-${id}`, o.state ?? "working", now());
  return getSession(id)!;
}

beforeAll(() => {
  project("p1");
  project("p2");
});
beforeEach(() => {
  db.exec("DELETE FROM messages; DELETE FROM sessions; DELETE FROM tasks;");
});

describe("delivery", () => {
  test("a direct message is delivered once, then the inbox is empty", () => {
    const a = agent("a", "p1");
    agent("b", "p1");
    team.postMessage({ from: a, to: "b", body: "rebase on main please" });
    const text = team.takePending("b");
    expect(text).toContain("rebase on main please");
    expect(text).toContain("agent id a");
    expect(team.takePending("b")).toBeNull();
    const m = db.query("SELECT delivered_at FROM messages").get() as { delivered_at: number | null };
    expect(m.delivered_at).not.toBeNull();
  });

  test("a broadcast reaches everyone in the project except the sender, and no one elsewhere", () => {
    const a = agent("a", "p1");
    agent("b", "p1");
    agent("c", "p1");
    agent("x", "p2");
    team.postMessage({ from: a, to: "all", body: "I changed the API" });
    expect(team.takePending("b")).toContain("to everyone in this project");
    expect(team.takePending("c")).toContain("I changed the API");
    expect(team.takePending("a")).toBeNull();
    expect(team.takePending("x")).toBeNull();
  });

  test("agents that start later don't get the project's old messages", () => {
    const a = agent("a", "p1");
    agent("b", "p1");
    team.postMessage({ from: a, to: "all", body: "old news" });
    agent("late", "p1");
    expect(team.takePending("late")).toBeNull();
  });

  test("a unique id suffix is accepted, and bad targets are refused", () => {
    const a = agent("aaaa1", "p1");
    agent("bbbb2", "p1");
    expect(team.postMessage({ from: a, to: "bbb2", body: "hi" }).to_session).toBe("bbbb2");
    expect(() => team.postMessage({ from: a, to: "nobody", body: "hi" })).toThrow(/no agent/);
    expect(() => team.postMessage({ from: a, to: "aaaa1", body: "hi" })).toThrow(/that's you/);
    agent("shell1", "p1", { tool: "shell" });
    expect(() => team.postMessage({ from: a, to: "shell1", body: "hi" })).toThrow(/can't receive/);
  });
});

describe("waking idle agents", () => {
  test("direct messages and the user's broadcasts wake; agents' broadcasts wait", () => {
    const a = agent("a", "p1");
    const b = agent("b", "p1");
    team.postMessage({ from: a, to: "all", body: "fyi" });
    expect(team.wakes(getSession("b")!)).toBe(false);
    team.postMessage({ from: null, projectId: "p1", body: "everyone: stop and commit" });
    expect(team.wakes(getSession("b")!)).toBe(true);
    team.takePending(b.id);
    team.postMessage({ from: a, to: "b", body: "direct" });
    expect(team.wakes(getSession("b")!)).toBe(true);
  });
});

describe("rate limit", () => {
  test("an agent can send 12 messages per 10 minutes", () => {
    const a = agent("a", "p1");
    agent("b", "p1");
    for (let i = 0; i < 12; i++) team.postMessage({ from: a, to: "b", body: `m${i}` });
    expect(() => team.postMessage({ from: a, to: "b", body: "one too many" })).toThrow(/limit/);
    // You aren't limited.
    expect(team.postMessage({ from: null, to: "b", body: "from you" }).from_session).toBeNull();
  });
});

describe("hooks", () => {
  test("PostToolUse hands pending messages over as additionalContext", () => {
    const a = agent("a", "p1");
    agent("b", "p1", { state: "working" });
    expect(handleHook("claude", "PostToolUse", "b", {})).toBeUndefined();
    team.postMessage({ from: a, to: "b", body: "watch out for src/x.ts" });
    const out = handleHook("claude", "PostToolUse", "b", {});
    expect(out?.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out?.hookSpecificOutput.additionalContext).toContain("watch out for src/x.ts");
    expect(handleHook("claude", "PostToolUse", "b", {})).toBeUndefined();
  });

  test("Stop with pending messages keeps the agent working instead of handing the task back", () => {
    const a = agent("a", "p1");
    db.query("INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) VALUES ('t1', 'p1', 'T', 'doing', 0, 0)").run();
    agent("b", "p1", { state: "working", task: "t1" });
    team.postMessage({ from: a, to: "b", body: "one more thing" });
    const out = handleHook("claude", "Stop", "b", {});
    expect(out?.hookSpecificOutput.additionalContext).toContain("one more thing");
    expect(getSession("b")!.agent_state).toBe("working");
    expect((db.query("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }).status).toBe("doing");
    // Next Stop has nothing pending: the turn really ends.
    expect(handleHook("claude", "Stop", "b", {})).toBeUndefined();
    expect(getSession("b")!.agent_state).toBe("waiting");
    expect((db.query("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }).status).toBe("review");
  });
});

describe("MCP tools", () => {
  const call = async (session: string, name: string, args: object) => {
    const res = await mcpHttp(
      new Request(`http://127.0.0.1/mcp?s=${session}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }),
    );
    expect(res.status).toBe(200); // failures are tool results, never HTTP errors
    return ((await res.json()) as { result: { content: { text: string }[]; isError: boolean } }).result;
  };

  test("send_message, list_agents and read_messages", async () => {
    agent("a", "p1");
    agent("b", "p1");
    const sent = await call("a", "send_message", { to: "b", message: "hello b" });
    expect(sent.isError).toBe(false);
    const list = await call("a", "list_agents", {});
    expect(list.content[0]!.text).toContain("id b");
    expect(list.content[0]!.text).toContain("same as yours");
    const read = await call("b", "read_messages", {});
    expect(read.content[0]!.text).toContain("hello b");
  });

  test("a bad recipient comes back as a tool error", async () => {
    agent("a", "p1");
    const r = await call("a", "send_message", { to: "ghost", message: "hi" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("list_agents");
  });
});
