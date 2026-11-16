import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { db } = await import("./db");
const { pollRunningTails, subscribeChat, tailOf, touchedFiles, unsubscribeChat } = await import("./transcripts");
const { eachLine } = await import("./files");

type Item = { id: string; k: string; text?: string; name?: string; title?: string; result?: string; error?: boolean; done?: boolean };
const sessions: string[] = [];

async function parseFixture(tool: "claude" | "codex"): Promise<{ id: string; items: Item[]; close: () => void }> {
  const id = `transcript-test-${tool}-${crypto.randomUUID()}`;
  const fixture = join(import.meta.dir, "fixtures", `transcripts-${tool}.jsonl`);
  db.query(
    `INSERT INTO sessions (id, tool, title, cwd, argv, tmux_name, status, created_at, transcript)
     VALUES (?, ?, ?, ?, '[]', ?, 'running', ?, ?)`,
  ).run(id, tool, tool === "claude" ? "Claude Code" : "Codex", "/tmp/transcript-project", `tmux-${id}`, Date.now(), fixture);
  sessions.push(id);
  const messages: string[] = [];
  const ws = { readyState: 1, send: (message: string) => messages.push(message) };
  await subscribeChat(id, ws as never);
  const init = messages.map((message) => JSON.parse(message)).find((message) => message.t === "init");
  if (!init) throw new Error("Chat tail did not send its initial items");
  return { id, items: init.items as Item[], close: () => unsubscribeChat(id, ws as never) };
}

afterEach(() => {
  for (const id of sessions.splice(0)) {
    db.query("DELETE FROM sessions WHERE id = ?").run(id);
  }
});

describe("Claude transcript parsing", () => {
  test("renders user, assistant, thinking and paired tools; skips metadata and sidechains", async () => {
    const chat = await parseFixture("claude");
    try {
      expect(chat.items).toContainEqual(expect.objectContaining({ k: "user", text: "Please inspect this file. \npasted words\nwith lines" }));
      expect(chat.items).toContainEqual(expect.objectContaining({ k: "assistant", text: "I will read it." }));
      expect(chat.items).toContainEqual(expect.objectContaining({ k: "thinking", text: "Let me inspect." }));
      expect(chat.items.find((item) => item.id === "tool-read")).toMatchObject({ k: "tool", name: "Read", title: "Read a.txt", result: "file contents", done: true, error: false });
      expect(chat.items.find((item) => item.id === "tool-edit")).toMatchObject({ k: "tool", result: "edit failed", done: true, error: true });
      expect(chat.items.some((item) => /hidden metadata|hidden sidechain|internal reminder/.test(item.text ?? ""))).toBe(false);
    } finally { chat.close(); }
  });

  test("cleans command, bash, interrupted and shift inputs into visible chat items", async () => {
    const chat = await parseFixture("claude");
    try {
      expect(chat.items).toContainEqual(expect.objectContaining({ k: "user", text: "/model opus" }));
      expect(chat.items).toContainEqual(expect.objectContaining({ k: "user", text: "! git status" }));
      expect(chat.items).toContainEqual(expect.objectContaining({ k: "note", text: "Interrupted" }));
      expect(chat.items.filter((item) => item.k === "note" && item.text?.startsWith("Kept going"))).toHaveLength(2);
      expect(chat.items.filter((item) => item.k === "note" && item.text?.startsWith("Kept going")).map((item) => item.text)).toEqual([
        "Kept going · on shift until 2026-01-02T04:04:14Z",
        "Kept going · on shift until 2026-01-02T04:04:14Z",
      ]);
      expect(chat.items.some((item) => item.text?.includes("from your team"))).toBe(false);
      expect(db.query("SELECT model, effort FROM sessions WHERE id = ?").get(chat.id)).toEqual({ model: "claude-opus-4-5", effort: "medium" });
    } finally { chat.close(); }
  });

  test("tracks edited files in recency order", async () => {
    const chat = await parseFixture("claude");
    try { expect(touchedFiles(db.query("SELECT * FROM sessions WHERE id = ?").get(chat.id) as never)).toEqual(["b.txt"]); }
    finally { chat.close(); }
  });
});

