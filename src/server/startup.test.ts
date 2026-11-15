// Startup dialogs (trust this folder, …) must never leak onto a later real approval:
// QA's t2t6g3t4m23 — stale "Exit" pressed Enter on a permission prompt, and the
// watcher then wiped the real "Needs you".
import { beforeEach, describe, expect, test } from "bun:test";

const { db, now } = await import("./db");
const { getSession, sessionView, rememberStartup, hasStartup } = await import("./sessions");
const { handleHook, startupScreen } = await import("./hooks");

const TRUST = "Claude asks whether you trust this folder before it starts.";
const trust = { kind: "trust", message: TRUST, accept: "Trust folder", acceptKeys: ["Down", "Enter"], decline: "Exit", declineKeys: ["Enter"] };
const PERMISSION = { message: "Claude needs your permission to use Bash", notification_type: "permission_prompt" };

beforeEach(() => {
  db.exec("DELETE FROM sessions;");
  db.query(
    `INSERT INTO sessions (id, tool, title, cwd, argv, tmux_name, status, agent_state, agent_message, created_at)
     VALUES ('c1', 'claude', 'T', '/tmp', '[]', 'ansai-c1', 'running', 'needs-input', ?, ?)`,
  ).run(TRUST, now());
  rememberStartup("c1", trust);
});
const view = () => sessionView(getSession("c1")!);

describe("startup dialogs vs real approvals", () => {
  test("on the trust screen, its own buttons show", () => {
    expect(view().startup?.kind).toBe("trust");
  });

  test("any Claude hook means it's past the screen: the entry is forgotten", () => {
    handleHook("claude", "SessionStart", "c1", {});
    expect(hasStartup("c1")).toBe(false);
    expect(view().startup).toBeNull();
    expect(view().agent_state).toBe("waiting");
  });

  test("a later permission prompt gets Allow/Deny, never the stale startup buttons", () => {
    // Worst case: the entry somehow survived (e.g. hooks arrived out of order).
    db.query("UPDATE sessions SET agent_state = 'waiting', agent_message = NULL WHERE id = 'c1'").run();
    handleHook("claude", "Notification", "c1", PERMISSION);
    rememberStartup("c1", trust); // stale again, after the hook
    expect(view().agent_state).toBe("needs-input");
    expect(view().startup).toBeNull(); // shown only while the message is the dialog's
  });

  test("clearing a vanished dialog never wipes a real Needs you", () => {
    db.query("UPDATE sessions SET agent_message = ? WHERE id = 'c1'").run(PERMISSION.message);
    startupScreen("c1", null, TRUST); // what the watcher does when the dialog is gone
    expect(view().agent_state).toBe("needs-input");
    expect(view().agent_message).toBe(PERMISSION.message);
  });

  test("…but it does undo its own Needs you once the dialog is gone", () => {
    startupScreen("c1", null, TRUST);
    expect(view().agent_state).toBeNull();
  });
});
