import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

const { db } = await import("./db");
const { subscribeChat, touchedFiles, unsubscribeChat } = await import("./transcripts");

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