describe("Codex transcript parsing", () => {
  test("renders response items, tools, patch titles, context model and shift notes", async () => {
    const chat = await parseFixture("codex");
    try {
      expect(chat.items).toContainEqual(expect.objectContaining({ k: "user", text: "Please update the project." }));
      expect(chat.items).toContainEqual(expect.objectContaining({ k: "assistant", text: "I will update it." }));
      expect(chat.items).toContainEqual(expect.objectContaining({ k: "thinking", text: "Check the files first." }));
      expect(chat.items.find((item) => item.id === "call-patch")).toMatchObject({ k: "tool", title: "Edit one.ts, two.ts", result: "patch applied", done: true });
      expect(chat.items.find((item) => item.id === "call-fn")).toMatchObject({ k: "tool", name: "lookup", title: "lookup", result: "found it", done: true });
      expect(chat.items.filter((item) => item.k === "note")).toEqual([expect.objectContaining({ text: "Kept going · on shift until 2026-01-02T04:04:13Z" })]);
      expect(chat.items.some((item) => item.text?.includes("from your team"))).toBe(false);
      expect(db.query("SELECT model, effort FROM sessions WHERE id = ?").get(chat.id)).toEqual({ model: "gpt-5-codex", effort: "high" });
      expect(touchedFiles(db.query("SELECT * FROM sessions WHERE id = ?").get(chat.id) as never)).toEqual(["src/two.ts", "src/one.ts"]);
    } finally { chat.close(); }
  });
});

