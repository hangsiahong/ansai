// Text ansai types into an agent's terminal: team messages, a shift's next prompt.
// Two of them sent in the same moment must not overwrite each other, a message that
// couldn't be typed must not be shown as Delivered, and a message that is being held
// back must not stop a shift from handing the agent its next prompt.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

const { db, now } = await import("./db");
const sessions = await import("./sessions");
const { applyPanes, parsePanes, sendText, getSession } = sessions;
const team = await import("./team");
const shifts = await import("./shifts");
const { handleHook } = await import("./hooks");

const HOUR = 3600_000;

// A stand-in tmux: buffers and panes in memory, each call taking a few ms like the real one.
let buffers = new Map<string, string>();
let ops: string[] = [];
let typed: { pane: string; text: string }[] = [];
let failPaste = false;
const realTmux = sessions.setTmux(async (args, stdin) => {
  await Bun.sleep(1 + Math.floor(Math.random() * 4));
  const opt = (flag: string) => args[args.indexOf(flag) + 1]!;
  const ok = { code: 0, out: "", err: "" };
  switch (args[0]) {
    case "display":
      return { ...ok, out: "0\n" };
    case "load-buffer":
      buffers.set(opt("-b"), stdin ?? "");
      ops.push("load");
      return ok;
    case "paste-buffer": {
      const text = buffers.get(opt("-b"));
      if (failPaste) return { code: 1, out: "", err: "can't find pane: gone" };
      if (text === undefined) return { code: 1, out: "", err: `no buffer ${opt("-b")}` };
      buffers.delete(opt("-b"));
      typed.push({ pane: opt("-t"), text });
      ops.push("paste");
      return ok;
    }
    case "delete-buffer":
      buffers.delete(opt("-b"));
      return ok;
    case "send-keys":
      ops.push(args[args.length - 1]!);
      return ok;
  }
  return ok;
});
afterAll(() => void sessions.setTmux(realTmux));

function agent(id: string, o: { tool?: string; state?: string | null; task?: string | null } = {}) {
  db.query(
    `INSERT INTO sessions (id, project_id, task_id, tool, title, cwd, argv, tmux_name, status, agent_state, created_at, msg_cursor)
     VALUES (?, 'yp1', ?, ?, ?, '/tmp', '[]', ?, 'running', ?, ?, (SELECT COALESCE(MAX(id), 0) FROM messages))`,
  ).run(id, o.task ?? null, o.tool ?? "claude", `Agent ${id}`, `ansai-${id}`, o.state === undefined ? "waiting" : o.state, now());
  return getSession(id)!;
}
/** Tell ansai what tmux shows: these agents are alive and their screens have been still for a minute. */
function quiet(...ids: string[]) {
  const at = Math.floor((Date.now() - 60_000) / 1000);
  applyPanes(parsePanes(ids.map((id) => [`ansai-${id}`, 0, "", "claude", at, 0].join("\t")).join("\n") + "\n"));
}
const message = (id: number) => db.query("SELECT delivered_at FROM messages WHERE id = ?").get(id) as { delivered_at: number | null };
const settle = () => Bun.sleep(30); // postMessage kicks off a delivery of its own
/** Wait for something the server does on its own timers (a slow, busy laptop shouldn't fail the test). */
async function until(cond: () => boolean, ms = 3000) {
  for (const end = Date.now() + ms; !cond() && Date.now() < end; ) await Bun.sleep(10);
}

beforeEach(async () => {
  await Bun.sleep(200); // let the previous test's typing finish (ansai pauses before pressing Enter)
  db.exec("DELETE FROM shifts; DELETE FROM messages; DELETE FROM sessions; DELETE FROM tasks;");
  db.query("INSERT OR IGNORE INTO projects (id, name, path, created_at) VALUES ('yp1', 'yp1', '/tmp/typing-yp1', 0)").run();
  buffers = new Map();
  ops = [];
  typed = [];
  failPaste = false;
});

