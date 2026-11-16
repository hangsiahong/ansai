// Text ansai types into an agent's terminal: team messages, a shift's next prompt.
// Two of them sent in the same moment must not overwrite each other, a message that
// couldn't be typed must not be shown as Delivered, and a message that is being held
// back must not stop a shift from handing the agent its next prompt. And nothing is
// typed while a menu or a question is on the agent's screen instead of its input box.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

const { db, now } = await import("./db");
const sessions = await import("./sessions");
const { applyPanes, parsePanes, sendText, getSession } = sessions;
const team = await import("./team");
const shifts = await import("./shifts");
const { handleHook } = await import("./hooks");
const screen = await import("./test-screens");

const HOUR = 3600_000;

// A stand-in tmux: buffers and panes in memory, each call taking a few ms like the real one.
let buffers = new Map<string, string>();
let ops: string[] = [];
let typed: { pane: string; text: string }[] = [];
let failPaste = false;
/** What each pane shows (capture-pane); an agent sits at its prompt unless a test says otherwise. */
let screens = new Map<string, string>();
const realTmux = sessions.setTmux(async (args, stdin) => {
  await Bun.sleep(1 + Math.floor(Math.random() * 4));
  const opt = (flag: string) => args[args.indexOf(flag) + 1]!;
  const ok = { code: 0, out: "", err: "" };
  switch (args[0]) {
    case "display":
      return { ...ok, out: "0\n" };
    case "capture-pane":
      return { ...ok, out: screens.get(opt("-t")) ?? "" };
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
  screens.set(`ansai-${id}`, o.tool === "codex" ? screen.CODEX_IDLE : screen.CLAUDE_IDLE);
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
  screens = new Map();
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

describe("when tmux can't say what is running", () => {
  test("one failed look doesn't mark the agents gone; a tmux server that is gone does", async () => {
    agent("a", { state: "working" });
    quiet("a");
    const fake = sessions.setTmux(async () => ({ code: 1, out: "", err: "fork failed: Resource temporarily unavailable" }));
    try {
      for (let i = 0; i < 4; i++) expect(await sessions.reconcile()).toBe(false);
      expect(getSession("a")!.status).toBe("running");
      sessions.setTmux(async () => ({ code: 1, out: "", err: "no server running on /tmp/tmux-1000/ansai" }));
      expect(await sessions.reconcile()).toBe(true);
      expect(getSession("a")!.status).toBe("exited");
    } finally {
      sessions.setTmux(fake);
    }
  });

  test("a failure that keeps coming back is believed in the end", async () => {
    agent("a", { state: "working" });
    quiet("a");
    const fake = sessions.setTmux(async () => ({ code: 1, out: "", err: "something else" }));
    try {
      for (let i = 0; i < 4; i++) await sessions.reconcile();
      expect(getSession("a")!.status).toBe("running");
      await sessions.reconcile();
      expect(getSession("a")!.status).toBe("exited");
    } finally {
      sessions.setTmux(fake);
    }
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

describe("a menu or a question on the agent's screen", () => {
  test("a team message waits (undelivered) and is typed once the input box is back", async () => {
    const a = agent("a", { state: "working" });
    agent("b");
    quiet("a", "b");
    screens.set("ansai-b", screen.CLAUDE_MENU); // Enter here would pick the focused model
    const m = team.postMessage({ from: a, to: "b", body: "the API moved to v2" });
    await settle();
    await team.deliverIdle();
    expect(ops).toEqual([]); // nothing pasted, no Enter pressed
    expect(message(m.id).delivered_at).toBeNull();
    screens.set("ansai-b", screen.CLAUDE_IDLE);
    await team.deliverIdle();
    expect(typed.map((t) => t.pane)).toEqual(["ansai-b"]);
    expect(message(m.id).delivered_at).not.toBeNull();
  });

  test("a shift's next prompt waits too, and isn't counted until it is typed", async () => {
    agent("c", { tool: "codex" });
    quiet("c");
    screens.set("ansai-c", screen.CODEX_TRUST);
    shifts.startShift("c", { until: now() + HOUR });
    await Bun.sleep(120); // startShift's own first look
    await shifts.nudgeIdle();
    expect(ops).toEqual([]);
    expect(shifts.shiftView("c")!.nudges).toBe(0);
    expect(shifts.shiftView("c")!.active).toBe(true);
    screens.set("ansai-c", screen.CODEX_IDLE);
    await shifts.nudgeIdle();
    await until(() => typed.length > 0);
    expect(typed.length).toBe(1);
    expect(shifts.shiftView("c")!.nudges).toBe(1);
  });

  test("a prompt for the agent waits a moment for the box, then gives up without typing", async () => {
    agent("a");
    screens.set("ansai-a", screen.CLAUDE_MENU);
    const err = await sessions.sendAtPrompt("a", "/compact keep the plan", 60).catch((e) => e);
    expect(err.status).toBe(409);
    expect(ops).toEqual([]);
    setTimeout(() => screens.set("ansai-a", screen.CLAUDE_IDLE), 30);
    await sessions.sendAtPrompt("a", "/compact keep the plan", 2000);
    expect(typed.map((t) => t.text)).toEqual(["/compact keep the plan"]);
  });
});

describe("Codex, which only says when a turn ends", () => {
  test("a prompt typed in through ansai marks it working; a slash command doesn't", async () => {
    agent("c", { tool: "codex" });
    await sendText("c", "/model");
    expect(getSession("c")!.agent_state).toBe("waiting");
    await sendText("c", "half a thought", false); // typed, not sent
    expect(getSession("c")!.agent_state).toBe("waiting");
    await sendText("c", "fix the failing test");
    expect(getSession("c")!.agent_state).toBe("working");
    handleHook("codex", "turn", "c", { type: "agent-turn-complete", "last-assistant-message": "Fixed." });
    expect(getSession("c")!.agent_state).toBe("waiting");
  });

  test("a turn you stopped with Esc doesn't leave it working for good", async () => {
    agent("c", { tool: "codex" });
    await sendText("c", "run the slow thing");
    quiet("c"); // its screen has been still for a minute
    const later = Date.now() + 20_000;
    screens.set("ansai-c", screen.CODEX_WORKING); // still says "esc to interrupt": leave it
    await sessions.watchCodexScreens(later);
    expect(getSession("c")!.agent_state).toBe("working");
    screens.set("ansai-c", screen.CODEX_INTERRUPTED);
    await sessions.watchCodexScreens(Date.now()); // too soon after the prompt to tell
    expect(getSession("c")!.agent_state).toBe("working");
    await sessions.watchCodexScreens(later);
    expect(getSession("c")!).toMatchObject({ agent_state: "waiting", agent_message: "Interrupted" });
  });

  test("a turn whose end ansai missed is noticed the same way, without calling it interrupted", async () => {
    agent("c", { tool: "codex" });
    await sendText("c", "say hi");
    quiet("c");
    await sessions.watchCodexScreens(Date.now() + 20_000);
    expect(getSession("c")!).toMatchObject({ agent_state: "waiting", agent_message: null });
  });
});

describe("Antigravity, which says nothing at all", () => {
  const task = (status: string) => db.query("INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) VALUES ('t1', 'yp1', 'T', ?, 0, 0)").run(status);
  const taskStatus = () => (db.query("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }).status;
  const TRUST = ["Accessing workspace:", "", "/home/you/project", "", "Do you trust the contents of this project?", "", "Antigravity CLI requires permission to read, edit, and execute files here.", "", "> Yes, I trust this folder", "  No, exit", "", "  ↑/↓ Navigate · enter Confirm", "                 auto · Gemini 3.8 Flash · high"].join("\n");

  test("its turn ends when its screen says so, and its task leaves Doing", async () => {
    task("doing");
    agent("g", { tool: "agy", state: null, task: "t1" });
    const t0 = Date.now();
    screens.set("ansai-g", screen.AGY_WORKING);
    await sessions.watchAgyScreens(t0);
    expect(getSession("g")!.agent_state).toBe("working");
    await sessions.watchAgyScreens(t0 + 60_000); // its spinner can sit still for a minute: still working
    expect(getSession("g")!.agent_state).toBe("working");
    screens.set("ansai-g", screen.AGY_DONE);
    await sessions.watchAgyScreens(t0 + 62_000); // seen once: could be a screen caught mid-redraw
    expect(getSession("g")!.agent_state).toBe("working");
    expect(taskStatus()).toBe("doing");
    await sessions.watchAgyScreens(t0 + 66_000);
    expect(getSession("g")!.agent_state).toBe("waiting");
    expect(taskStatus()).toBe("review");
  });

  test("a glimpse of its prompt in the middle of a turn doesn't end the turn", async () => {
    task("doing");
    agent("g", { tool: "agy", state: "working", task: "t1" });
    const t0 = Date.now();
    screens.set("ansai-g", screen.AGY_DONE);
    await sessions.watchAgyScreens(t0);
    screens.set("ansai-g", screen.AGY_WORKING);
    await sessions.watchAgyScreens(t0 + 2000);
    screens.set("ansai-g", screen.AGY_DONE);
    await sessions.watchAgyScreens(t0 + 4000); // counted from here, not from the first glimpse
    expect(getSession("g")!.agent_state).toBe("working");
    expect(taskStatus()).toBe("doing");
  });

  test("a prompt you give it afterwards puts its task back in Doing", async () => {
    task("review");
    agent("g", { tool: "agy", state: "waiting", task: "t1" });
    screens.set("ansai-g", screen.AGY_WORKING_NARROW);
    await sessions.watchAgyScreens();
    expect(getSession("g")!.agent_state).toBe("working");
    expect(taskStatus()).toBe("doing");
  });

  test("its permission question shows as Needs you; refusing it ends the turn as interrupted", async () => {
    task("doing");
    agent("g", { tool: "agy", state: "working", task: "t1" });
    const t0 = Date.now();
    screens.set("ansai-g", screen.AGY_ASK);
    await sessions.watchAgyScreens(t0);
    expect(getSession("g")!).toMatchObject({ agent_state: "needs-input", agent_message: "Run this command? touch probe2.txt" });
    expect(taskStatus()).toBe("doing");
    screens.set("ansai-g", screen.AGY_INTERRUPTED);
    await sessions.watchAgyScreens(t0 + 2000);
    await sessions.watchAgyScreens(t0 + 6000);
    expect(getSession("g")!).toMatchObject({ agent_state: "waiting", agent_message: "Interrupted" });
    expect(taskStatus()).toBe("review");
  });

  test("one opened without a prompt just waits for you", async () => {
    task("doing");
    agent("g", { tool: "agy", state: null, task: "t1" });
    screens.set("ansai-g", screen.AGY_IDLE);
    await sessions.watchAgyScreens();
    await sessions.watchAgyScreens(Date.now() + 60_000);
    expect(getSession("g")!.agent_state).toBe("waiting");
    expect(taskStatus()).toBe("doing"); // nothing ran, so nothing finished
  });

  test("a first turn that went by while ansai was down still ends", async () => {
    task("doing");
    agent("g", { tool: "agy", state: null, task: "t1" });
    db.query("UPDATE sessions SET argv = ? WHERE id = 'g'").run(JSON.stringify(["agy", "-i", "do the task"]));
    const t0 = Date.now();
    screens.set("ansai-g", screen.AGY_DONE);
    await sessions.watchAgyScreens(t0);
    await sessions.watchAgyScreens(t0 + 4000); // it may not have started on its prompt yet
    expect(getSession("g")!.agent_state).toBeNull();
    await sessions.watchAgyScreens(t0 + 12_000);
    expect(getSession("g")!.agent_state).toBe("waiting");
    expect(taskStatus()).toBe("review");
  });

  test("its folder-trust question and a shell under it are left alone", async () => {
    agent("g", { tool: "agy", state: null });
    screens.set("ansai-g", TRUST);
    await sessions.watchAgyScreens();
    expect(getSession("g")!.agent_state).toBeNull();
    screens.set("ansai-g", "$ ls\nREADME.md\n$ ");
    await sessions.watchAgyScreens();
    expect(getSession("g")!.agent_state).toBeNull();
  });
});
