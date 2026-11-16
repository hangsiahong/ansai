// Bounds for autopilot runs: tokens spent so far, read from the agent's log, and the
// per-project time limit that stops a run and hands its task back for review.
import { beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { db, now } = await import("./db");
const { addUsage, eachLine, newScan, runDeadline, scanTokens, sessionTokens } = await import("./runs");
const { enforceRunLimits } = await import("./limits");
const { setViewer } = await import("./viewers");

describe("tokens so far", () => {
  test("Claude: each API message counts once, cache reads apart", () => {
    const sc = newScan("/x.jsonl");
    const msg = (id: string) =>
      JSON.stringify({ type: "assistant", message: { id, usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 50_000, output_tokens: 200 } } });
    // Streaming writes one message as a line per content block, each with the same usage.
    for (const line of [msg("m1"), msg("m1"), msg("m2"), JSON.stringify({ type: "user", message: { content: "hi" } })]) addUsage(sc, "claude", line);
    expect(sc.tokens).toEqual({ fresh: 2 * 1210, cached: 100_000 });
  });

  test("Codex: its running total, with cached input taken out of input", () => {
    const sc = newScan("/r.jsonl");
    const count = (input: number, cached: number, output: number) =>
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } });
    addUsage(sc, "codex", count(5000, 3000, 400));
    addUsage(sc, "codex", count(12_000, 9000, 900));
    expect(sc.tokens).toEqual({ fresh: 3000 + 900, cached: 9000 });
  });
});

// A log can be hundreds of MB and is read from the top after a restart, so it's read a slice at a time.
describe("counting a long log a slice at a time", () => {
  const usage = (id: string, n: number, text: string) =>
    JSON.stringify({ type: "assistant", message: { id, content: [{ type: "text", text }], usage: { input_tokens: n, cache_creation_input_tokens: 10 * n, cache_read_input_tokens: 1000 * n, output_tokens: 100 * n } } });
  // Lines of very different lengths, with characters that take 2, 3 and 4 bytes.
  const lines = [
    usage("m1", 1, "café ✓ 日本語"),
    JSON.stringify({ type: "user", message: { content: "x".repeat(300) + " — 🙂" } }),
    usage("m1", 1, "the same message again, streamed as a second line"),
    "",
    'not JSON, though it says "usage"',
    usage("m2", 2, "🙂".repeat(40)),
    usage("m3", 3, "é"),
  ];
  const text = lines.join("\n") + "\n";
  const bytes = Buffer.from(text);
  const total = { fresh: (1 + 2 + 3) * 111, cached: (1 + 2 + 3) * 1000 };

  let files = 0;
  const log = (content: string | Buffer) => {
    const path = join(process.env.ANSAI_HOME!, `runs-log-${++files}.jsonl`);
    writeFileSync(path, content);
    return path;
  };
  const follow = (path: string, tool = "claude") => {
    const id = `scan-${crypto.randomUUID()}`;
    db.query(
      `INSERT INTO sessions (id, tool, title, cwd, argv, tmux_name, status, agent_state, created_at, transcript)
       VALUES (?, ?, 'T', '/tmp', '[]', ?, 'running', 'working', ?, ?)`,
    ).run(id, tool, `ansai-${id}`, now(), path);
    return id;
  };
  const read = async (path: string, slice: number, from = 0) => {
    const got: string[] = [];
    const end = await eachLine(path, from, (line) => got.push(line.toString("utf8")), slice);
    return { got, end };
  };

  test("every slice size hands over the same lines, however a line or a character is cut", async () => {
    // Short, so every slice size from one byte up can be tried: each one cuts somewhere else.
    const short = ["café ✓ 日本語", "", "🙂🙂 — é", "x".repeat(40), "é"];
    const size = Buffer.byteLength(short.join("\n") + "\n");
    const path = log(short.join("\n") + "\n");
    for (let slice = 1; slice <= size + 1; slice++) expect(await read(path, slice)).toEqual({ got: short, end: size });
    // from part-way in, as on every scan after the first
    const second = Buffer.byteLength(short[0]!) + 1;
    expect(await read(path, 7, second)).toEqual({ got: short.slice(1), end: size });
    // the real slice size, on the longer log
    expect(await read(log(text), 4 * 1024 * 1024)).toEqual({ got: lines, end: bytes.length });
  });

  test("a line still being written is left for the next read", async () => {
    const path = log(text + '{"type":"assistant","message":{"id":"m4","content":"caf');
    for (const slice of [5, 64, 1 << 20]) expect(await read(path, slice)).toEqual({ got: lines, end: bytes.length });
    expect(await read(log("no newline yet"), 4)).toEqual({ got: [], end: 0 });
  });

  test("totals match a single read, with a slice edge inside a line and inside a character", async () => {
    const path = log(text);
    const whole = follow(path);
    expect(await scanTokens()).toBe(true);
    expect(sessionTokens(whole)).toEqual(total);
    const tick = bytes.indexOf("✓"); // 3 bytes
    const smiley = bytes.indexOf("🙂"); // 4 bytes
    for (const slice of [7, 64, tick + 1, tick + 2, smiley + 1, smiley + 2, smiley + 3, bytes.length - 2]) {
      const id = follow(path);
      expect(await scanTokens(slice)).toBe(true);
      expect(sessionTokens(id)).toEqual(sessionTokens(whole)!);
    }
    expect(await scanTokens(5)).toBe(false); // nothing new: nothing re-read, nothing counted twice
    expect(sessionTokens(whole)).toEqual(total);
  });

  test("a log that grows is counted from where the last scan stopped", async () => {
    const cut = bytes.indexOf("🙂".repeat(40)) + 6; // mid-line and mid-character, in m2's line
    const path = log(bytes.subarray(0, cut));
    const id = follow(path);
    expect(await scanTokens(16)).toBe(true);
    expect(sessionTokens(id)).toEqual({ fresh: 111, cached: 1000 }); // m1 only: m2's line isn't finished
    appendFileSync(path, bytes.subarray(cut));
    expect(await scanTokens(16)).toBe(true);
    expect(sessionTokens(id)).toEqual(total);
  });

  test("Codex: the last running total wins, in slices too", async () => {
    const count = (input: number, cached: number, output: number) =>
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } });
    const path = log([count(5000, 3000, 400), JSON.stringify({ type: "response_item", payload: { type: "message", content: [{ text: "日本語 ✓" }] } }), count(12_000, 9000, 900)].join("\n") + "\n");
    const id = follow(path, "codex");
    await scanTokens(10);
    expect(sessionTokens(id)).toEqual({ fresh: 3000 + 900, cached: 9000 });
  });
});