// The tail keeps the newest 1500 chat items. What it remembers about tool calls must stay
// in step with that, or a long-running agent's every tool call and output stays in memory.
describe("a long session", () => {
  const ts = "2026-01-02T03:04:05.000Z";
  let uid = 0;
  const say = (text: string) => ({ type: "assistant", uuid: `a${++uid}`, timestamp: ts, message: { model: "claude-opus-5-5", content: [{ type: "text", text }] } });
  const call = (id: string) => ({ type: "assistant", uuid: `a${++uid}`, timestamp: ts, message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id, name: "Bash", input: { command: `echo ${id}`, description: `Run ${id}` } }] } });
  const output = (id: string, text: string) => ({ type: "user", uuid: `u${++uid}`, timestamp: ts, message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
  const rows = (list: object[]) => list.map((r) => JSON.stringify(r)).join("\n") + "\n";

  async function follow(first: object[]) {
    const id = `transcript-test-long-${crypto.randomUUID()}`;
    const file = join(process.env.ANSAI_HOME!, `${id}.jsonl`);
    writeFileSync(file, rows(first));
    db.query(
      `INSERT INTO sessions (id, tool, title, cwd, argv, tmux_name, status, created_at, transcript)
       VALUES (?, 'claude', 'A named session', '/tmp/transcript-project', '[]', ?, 'running', ?, ?)`,
    ).run(id, `tmux-${id}`, Date.now(), file);
    sessions.push(id);
    const messages: string[] = [];
    const ws = { readyState: 1, send: (m: string) => messages.push(m) };
    await subscribeChat(id, ws as never);
    const tail = tailOf(id)!;
    /** Write more of the log and return the items viewers are sent for it. */
    const more = async (list: object[]): Promise<Item[]> => {
      const seen = messages.length;
      appendFileSync(file, rows(list));
      while (tail.offset < statSync(file).size) await tail.poll(); // (its own timer may be mid-poll)
      return messages.slice(seen).map((m) => JSON.parse(m)).filter((m) => m.t === "items").flatMap((m) => m.items as Item[]);
    };
    /** Everything remembered is a card still on the list, or a call still waiting for its output. */
    const onlyNeeded = () => {
      const kept = new Set(tail.items.map((x) => x.id));
      return [...tail.st.tools.values()].every((t) => kept.has(t.id) || !t.done);
    };
    return { tail, more, onlyNeeded, close: () => unsubscribeChat(id, ws as never) };
  }
  const busy = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => [say(`step ${from + i}`), call(`t${from + i}`), output(`t${from + i}`, `out ${from + i}`)]).flat();

  test("forgets finished tool calls as their cards leave the list; output still lands on the right card", async () => {
    // 4000 items: "early" is long gone from the kept 1500, "recent" is among them; neither has its output yet.
    const chat = await follow([call("early"), ...busy(0, 1990), call("recent"), ...busy(1990, 2000)]);
    try {
      const { tail, more } = chat;
      expect(tail.items.length).toBe(1500);
      expect(tail.items.some((x) => x.id === "early")).toBe(false);
      expect(tail.st.tools.size).toBe(tail.items.filter((x) => x.k === "tool").length + 1); // + "early", still waiting
      expect(tail.st.tools.size).toBeLessThan(800);
      expect(chat.onlyNeeded()).toBe(true);

      // late output, for a card still on the list
      expect(await more([output("recent", "late output")])).toEqual([expect.objectContaining({ id: "recent", title: "Run recent", result: "late output", done: true })]);
      expect(tail.items.find((x) => x.id === "recent")).toMatchObject({ result: "late output", done: true });
      // the same call answered again: the card takes the newer output
      expect(await more([output("recent", "newer output")])).toEqual([expect.objectContaining({ id: "recent", result: "newer output", done: true })]);
      // a finished card further back still updates too
      expect(await more([output("t1500", "rerun")])).toEqual([expect.objectContaining({ id: "t1500", title: "Run t1500", result: "rerun" })]);
      // output for a call whose card already left the list still goes out, for screens that have the card
      expect(await more([output("early", "at last")])).toEqual([expect.objectContaining({ id: "early", title: "Run early", result: "at last", done: true })]);

      // and it stays that way however long the session runs
      for (let i = 2000; i < 6000; i += 500) {
        await more(busy(i, i + 500));
        expect(tail.items.length).toBe(1500);
        expect(tail.st.tools.size).toBeLessThan(800);
        expect(chat.onlyNeeded()).toBe(true);
      }
      expect(tail.st.tools.has("early")).toBe(false);
      expect(tail.items.find((x) => x.id === "t5999")).toMatchObject({ result: "out 5999", done: true });
    } finally { chat.close(); }
  });

  test("calls that never get their output (interrupted) don't pile up either", async () => {
    const chat = await follow([say("start")]);
    try {
      const { tail, more } = chat;
      for (let i = 0; i < 6000; i += 1000) await more(Array.from({ length: 1000 }, (_, k) => [say(`step ${i + k}`), call(`hung${i + k}`)]).flat());
      expect(tail.items.length).toBe(1500);
      expect(tail.st.tools.size).toBeLessThanOrEqual(2000); // the kept items, and the 500 longest-remembered beyond them
      expect(tail.st.tools.has("hung0")).toBe(false);
      // one whose card left the list a while ago is still remembered
      expect(tail.items.some((x) => x.id === "hung5000")).toBe(false);
      expect(await more([output("hung5000", "finally")])).toEqual([expect.objectContaining({ id: "hung5000", result: "finally", done: true })]);
    } finally { chat.close(); }
  });

  test("long output is cut to the same text as ever", async () => {
    const long = "é".repeat(7999) + "🙂" + "x".repeat(12_000); // the cut lands inside the two-unit emoji
    const chat = await follow([call("big"), output("big", long), say("z".repeat(50_000))]);
    try {
      expect(chat.tail.items.find((x) => x.id === "big")).toMatchObject({ result: `${long.slice(0, 8000)}\n… 12001 more characters` });
      expect(chat.tail.items.at(-1)).toMatchObject({ k: "assistant", text: `${"z".repeat(40_000)}\n… 10000 more characters` });
    } finally { chat.close(); }
  });
});

