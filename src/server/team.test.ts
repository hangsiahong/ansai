// Team messaging: delivery cursor, who gets what, wake rules, rate limit, and
// the hook/MCP surfaces. Runs against a throwaway ANSAI_HOME (no tmux needed).
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

const { db, now } = await import("./db");
const team = await import("./team");
const { handleHook } = await import("./hooks");
const { mcpHttp } = await import("./mcp");
const { getSession } = await import("./sessions");
const { listTasks } = await import("./tasks");


function project(id: string) {
  db.query("INSERT OR IGNORE INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)").run(id, id, `/tmp/${id}`, now());
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
  // Claims are keyed by session: clear them with the sessions.
  for (const { id } of db.query("SELECT id FROM sessions").all() as { id: string }[]) team.dropClaims(id);
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

describe("when typing in is safe", () => {
  test("a finished turn, a still screen, and never mid-turn, at an approval, or unseen", () => {
    expect(team.isIdle({ tool: "claude", agent_state: "waiting" }, 5000)).toBe(true);
    expect(team.isIdle({ tool: "claude", agent_state: "waiting" }, 1000)).toBe(false); // still redrawing
    expect(team.isIdle({ tool: "claude", agent_state: "working" }, 60_000)).toBe(false); // hooks deliver instead
    expect(team.isIdle({ tool: "claude", agent_state: "needs-input" }, 60_000)).toBe(false);
    expect(team.isIdle({ tool: "claude", agent_state: null }, 60_000)).toBe(false); // e.g. on a startup dialog
    expect(team.isIdle({ tool: "codex", agent_state: "waiting" }, 5000)).toBe(true);
    // Codex before its first finished turn: only once the screen has been still a while.
    expect(team.isIdle({ tool: "codex", agent_state: null }, 4000)).toBe(false);
    expect(team.isIdle({ tool: "codex", agent_state: null }, 12_000)).toBe(true);
    expect(team.isIdle({ tool: "codex", agent_state: null }, null)).toBe(false);
  });
});

describe("not waking for nothing", () => {
  test("Stop only keeps an agent going for direct messages or yours, not agents' broadcasts", () => {
    const a = agent("a", "p1");
    agent("b", "p1", { state: "working" });
    team.postMessage({ from: a, to: "all", body: "fyi: renamed util.ts" });
    expect(handleHook("claude", "Stop", "b", {})).toBeUndefined(); // it stops; the broadcast waits
    expect(getSession("b")!.agent_state).toBe("waiting");
    // ...and arrives with its next turn.
    expect(handleHook("claude", "UserPromptSubmit", "b", {})?.hookSpecificOutput?.additionalContext).toContain("renamed util.ts");
  });

  test("finished or long-idle agents aren't woken; the sender is told", () => {
    db.query("INSERT INTO tasks (id, project_id, title, status, summary, created_at, updated_at) VALUES ('done1', 'p1', 'T', 'review', 'all done', 0, 0)").run();
    const a = agent("a", "p1");
    const b = agent("b", "p1", { state: "waiting", task: "done1" });
    expect(team.holdReason(b, 5000)).toBe("its task is finished");
    expect(team.holdReason(a, 56 * 60_000)).toBe("it has been idle for over 55 minutes");
    expect(team.holdReason(a, 60_000)).toBeNull();
    expect(team.deliveryNote(b)).toContain("won't be woken");
    expect(team.deliveryNote(agent("w", "p1", { state: "working" }))).toContain("between steps");
  });
});

describe("your direct messages always wake", () => {
  test("a finished agent is woken for your review, but not for a teammate's message", () => {
    db.query("INSERT INTO tasks (id, project_id, title, status, summary, created_at, updated_at) VALUES ('fin', 'p1', 'T', 'review', 'done', 0, 0)").run();
    const a = agent("a", "p1");
    agent("b", "p1", { state: "waiting", task: "fin" });
    team.postMessage({ from: a, to: "b", body: "fyi" });
    expect(team.shouldType(getSession("b")!, 10_000)).toBe(false); // held: its task is finished
    team.postMessage({ from: null, to: "b", body: "Review: rename add to sum" });
    expect(team.shouldType(getSession("b")!, 10_000)).toBe(true);
    expect(team.shouldType(getSession("b")!, 1000)).toBe(false); // but never while its screen is moving
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
    expect(out?.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
    expect(out?.hookSpecificOutput?.additionalContext).toContain("watch out for src/x.ts");
    expect(handleHook("claude", "PostToolUse", "b", {})).toBeUndefined();
  });

  test("Stop with pending messages keeps the agent working instead of handing the task back", () => {
    const a = agent("a", "p1");
    db.query("INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) VALUES ('t1', 'p1', 'T', 'doing', 0, 0)").run();
    agent("b", "p1", { state: "working", task: "t1" });
    team.postMessage({ from: a, to: "b", body: "one more thing" });
    const out = handleHook("claude", "Stop", "b", {});
    expect(out?.hookSpecificOutput?.additionalContext).toContain("one more thing");
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

  test("independent reviewer findings are stored and finish_review preserves the user Review gate", async () => {
    db.query("INSERT INTO tasks (id, project_id, title, body, status, created_at, updated_at, worktree_path) VALUES ('review-task', 'p1', 'Review me', 'Requirements', 'review', ?, ?, '/tmp/review-task')").run(now(), now());
    agent("reviewer", "p1", { tool: "codex", task: "review-task" });
    db.query("INSERT INTO task_reviews (task_id, session_id, reviewer_tool, status, updated_at) VALUES ('review-task', 'reviewer', 'codex', 'running', ?)").run(now());
    const finding = await call("reviewer", "report_finding", { file: "src/example.ts", line: 19, severity: "high", message: "The null case throws before the fallback." });
    expect(finding.isError).toBe(false);
    expect((listTasks().find((t) => t.id === "review-task") as any).review.findings).toEqual([
      { file: "src/example.ts", line: 19, severity: "high", message: "The null case throws before the fallback." },
    ]);
    const finished = await call("reviewer", "finish_review", { summary: "One high severity null-handling bug." });
    expect(finished.isError).toBe(false);
    expect((listTasks().find((t) => t.id === "review-task") as any).review).toMatchObject({ status: "complete", summary: "One high severity null-handling bug." });
    expect((db.query("SELECT status FROM tasks WHERE id = 'review-task'").get() as { status: string }).status).toBe("review");
  });

  test("review tools reject invalid anchors and ordinary sessions", async () => {
    agent("plain", "p1");
    const bad = await call("plain", "report_finding", { file: "x.ts", line: 0, severity: "critical", message: "bad" });
    expect(bad.isError).toBe(true);
    const unauthorized = await call("plain", "report_finding", { file: "x.ts", line: 1, severity: "low", message: "not attached" });
    expect(unauthorized.isError).toBe(true);
  });

  test("an exited reviewer without finish_review is exposed as stopped", () => {
    db.query("INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) VALUES ('stopped-task', 'p1', 'Stopped review', 'review', ?, ?)").run(now(), now());
    agent("stopped-reviewer", "p1", { tool: "claude", task: "stopped-task" });
    db.query("INSERT INTO task_reviews (task_id, session_id, reviewer_tool, status, updated_at) VALUES ('stopped-task', 'stopped-reviewer', 'claude', 'running', ?)").run(now());
    db.query("UPDATE sessions SET status = 'exited' WHERE id = 'stopped-reviewer'").run();
    expect((listTasks().find((t) => t.id === "stopped-task") as any).review.status).toBe("stopped");
  });
});

describe("file claims", () => {
  test("a claimed file can't be claimed by a teammate, and shows in list_agents", () => {
    const a = agent("a", "p1");
    const b = agent("b", "p1");
    expect(team.claimFiles(a, ["src/x.ts", "/tmp/src/y.ts"], "refactoring the parser")).toContain("Claimed: src/x.ts, src/y.ts");
    const r = team.claimFiles(b, ["src/x.ts", "src/z.ts"], "");
    expect(r).toContain("Claimed: src/z.ts");
    expect(r).toContain("src/x.ts (claimed by Claude “Agent a”");
    expect(team.describeAgents(b)).toContain("claimed: src/x.ts (refactoring the parser), src/y.ts (refactoring the parser)");
  });

  test("editing a teammate's claimed file warns once, through the PostToolUse hook", () => {
    const a = agent("a", "p1");
    agent("b", "p1");
    team.claimFiles(a, ["src/x.ts"], "parser rewrite");
    const edit = { tool_name: "Edit", tool_input: { file_path: "/tmp/src/x.ts" } };
    const out = handleHook("claude", "PostToolUse", "b", edit);
    expect(out?.hookSpecificOutput?.additionalContext).toContain("src/x.ts is claimed by Claude “Agent a” (agent id a): parser rewrite");
    expect(handleHook("claude", "PostToolUse", "b", edit)).toBeUndefined(); // said once
    // Reading the file, or editing an unclaimed one, says nothing.
    expect(handleHook("claude", "PostToolUse", "b", { tool_name: "Read", tool_input: { file_path: "/tmp/src/x.ts" } })).toBeUndefined();
    expect(handleHook("claude", "PostToolUse", "b", { tool_name: "Edit", tool_input: { file_path: "/tmp/src/other.ts" } })).toBeUndefined();
  });

  test("claims go away on release and when the agent's session ends", () => {
    const a = agent("a", "p1");
    const b = agent("b", "p1");
    team.claimFiles(a, ["one.ts", "two.ts"], "");
    expect(team.releaseFiles(a, ["one.ts"])).toContain("Still claimed: two.ts");
    expect(team.claimFiles(b, ["one.ts"], "")).toContain("Claimed: one.ts");
    team.dropClaims("a");
    expect(team.claimFiles(b, ["two.ts"], "")).toContain("Claimed: two.ts");
  });

  // resumeClaims() is what a fresh start of ansai runs: memory is empty, the database isn't.
  test("claims outlive a restart of ansai, for agents that are still running", () => {
    const a = agent("a", "p1");
    const b = agent("b", "p1");
    const gone = agent("c", "p1");
    team.claimFiles(a, ["one.ts", "two.ts"], "parser rewrite");
    team.claimFiles(gone, ["three.ts"], "");
    team.releaseFiles(a, ["two.ts"]);
    db.query("UPDATE sessions SET status = 'exited' WHERE id = 'c'").run();
    team.resumeClaims();

    expect(team.claimsOf(a)).toEqual(["one.ts (parser rewrite)"]);
    expect(team.claimFiles(b, ["one.ts"], "")).toContain("one.ts (claimed by Claude “Agent a”");
    expect(handleHook("claude", "PostToolUse", "b", { tool_name: "Edit", tool_input: { file_path: "/tmp/one.ts" } })?.hookSpecificOutput?.additionalContext).toContain("one.ts is claimed by");
    // What was released, and what belonged to an agent that ended meanwhile, is free again.
    expect(team.claimFiles(b, ["two.ts", "three.ts"], "")).toContain("Claimed: two.ts, three.ts");
    expect(db.query("SELECT 1 FROM settings WHERE key = 'claims:c'").get()).toBeNull();

    team.releaseFiles(a);
    team.resumeClaims();
    expect(team.claimsOf(a)).toEqual([]);
  });
});
