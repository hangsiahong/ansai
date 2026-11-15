import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { db, now } from "./db";
import { emit } from "./events";
import { notify } from "./push";
import { isWatched } from "./viewers";
import { dropClaims, editWarning, takePending, wakes } from "./team";
import { getSession } from "./sessions";
import { claudeStop, codexTurnEnded, shiftWorked } from "./shifts";

const EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
import type { ToolId } from "./tools";

/**
 * Real agent status. Claude Code gets a hooks file via `--settings` (merged with
 * your own settings, never written into them); Codex gets a `notify` override
 * via `-c`. Both call back to ansai on 127.0.0.1 with the session id from the
 * environment tmux gives each session.
 */

const hooksFile = join(config.dataDir, "claude-hooks.json");
const base = () => `http://127.0.0.1:${config.port}/api/hooks`;

export function writeHookFiles() {
  // `speaks`: Claude reads the hook's stdout, so ansai can hand over team messages as
  // additionalContext. ansai answers those with an empty body when it has nothing to say.
  const cmd = (event: string, speaks = false) =>
    `curl -s${speaks ? "f" : ""} -m 2 -X POST -H 'content-type: application/json' --data-binary @- "${base()}/claude/${event}?s=$ANSAI_SESSION_ID"${speaks ? " 2>/dev/null" : " >/dev/null 2>&1"} || true`;
  const entry = (event: string, o: { matcher?: string; speaks?: boolean } = {}) => [
    { ...(o.matcher ? { matcher: o.matcher } : {}), hooks: [{ type: "command", command: cmd(event, o.speaks), timeout: 5 }] },
  ];
  const settings = {
    hooks: {
      SessionStart: entry("SessionStart"),
      UserPromptSubmit: entry("UserPromptSubmit", { speaks: true }),
      PreToolUse: entry("PreToolUse", { matcher: "*" }),
      PostToolUse: entry("PostToolUse", { matcher: "*", speaks: true }),
      Notification: entry("Notification"),
      Stop: entry("Stop", { speaks: true }),
    },
  };
  writeFileSync(hooksFile, JSON.stringify(settings, null, 2));
}

const codexNotify = () =>
  // TOML array; the literal string ('…') keeps the shell script's double quotes intact. Codex appends the JSON event as $1.
  `notify=["sh", "-c", 'curl -s -m 2 -X POST -H "content-type: application/json" --data-binary "$1" "${base()}/codex/turn?s=$ANSAI_SESSION_ID" >/dev/null 2>&1 || true', "ansai-notify"]`;

/** What every agent started from ansai is told about the backlog tools (kept short). */
const AGENT_NOTE =
  "You are running inside ansai, the user's control room for coding agents. " +
  "An MCP server named \"ansai\" gives you the user's backlog: " +
  "call add_task to record follow-up work you notice (bugs, refactors, missing tests) instead of doing it unasked; " +
  "if you were given a backlog task, call finish_task with a 2-3 sentence summary when it is done. " +
  "If a task is unclear or needs a decision, ask the user before changing anything. " +
  "Other agents may be working at the same time: list_agents shows them and the files they are editing or have claimed (claim_files before a bigger change to shared code), " +
  "and send_message reaches one of them (or everyone in the project) — use it to avoid clashing edits, hand over findings, or ask a teammate who owns that code. " +
  "Messages to you arrive by themselves, marked \"ansai: … from your team\".";

const mcpUrl = (sessionId: string) => `http://127.0.0.1:${config.port}/mcp?s=${sessionId}`;
const toml = (s: string) => JSON.stringify(s); // TOML basic strings share JSON's escaping for our text