describe("context size", () => {
  test("a compaction shows the smaller context at once, not after the next reply", async () => {
    const { writeFileSync } = await import("node:fs");
    const ts = new Date().toISOString();
    const usage = { input_tokens: 10, cache_read_input_tokens: 178_000, cache_creation_input_tokens: 500, output_tokens: 200 };
    const lines = [
      { type: "user", uuid: "u1", timestamp: ts, message: { role: "user", content: "hi" } },
      { type: "assistant", uuid: "a1", timestamp: ts, message: { model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "hello" }], usage } },
    ];
    const ctxOf = async (rows: object[]) => {
      const id = `transcript-test-compact-${crypto.randomUUID()}`; // a fresh tail each time
      const file = join(process.env.ANSAI_HOME!, `${id}.jsonl`);
      sessions.push(id);
      writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
      db.query(
        `INSERT INTO sessions (id, tool, title, cwd, argv, tmux_name, status, created_at, transcript)
         VALUES (?, 'claude', 'Claude Code', '/tmp/transcript-project', '[]', ?, 'running', ?, ?)`,
      ).run(id, `tmux-${id}`, Date.now(), file);
      const messages: string[] = [];
      const ws = { readyState: 1, send: (m: string) => messages.push(m) };
      await subscribeChat(id, ws as never);
      unsubscribeChat(id, ws as never);
      return messages.map((m) => JSON.parse(m)).find((m) => m.t === "init")?.ctx;
    };
    expect(await ctxOf(lines)).toBe(178_710);
    const compacted = [
      ...lines,
      { type: "system", subtype: "compact_boundary", uuid: "c1", timestamp: ts, content: "Conversation compacted", compactMetadata: { trigger: "manual", preTokens: 178_710, postTokens: 15_226 } },
      { type: "user", uuid: "u2", timestamp: ts, isCompactSummary: true, message: { role: "user", content: "This session is being continued…" } },
    ];
    expect(await ctxOf(compacted)).toBe(15_226);
  });
});