describe("typing into a session", () => {
  test("two texts sent in the same moment are typed whole, one after the other", async () => {
    agent("a");
    await Promise.all([sendText("a", "first message"), sendText("a", "second message"), sendText("a", "third message")]);
    expect(typed.map((t) => t.text)).toEqual(["first message", "second message", "third message"]);
    expect(ops).toEqual(["load", "paste", "Enter", "load", "paste", "Enter", "load", "paste", "Enter"]);
    expect(buffers.size).toBe(0);
  });

  test("a text that couldn't be typed doesn't hold up the next one", async () => {
    agent("a");
    failPaste = true;
    const first = sendText("a", "lost").catch((e) => e);
    const second = sendText("a", "kept");
    await Bun.sleep(0);
    const err = await first;
    failPaste = false;
    expect(err.status).toBe(409);
    await second.catch(() => {});
    await sendText("a", "after");
    expect(typed.at(-1)!.text).toBe("after");
    expect(buffers.size).toBe(0); // the failed paste's buffer was cleaned up
  });
});

describe("team messages typed into an idle agent", () => {
  test("a message that couldn't be typed stays undelivered and goes out next time", async () => {
    const a = agent("a", { state: "working" });
    agent("b");
    quiet("a", "b");
    failPaste = true;
    const m = team.postMessage({ from: a, to: "b", body: "the API moved to v2" });
    await settle();
    await team.deliverIdle();
    expect(typed).toEqual([]);
    expect(message(m.id).delivered_at).toBeNull();
    failPaste = false;
    await team.deliverIdle();
    expect(typed.map((t) => t.pane)).toEqual(["ansai-b"]);
    expect(typed[0]!.text).toContain("the API moved to v2");
    expect(message(m.id).delivered_at).not.toBeNull();
    await team.deliverIdle();
    expect(typed.length).toBe(1); // once
  });
});

describe("a shift and a waiting team message", () => {
  function finishedTask() {
    db.query("INSERT INTO tasks (id, project_id, title, status, summary, created_at, updated_at) VALUES ('t1', 'yp1', 'T', 'review', 'All done.', 0, 0)").run();
  }

  test("a message that is about to be typed goes first; the shift's prompt waits", async () => {
    const a = agent("a", { state: "working" });
    agent("c", { tool: "codex" });
    quiet("a", "c");
    shifts.startShift("c", { until: now() + HOUR });
    failPaste = true; // hold everything until the test looks
    team.postMessage({ from: a, to: "c", body: "rebase before you push" });
    await settle();
    await Bun.sleep(120); // startShift's own first look
    failPaste = false;
    await shifts.nudgeIdle();
    expect(shifts.shiftView("c")!.nudges).toBe(0);
    await team.deliverIdle();
    await until(() => typed.length > 0);
    expect(typed.length).toBe(1);
    expect(typed[0]!.text).toContain("rebase before you push");
  });

  test("Codex: a held message no longer stops the shift; it is typed with the next prompt", async () => {
    finishedTask();
    const a = agent("a", { state: "working" });
    agent("c", { tool: "codex", task: "t1" });
    quiet("a", "c");
    const m = team.postMessage({ from: a, to: "c", body: "your branch conflicts with mine" });
    await settle();
    expect(typed).toEqual([]); // held: its task is finished
    shifts.startShift("c", { until: now() + HOUR }); // it looks for idle agents right away
    await until(() => typed.length > 0);
    expect(shifts.shiftView("c")!.nudges).toBe(1);
    expect(typed.length).toBe(1);
    expect(typed[0]!.text).toContain("your branch conflicts with mine");
    expect(typed[0]!.text).toContain("ansai shift");
    expect(message(m.id).delivered_at).not.toBeNull();
  });

  test("Claude: the shift's prompt is typed, and Claude is handed the held message when it submits", async () => {
    finishedTask();
    const a = agent("a", { state: "working" });
    agent("b", { task: "t1" });
    quiet("a", "b");
    team.postMessage({ from: a, to: "b", body: "tests fail on main" });
    await settle();
    shifts.startShift("b", { until: now() + HOUR });
    await until(() => typed.length > 0);
    expect(shifts.shiftView("b")!.nudges).toBe(1);
    expect(typed.length).toBe(1);
    expect(typed[0]!.text).not.toContain("tests fail on main");
    expect(handleHook("claude", "UserPromptSubmit", "b", {})?.hookSpecificOutput?.additionalContext).toContain("tests fail on main");
  });
});