/** Add status hooks, the ansai MCP server and the backlog note to an agent's command line. */
export function withHooks(tool: ToolId, argv: string[], sessionId: string): string[] {
  if (tool === "claude")
    return [
      argv[0]!,
      "--settings",
      hooksFile,
      "--mcp-config",
      JSON.stringify({ mcpServers: { ansai: { type: "http", url: mcpUrl(sessionId) } } }),
      "--append-system-prompt",
      AGENT_NOTE,
      ...argv.slice(1),
    ];
  if (tool === "codex")
    return [
      argv[0]!,
      "-c",
      codexNotify(),
      "-c",
      `mcp_servers.ansai.url=${toml(mcpUrl(sessionId))}`,
      "-c",
      `developer_instructions=${toml(AGENT_NOTE)}`,
      ...argv.slice(1),
    ];
  return argv;
}

// --------------------------------------------------------------- receiving

type Row = { id: string; title: string; tool: string; task_id: string | null; agent_state: string | null; status: string };

function setState(s: Row, state: string, message: string | null = null) {
  db.query("UPDATE sessions SET agent_state = ?, agent_state_at = ?, agent_message = ? WHERE id = ?").run(state, now(), message, s.id);
  emit("sessions");
}

function moveTask(taskId: string | null, from: string, to: string) {
  if (!taskId) return;
  const r = db.query("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ?").run(to, now(), taskId, from);
  if (r.changes) emit("tasks");
}

const clip = (s: unknown, n = 140) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

function push(s: Row, kind: "input" | "done", body: string) {
  if (isWatched(s.id)) return; // you're looking at it already
  const title = kind === "input" ? `Needs you · ${s.title}` : `Done · ${s.title}`;
  notify(kind, { title, body, url: `/s/${s.id}`, tag: `s-${s.id}` }).catch(() => {});
}

/** What Claude reads back from a hook: extra context for the model (team messages), or "keep going" (shifts). */
export type HookReply = { hookSpecificOutput?: { hookEventName: string; additionalContext: string }; decision?: "block"; reason?: string };
const context = (event: string, text: string): HookReply => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

export function handleHook(tool: string, event: string, sessionId: string, payload: any): HookReply | undefined {
  const s = db.query("SELECT id, title, tool, task_id, agent_state, status FROM sessions WHERE id = ?").get(sessionId) as Row | null;
  if (!s || s.status === "closed") return;

  // Every Claude hook names the conversation log; /clear starts a new one.
  if (tool === "claude" && typeof payload?.transcript_path === "string" && payload.transcript_path.endsWith(".jsonl")) {
    db.query("UPDATE sessions SET transcript = ? WHERE id = ? AND COALESCE(transcript, '') != ?").run(payload.transcript_path, s.id, payload.transcript_path);
  }

  if (tool === "claude") {
    switch (event) {
      case "SessionStart": {
        // Claude names its model at startup; the effort only shows up in the log with the first reply.
        const model = typeof payload?.model === "string" ? payload.model : null;
        if (model)
          db.query("UPDATE sessions SET model = ?, effort = CASE WHEN COALESCE(model, '') = ? THEN effort END WHERE id = ?").run(model, model, s.id);
        setState(s, "waiting");
        return;
      }
      case "UserPromptSubmit": {
        moveTask(s.task_id, "review", "doing");
        setState(s, "working");
        const msgs = takePending(s.id);
        return msgs ? context(event, msgs) : undefined;
      }
      case "PreToolUse":
        if (s.agent_state !== "working") setState(s, "working");
        return;
      case "PostToolUse": {
        shiftWorked(s.id);
        const msgs = takePending(s.id);
        const file = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
        const full = typeof file === "string" && EDITS.has(String(payload?.tool_name)) ? getSession(s.id) : null;
        const warn = full ? editWarning(full, file) : null;
        const text = [warn, msgs].filter(Boolean).join("\n\n");
        return text ? context(event, text) : undefined;
      }
      case "Notification": {
        const msg = clip(payload?.message);
        const type = String(payload?.notification_type ?? "");
        const idle = type === "idle_prompt" || /waiting for your input/i.test(msg);
        if (idle) {
          setState(s, "waiting", msg);
          return;
        }
        setState(s, "needs-input", msg);
        push(s, "input", msg || "Waiting for your approval");
        return;
      }
      case "Stop": {
        // Messages that arrived during the turn and are worth another turn (direct ones, or yours):
        // Claude reads them and keeps going. Other agents' broadcasts wait for its next turn.
        const full = getSession(s.id);
        const msgs = full && wakes(full) ? takePending(s.id) : null;
        if (msgs) {
          if (s.agent_state !== "working") setState(s, "working");
          return context(event, msgs);
        }
        // On shift: Claude gets its next prompt and continues in the same turn.
        const keepGoing = claudeStop(getSession(s.id)!);
        if (keepGoing) {
          if (s.agent_state !== "working") setState(s, "working");
          return keepGoing;
        }
        const was = s.agent_state;
        setState(s, "waiting");
        moveTask(s.task_id, "doing", "review");
        if (was === "working" || was === "needs-input") push(s, "done", "Finished — your turn.");
        return;
      }
    }
    return;
  }

  if (tool === "codex" && event === "turn" && payload?.type === "agent-turn-complete") {
    const last = clip(payload["last-assistant-message"]);
    setState(s, "waiting", last || null);
    // On shift the next prompt gets typed in shortly (shifts.nudgeIdle), so the task stays in Doing and no push goes out.
    if (codexTurnEnded(getSession(s.id)!)) return;
    moveTask(s.task_id, "doing", "review");
    push(s, "done", last || "Finished — your turn.");
  }
}

