// A hook or tool call that says "I am session X" is believed only with X's secret key.
// The session id alone used to be enough, and list_agents hands every agent its
// teammates' ids: one agent could send a message recorded as another's.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { db, now } = await import("./db");
const { config } = await import("./config");
const sessions = await import("./sessions");
const { KEY_ENV, callerAllowed, hasSessionKey, sessionKey, shownKey } = await import("./sessionkeys");
const { withHooks, writeHookFiles } = await import("./hooks");
const { mcpHttp } = await import("./mcp");

const made: string[] = [];
/** A session row as an agent started before keys existed has it: no key on file. */
function oldSession(id: string) {
  made.push(id);
  db.query(
    `INSERT INTO sessions (id, tool, title, cwd, argv, tmux_name, status, created_at, msg_cursor)
     VALUES (?, 'shell', ?, ?, ?, ?, 'running', ?, 0)`,
  ).run(id, `Key test ${id}`, tmpdir(), JSON.stringify(["sh"]), `ansai-${id}`, now());
}

// A stand-in tmux that remembers what it was asked to run.
let calls: string[][] = [];
let failRespawn = false;
const realTmux = sessions.setTmux(async (args) => {
  calls.push(args);
  if (args[0] === "list-panes") {
    // Every running session has a live pane, so nothing here is taken for exited.
    const rows = db.query("SELECT tmux_name FROM sessions WHERE status = 'running'").all() as { tmux_name: string }[];
    return { code: 0, out: rows.map((r) => `${r.tmux_name}\t0\t\tsh\t${Math.floor(Date.now() / 1000)}\t0`).join("\n"), err: "" };
  }
  if (args[0] === "respawn-pane" && failRespawn) return { code: 1, out: "", err: "can't find pane" };
  return { code: 0, out: "", err: "" };
});

afterAll(() => {
  sessions.setTmux(realTmux);
  for (const id of made) {
    db.query("DELETE FROM sessions WHERE id = ?").run(id);
    db.query("DELETE FROM session_keys WHERE session_id = ?").run(id);
    db.query("DELETE FROM messages WHERE from_session = ?").run(id);
  }
  db.query("DELETE FROM settings WHERE key LIKE 'compact-tool:skey%'").run();
});