// A log is read through a small buffer, a slice at a time (reading a long one whole took
// a 12 MB buffer per running agent, all in the second after a restart).
describe("reading a log a slice at a time", () => {
  const file = (name: string, text: string | Buffer) => {
    const path = join(process.env.ANSAI_HOME!, `eachline-${name}-${crypto.randomUUID()}.txt`);
    writeFileSync(path, text);
    return path;
  };
  const read = async (path: string, start: number, skipFirst: boolean, slice: number, size = statSync(path).size) => {
    const got: [string, number][] = [];
    const end = await eachLine(path, start, (line, at) => got.push([line.toString("utf8"), at]), { end: size, skipFirst, slice });
    return { got, end };
  };

  test("the lines and their places are the same whatever the slice size", async () => {
    const text = 'first\n\n{"k":"second line, a longer one"}\nthird\n';
    const path = file("sizes", text);
    const whole = await read(path, 0, false, 1024 * 1024);
    expect(whole.got).toEqual([
      ["first", 0],
      ["", 6],
      ['{"k":"second line, a longer one"}', 7],
      ["third", 41],
    ]);
    expect(whole.end).toBe(text.length);
    for (const slice of [1, 2, 3, 5, 7, 16, 40, 41, 42]) expect(await read(path, 0, false, slice)).toEqual(whole);
  });

  test("a character cut in two by a slice comes out whole", async () => {
    const text = "ភាសាខ្មែរ 🙂 ok\nnext é\n";
    const path = file("utf8", text);
    for (const slice of [1, 2, 3, 4, 5, 64]) {
      const { got, end } = await read(path, 0, false, slice);
      expect(got.map((g) => g[0])).toEqual(["ភាសាខ្មែរ 🙂 ok", "next é"]);
      expect(end).toBe(Buffer.byteLength(text));
    }
  });

  test("a last line still being written is left for next time", async () => {
    const path = file("partial", "done\nhalf writ");
    const first = await read(path, 0, false, 4);
    expect(first.got).toEqual([["done", 0]]);
    expect(first.end).toBe(5);
    appendFileSync(path, "ten\n");
    expect((await read(path, first.end!, false, 4)).got).toEqual([["half written", 5]]);
  });

  test("nothing complete yet: nothing is handed over", async () => {
    expect(await read(file("none", "no newline here"), 0, false, 4)).toEqual({ got: [], end: null });
    expect(await read(file("empty", ""), 0, false, 4)).toEqual({ got: [], end: null });
    // Starting mid-line with only that line's end in reach: skipped, so still nothing.
    expect(await read(file("tail", "abcdef\n"), 3, true, 2)).toEqual({ got: [], end: null });
  });

  test("a read that starts mid-file skips the piece of a line it lands in", async () => {
    const path = file("mid", "aaaa\nbbbb\ncccc\n");
    for (const slice of [1, 3, 100]) {
      const { got, end } = await read(path, 2, true, slice);
      expect(got).toEqual([
        ["bbbb", 5],
        ["cccc", 10],
      ]);
      expect(end).toBe(15);
    }
  });

  test("it stops at the size it was given, and at a file that got shorter", async () => {
    const path = file("size", "one\ntwo\nthree\n");
    expect((await read(path, 0, false, 3, 8)).got).toEqual([
      ["one", 0],
      ["two", 4],
    ]);
    expect((await read(path, 0, false, 3, 500)).got.length).toBe(3); // told it was longer than it is
  });

  test("a long log is read without ever holding more than a slice of it", async () => {
    // 3 MB of lines, far more than the 64 KB buffer: every line still arrives, in order.
    const line = (n: number) => JSON.stringify({ n, pad: "x".repeat(900) });
    const count = 3000;
    const path = file("long", Array.from({ length: count }, (_, n) => line(n)).join("\n") + "\n");
    let next = 0;
    let wrong = 0;
    const end = await eachLine(path, 0, (l) => void (JSON.parse(l.toString("utf8")).n === next++ || wrong++), { slice: 64 * 1024 });
    expect(next).toBe(count);
    expect(wrong).toBe(0);
    expect(end).toBe(statSync(path).size);
  });
});

describe("following running agents nobody is watching", () => {
  test("each one's log is read, one after the other", async () => {
    const ts = "2026-01-02T03:04:05.000Z";
    const ids = [0, 1, 2].map(() => `transcript-test-bg-${crypto.randomUUID()}`);
    for (const [n, id] of ids.entries()) {
      const path = join(process.env.ANSAI_HOME!, `${id}.jsonl`);
      const edit = { type: "assistant", uuid: `e${n}`, timestamp: ts, message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id: `t${n}`, name: "Edit", input: { file_path: `/tmp/transcript-project/file-${n}.ts`, old_string: "a", new_string: "b" } }] } };
      writeFileSync(path, JSON.stringify(edit) + "\n");
      db.query(
        `INSERT INTO sessions (id, tool, title, cwd, argv, tmux_name, status, created_at, transcript)
         VALUES (?, 'claude', 'Background', '/tmp/transcript-project', '[]', ?, 'running', ?, ?)`,
      ).run(id, `tmux-${id}`, Date.now(), path);
      sessions.push(id);
    }
    const pass = pollRunningTails();
    await pollRunningTails(); // a pass already under way: this one steps aside at once
    await pass;
    for (const [n, id] of ids.entries()) {
      expect(tailOf(id)!.offset).toBeGreaterThan(0);
      expect(touchedFiles(db.query("SELECT * FROM sessions WHERE id = ?").get(id) as never)).toEqual([`file-${n}.ts`]);
    }
  });
});
