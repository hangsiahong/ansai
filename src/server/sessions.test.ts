// Restart picks an agent's conversation back up only while its prompt cache is warm.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { db, now: dbNow } = await import("./db");
const { HttpError } = await import("./errors");
const { captureHistory, paneError, resumableConversation, scroll, sendKeys, sendText } = await import("./sessions");

const dir = mkdtempSync(join(tmpdir(), "ansai-resume-"));
const claudeLog = join(dir, "4f1c2d3e-aaaa-4bbb-8ccc-0123456789ab.jsonl");
const codexLog = join(dir, "rollout-2026-11-16T00-15-48-01a1e035-3e69-7be1-bb5f-1c7981eee15a.jsonl");
writeFileSync(claudeLog, "{}\n");
writeFileSync(codexLog, "{}\n");
const now = Date.now();

describe("resumableConversation", () => {
  test("reads the conversation id from Claude's and Codex's log names", () => {
    expect(resumableConversation({ tool: "claude", transcript: claudeLog }, now)).toBe("4f1c2d3e-aaaa-4bbb-8ccc-0123456789ab");
    expect(resumableConversation({ tool: "codex", transcript: codexLog }, now)).toBe("01a1e035-3e69-7be1-bb5f-1c7981eee15a");
  });
  test("starts fresh once the cache has gone cold (55 minutes)", () => {
    expect(resumableConversation({ tool: "claude", transcript: claudeLog }, now + 54 * 60_000)).not.toBeNull();
    expect(resumableConversation({ tool: "claude", transcript: claudeLog }, now + 56 * 60_000)).toBeNull();
  });
  test("nothing to resume: no log, a missing file, or a tool without conversations", () => {
    expect(resumableConversation({ tool: "claude", transcript: null }, now)).toBeNull();
    expect(resumableConversation({ tool: "claude", transcript: join(dir, "gone-0000.jsonl") }, now)).toBeNull();
    expect(resumableConversation({ tool: "agy", transcript: claudeLog }, now)).toBeNull();
  });
});

// Input and history for a session tmux no longer has answer 409, not a tmux error (500).
function makeSession(id: string, status: "running" | "exited" | "closed") {
  db.query(
    `INSERT INTO sessions (id, tool, title, cwd, argv, tmux_name, status, created_at, msg_cursor)
     VALUES (?, 'claude', ?, '/tmp', '[]', ?, ?, ?, 0)`,
  ).run(id, `Session ${id}`, `ansai-${id}`, status, dbNow());
  return id;
}

async function statusOf(p: Promise<unknown>): Promise<number | string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof HttpError ? e.status : String(e);
  }
}

describe("a session that isn't running", () => {
  test("input to a session whose row has exited (or closed) answers 409", async () => {
    const exited = makeSession("s_409_exited", "exited");
    const closed = makeSession("s_409_closed", "closed");
    expect(await statusOf(sendText(exited, "hello"))).toBe(409);
    expect(await statusOf(sendKeys(exited, ["Enter"]))).toBe(409);
    expect(await statusOf(scroll(exited, "up"))).toBe(409);
    expect(await statusOf(sendText(closed, "hello"))).toBe(409);
  });

  test("tmux saying it lost the session or its server maps to 409; other tmux failures stay server faults", () => {
    for (const err of [
      "can't find session: ansai-s_x",
      "can't find pane: ansai-s_x",
      "no server running on /tmp/tmux-1000/ansai",
      "error connecting to /tmp/tmux-1000/ansai (No such file or directory)",
    ]) {
      const e = paneError(err);
      expect(e).toBeInstanceOf(HttpError);
      expect((e as InstanceType<typeof HttpError>).status).toBe(409);
      expect(e.message).toBe("this session isn't running; restart it");
    }
    const other = paneError("unknown command: frobnicate");
    expect(other).not.toBeInstanceOf(HttpError);
    expect(other.message).toBe("tmux: unknown command: frobnicate");
  });

  test("a row still marked running whose tmux is gone (before reconcile catches up) answers 409", async () => {
    // The test socket has no tmux server, as after the pane was killed and the server went with it.
    const id = makeSession("s_409_lagging", "running");
    expect(await statusOf(sendText(id, "hello"))).toBe(409);
    expect(await statusOf(sendKeys(id, ["Enter"]))).toBe(409);
    expect(await statusOf(captureHistory(id))).toBe(409);
  });
});