const rpc = (session: string, key: string | null, body: object) =>
  mcpHttp(
    new Request(`http://127.0.0.1/mcp?s=${session}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
    }),
  );

describe("who a call is believed to come from", () => {
  test("an id ansai has never seen is refused", () => {
    expect(callerAllowed("skeynobody", null)).toBe(false);
    expect(callerAllowed("skeynobody", "anything")).toBe(false);
    expect(callerAllowed("", null)).toBe(false);
  });

  test("a session with a key needs exactly that key", () => {
    oldSession("skeyone");
    const key = sessionKey("skeyone");
    expect(key.length).toBeGreaterThanOrEqual(32);
    expect(sessionKey("skeyone")).toBe(key); // the same one every time
    expect(callerAllowed("skeyone", key)).toBe(true);
    expect(callerAllowed("skeyone", null)).toBe(false);
    expect(callerAllowed("skeyone", "")).toBe(false);
    expect(callerAllowed("skeyone", key.slice(0, -1))).toBe(false);
    expect(callerAllowed("skeyone", key + "x")).toBe(false);
  });

  test("another session's key doesn't work", () => {
    oldSession("skeytwo");
    expect(callerAllowed("skeyone", sessionKey("skeytwo"))).toBe(false);
  });

  test("an agent started before keys existed is still believed", () => {
    oldSession("skeyold");
    expect(hasSessionKey("skeyold")).toBe(false);
    expect(callerAllowed("skeyold", null)).toBe(true);
  });

  test("the key is read from the Authorization header", () => {
    const req = (h: Record<string, string>) => new Request("http://127.0.0.1/mcp?s=x", { headers: h });
    expect(shownKey(req({ authorization: "Bearer abc-_123" }))).toBe("abc-_123");
    expect(shownKey(req({ authorization: "Bearer " }))).toBe(null); // an agent with no key in its environment
    expect(shownKey(req({}))).toBe(null);
  });
});

describe("the tool server", () => {
  test("a made-up session is turned away, and leaves nothing behind", async () => {
    const res = await rpc("skeymadeup", null, { method: "tools/list" });
    expect(res.status).toBe(403);
    expect(db.query("SELECT 1 FROM settings WHERE key = 'compact-tool:skeymadeup'").get()).toBeNull();
  });

  test("one agent can't send a message as another", async () => {
    const send = { method: "tools/call", params: { name: "send_message", arguments: { to: "all", message: "forged" } } };
    const count = () => (db.query("SELECT COUNT(*) AS n FROM messages WHERE from_session = 'skeyone'").get() as { n: number }).n;
    const before = count();
    expect((await rpc("skeyone", null, send)).status).toBe(403);
    expect((await rpc("skeyone", sessionKey("skeytwo"), send)).status).toBe(403);
    expect(count()).toBe(before);
    const ok = await rpc("skeyone", sessionKey("skeyone"), { method: "tools/list" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0);
  });
});

describe("how the key reaches the agent", () => {
  test("Claude and Codex read it from their environment: it is never on the command line", () => {
    oldSession("skeycli");
    const key = sessionKey("skeycli");
    const claude = withHooks("claude", ["claude", "do it"], "skeycli");
    const codex = withHooks("codex", ["codex"], "skeycli");
    expect(claude.join(" ")).not.toContain(key);
    expect(codex.join(" ")).not.toContain(key);
    const mcp = JSON.parse(claude[claude.indexOf("--mcp-config") + 1]!).mcpServers.ansai;
    expect(mcp.headers.Authorization).toBe("Bearer ${" + KEY_ENV + "}");
    expect(mcp.url).toContain("?s=skeycli");
    expect(codex).toContain(`mcp_servers.ansai.bearer_token_env_var="${KEY_ENV}"`);
    expect(codex.find((a) => a.startsWith("notify="))).toContain(`-H "authorization: Bearer $${KEY_ENV}"`);
  });

  test("every Claude hook shows it", () => {
    writeHookFiles();
    const file = JSON.parse(readFileSync(join(config.dataDir, "claude-hooks.json"), "utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    const commands = Object.values(file.hooks).flatMap((e) => e.flatMap((x) => x.hooks.map((h) => h.command)));
    expect(commands.length).toBeGreaterThan(5);
    for (const c of commands) expect(c).toContain(`-H "authorization: Bearer $${KEY_ENV}"`);
  });

  test("a new session gets its key in its environment, and nothing ansai shows carries it", async () => {
    calls = [];
    const view = await sessions.createSession({ tool: "shell", cwd: tmpdir(), title: "Key test new" });
    made.push(view.id);
    const key = sessionKey(view.id);
    const start = calls.find((c) => c[0] === "new-session")!;
    expect(start).toContain(`${KEY_ENV}=${key}`);
    expect(start[start.indexOf(`${KEY_ENV}=${key}`) - 1]).toBe("-e");
    expect(callerAllowed(view.id, null)).toBe(false);
    expect(callerAllowed(view.id, key)).toBe(true);
    expect(JSON.stringify(view)).not.toContain(key);
    expect(JSON.stringify(sessions.listSessions({ includeClosed: true }))).not.toContain(key);
    expect(JSON.stringify(sessions.getSession(view.id))).not.toContain(key);
  });

  test("restarting an older agent gives it a key; from then on it must show it", async () => {
    oldSession("skeyrestart");
    calls = [];
    await sessions.restartSession("skeyrestart");
    const key = sessionKey("skeyrestart");
    expect(calls.find((c) => c[0] === "respawn-pane")).toContain(`${KEY_ENV}=${key}`);
    expect(callerAllowed("skeyrestart", null)).toBe(false);
    expect(callerAllowed("skeyrestart", key)).toBe(true);
  });

  test("a restart that fails leaves the older agent believed as before", async () => {
    oldSession("skeyfail");
    failRespawn = true;
    try {
      await expect(sessions.restartSession("skeyfail")).rejects.toThrow(/tmux/);
    } finally {
      failRespawn = false;
    }
    expect(hasSessionKey("skeyfail")).toBe(false);
    expect(callerAllowed("skeyfail", null)).toBe(true);
  });
});