// ---------------------------------------------------------------- time limit

let n = 0;
function project(maxMinutes: number | null) {
  db.query("UPDATE projects SET autopilot = ? WHERE id = 'px'").run(JSON.stringify({ on: true, tool: "claude", accountId: null, yolo: false, maxMinutes }));
}
function run(minutesAgo: number, o: { auto?: boolean; taskStatus?: string } = {}) {
  const sid = `r${++n}`;
  const tid = `t${n}`;
  db.query("INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) VALUES (?, 'px', 'T', ?, 0, 0)").run(tid, o.taskStatus ?? "doing");
  db.query(
    `INSERT INTO sessions (id, project_id, task_id, tool, title, cwd, argv, tmux_name, status, agent_state, created_at, auto)
     VALUES (?, 'px', ?, 'claude', 'T', '/tmp', '[]', ?, 'running', 'working', ?, ?)`,
  ).run(sid, tid, `ansai-${sid}`, now() - minutesAgo * 60_000, o.auto === false ? 0 : 1);
  return { sid, tid };
}
const session = (id: string) => db.query("SELECT * FROM sessions WHERE id = ?").get(id) as any;
const task = (id: string) => db.query("SELECT status, queued, last_failure, summary FROM tasks WHERE id = ?").get(id) as any;

beforeEach(() => {
  db.exec("DELETE FROM sessions; DELETE FROM tasks; DELETE FROM projects;");
  db.query("INSERT INTO projects (id, name, path, created_at) VALUES ('px', 'px', '/tmp/px', 0)").run();
});

describe("runDeadline", () => {
  test("an autopilot run in Doing gets its project's limit", () => {
    project(30);
    const { sid } = run(10);
    expect(runDeadline(session(sid))).toBe(session(sid).created_at + 30 * 60_000);
  });

  test("none without a limit, for runs you started, or once the task left Doing", () => {
    project(null);
    expect(runDeadline(session(run(10).sid))).toBeNull();
    project(30);
    expect(runDeadline(session(run(10, { auto: false }).sid))).toBeNull();
    expect(runDeadline(session(run(10, { taskStatus: "review" }).sid))).toBeNull();
  });
});

describe("enforceRunLimits", () => {
  test("a run past its limit stops: task to Review with the reason, and the session is no longer autopilot's", async () => {
    project(15);
    const late = run(20);
    await enforceRunLimits();
    expect(task(late.tid)).toMatchObject({ status: "review", queued: 0, last_failure: "hit the 15-minute time limit for autopilot runs" });
    expect(task(late.tid).summary).toContain("Autopilot stopped this run");
    expect(session(late.sid).auto).toBe(0);
  }, 15_000);

  test("a run inside its limit keeps going", async () => {
    project(15);
    const early = run(5);
    await enforceRunLimits();
    expect(task(early.tid).status).toBe("doing");
    expect(session(early.sid).auto).toBe(1);
  });

  test("a run you're looking at isn't cut off", async () => {
    project(15);
    const watched = run(20);
    const conn = {};
    setViewer(watched.sid, conn, true);
    await enforceRunLimits();
    expect(task(watched.tid).status).toBe("doing");
    setViewer(watched.sid, conn, false);
  });
});

const { sampleBusy } = await import("./limits");
describe("sampleBusy", () => {
  const screens = (...list: string[]) => {
    let i = 0;
    return async () => list[Math.min(i++, list.length - 1)]!;
  };
  test("busy when any look shows the footer, even if the first catches a gap between requests", async () => {
    expect(await sampleBusy(screens("❯ ", "❯ ", "⏵⏵ auto mode on · esc to interrupt"), 5, 1)).toBe(true);
  });
  test("idle only when every look is quiet", async () => {
    expect(await sampleBusy(screens("❯ "), 5, 1)).toBe(false);
  });
});