/** Codex has no approval hook: the reconciler reports what its screen shows. */
export function codexScreen(id: string, prompt: string | null) {
  const s = db.query("SELECT id, title, tool, task_id, agent_state, status FROM sessions WHERE id = ?").get(id) as Row | null;
  if (!s || s.status !== "running") return;
  if (prompt && s.agent_state !== "needs-input") {
    setState(s, "needs-input", prompt);
    push(s, "input", prompt);
  } else if (!prompt && s.agent_state === "needs-input") {
    setState(s, "working");
  }
}

/** A startup dialog appeared (message) or went away (null) on a Claude screen. */
export function startupScreen(id: string, message: string | null) {
  const s = db.query("SELECT id, title, tool, task_id, agent_state, status FROM sessions WHERE id = ?").get(id) as Row | null;
  if (!s || s.status !== "running") return;
  if (message) {
    setState(s, "needs-input", message);
    push(s, "input", message);
  } else if (s.agent_state === "needs-input") {
    // Hooks take over from here (SessionStart sets "waiting").
    db.query("UPDATE sessions SET agent_state = NULL, agent_message = NULL WHERE id = ? AND agent_state = 'needs-input'").run(id);
    emit("sessions");
  }
}

/** Called by the reconciler when an agent process exits. */
export function onExited(id: string, code: number | null) {
  const s = db.query("SELECT id, title, tool, task_id, agent_state, status FROM sessions WHERE id = ?").get(id) as Row | null;
  if (!s) return;
  dropClaims(id);

  // If the process disappeared before finish_task (or a turn-complete hook),
  // release the task from Doing so it cannot look active forever or block the
  // project's next queued task. Keep it for the user to review and rerun.
  // Leave it alone while another session (a rerun) is still working the task.
  if (s.task_id) {
    const reason = code === null
      ? "The agent session ended before the task was marked complete. Check the session, then rerun or update the task."
      : `The agent session exited with code ${code} before the task was marked complete. Check the session, then rerun or update the task.`;
    const recovered = db.query(
      `UPDATE tasks SET status = 'review', summary = COALESCE(summary, ?), updated_at = ? WHERE id = ? AND status = 'doing'
         AND NOT EXISTS (SELECT 1 FROM sessions WHERE task_id = ? AND id != ? AND status = 'running')`,
    ).run(reason, now(), s.task_id, s.task_id, s.id);
    if (recovered.changes) emit("tasks");
  }

  if (isWatched(id) || !code) return; // clean exits are expected
  notify("exited", { title: `Exited · ${s.title}`, body: `The agent stopped with code ${code}.`, url: `/s/${id}`, tag: `s-${id}` }).catch(() => {});
}
