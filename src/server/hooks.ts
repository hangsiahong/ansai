import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { leanSettings } from "./lean";
import { db, now } from "./db";
import { emit } from "./events";
import { notify } from "./push";
import { isWatched } from "./viewers";
import { dropClaims, editWarning, getPlaybook, takePending, wakes } from "./team";
import { compacted, compactionRunning, contextNudge, dropCompaction, startCompaction } from "./compaction";
import { clearStartup, getSession, sessionView } from "./sessions";
import { claudeStop, codexTurnEnded, endShift, shiftView, shiftWorked } from "./shifts";

const EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
import type { ToolId } from "./tools";

/**
 * Real agent status. Claude Code gets a hooks file via `--settings` (merged with
 * your own settings, never written into them); Codex gets a `notify` override
 * via `-c`. Both call back to ansai on 127.0.0.1 with the session id from the
 * environment tmux gives each session.
 */

const hooksFile = join(config.dataDir, "claude-hooks.json");
/** The hooks plus lean startup's settings (see lean.ts), rewritten at each lean launch. */
const leanHooksFile = join(config.dataDir, "claude-hooks-lean.json");
const base = () => `http://127.0.0.1:${config.port}/api/hooks`;

function hookSettings() {
  // `speaks`: Claude reads the hook's stdout, so ansai can hand over team messages as
  // additionalContext. ansai answers those with an empty body when it has nothing to say.
  const cmd = (event: string, speaks = false) =>
    `curl -s${speaks ? "f" : ""} -m 2 -X POST -H 'content-type: application/json' --data-binary @- "${base()}/claude/${event}?s=$ANSAI_SESSION_ID${speaks ? "&r=1" : ""}"${speaks ? " 2>/dev/null" : " >/dev/null 2>&1"} || true`;
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
      PreCompact: entry("PreCompact"),
      Stop: entry("Stop", { speaks: true }),
      // Fires instead of Stop when an API error ended the turn (usage limit, overloaded, login…).
      StopFailure: entry("StopFailure"),
    },
  };
  return settings;
}

export function writeHookFiles() {
  writeFileSync(hooksFile, JSON.stringify(hookSettings(), null, 2));
}

/**
 * The file a Claude agent gets as --settings: the status hooks, plus lean startup's
 * settings when it's on. Claude reads only the last --settings it's given, so both
 * go in one file, written whole (a rename) so an agent starting meanwhile never
 * reads half of it.
 */
function claudeSettingsFile(lean: boolean, configDir: string): string {
  if (!lean) return hooksFile;
  const settings = { ...hookSettings(), ...leanSettings(configDir) };
  const tmp = `${leanHooksFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2));
  renameSync(tmp, leanHooksFile);
  return leanHooksFile;
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

/** The project's playbook as a block for the agent's system-level instructions ("" when it has none). */
export function playbookNote(projectId: string | null | undefined): string {
  const text = projectId ? getPlaybook(projectId).trim() : "";
  return text ? `The user's playbook for this project (standing instructions; follow them in all your work here):\n${text}` : "";
}

export type HookOpts = {
  /** Lean startup (lean.ts): leave out claude.ai connectors and chat-channel plugins. */
  lean?: boolean;
  /** The agent's Claude config folder (CLAUDE_CONFIG_DIR of its account), for its installed plugins. */
  configDir?: string;
};

/**
 * Add status hooks, the ansai MCP server and the backlog note to an agent's command line.
 * The project's playbook rides along with the note as system-level instructions
 * (Claude's --append-system-prompt, Codex's developer_instructions): agents follow
 * those reliably, and it never becomes a prompt of its own. (MCP server instructions
 * were tried first; neither agent acted on them.)
 * Claude gets ansai's tools up front (`alwaysLoad`), not deferred behind tool search:
 * almost every agent calls finish_task or a team tool, and each deferred one cost a
 * ToolSearch round trip first.
 */
export function withHooks(tool: ToolId, argv: string[], sessionId: string, playbook = "", instructions?: string, o: HookOpts = {}): string[] {
  const note = instructions ?? (playbook ? `${AGENT_NOTE}\n\n${playbook}` : AGENT_NOTE);
  if (tool === "claude")
    return [
      argv[0]!,
      "--settings",
      claudeSettingsFile(!!o.lean, o.configDir ?? join(config.home, ".claude")),
      "--mcp-config",
      JSON.stringify({ mcpServers: { ansai: { type: "http", url: mcpUrl(sessionId), alwaysLoad: true } } }),
      "--append-system-prompt",
      note,
      ...argv.slice(1),
    ];
  if (tool === "codex")
    return [
      argv[0]!,
      "-c",
      codexNotify(),
      "-c",
      `mcp_servers.ansai.url=${toml(mcpUrl(sessionId))}`,
      // ansai's own tools (backlog, team messages) are safe; without this Codex stops to ask before each one.
      "-c",
      `mcp_servers.ansai.default_tools_approval_mode="approve"`,
      "-c",
      `developer_instructions=${toml(note)}`,
      ...argv.slice(1),
    ];
  return argv;
}

// --------------------------------------------------------------- receiving

type Row = { id: string; title: string; tool: string; task_id: string | null; agent_state: string | null; status: string; auto?: number };

/** An autopilot run that dies mid-task is started again this many times (with a handoff) before it waits for you. */
export const AUTO_RETRIES = 1;

function setState(s: Row, state: string, message: string | null = null) {
  db.query("UPDATE sessions SET agent_state = ?, agent_state_at = ?, agent_message = ? WHERE id = ?").run(state, now(), message, s.id);
  emit("sessions");
}

function moveTask(taskId: string | null, from: string, to: string) {
  if (!taskId) return;
  const r = db.query("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ?").run(to, now(), taskId, from);
  if (r.changes) emit("tasks");
}

/** A reviewer shares the task link for MCP context, but never owns task lifecycle. */
function isTaskReviewer(sessionId: string): boolean {
  return !!db.query("SELECT 1 FROM sessions s WHERE s.id = ? AND (s.title LIKE 'Review · %' OR EXISTS (SELECT 1 FROM task_reviews r WHERE r.session_id = s.id))").get(sessionId);
}

const clip = (s: unknown, n = 140) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** A button on a "needs you" notification: the keys it presses in the agent's terminal. */
export type PushAction = { id: string; title: string; keys: string[] };
// Tool approvals (Claude's permission prompt, Codex's): Enter takes the preselected yes, Esc says no.
const APPROVAL_ACTIONS: PushAction[] = [
  { id: "allow", title: "Allow", keys: ["Enter"] },
  { id: "deny", title: "Deny", keys: ["Escape"] },
];

function push(s: Row, kind: "input" | "done", body: string, actions: PushAction[] = []) {
  if (s.task_id) {
    if (kind === "input") db.query("UPDATE schedule_occurrences SET status='needs_attention', outcome=? WHERE task_id=?").run(body.slice(0, 1000), s.task_id);
    else db.query("UPDATE schedule_occurrences SET status=CASE WHEN (SELECT summary FROM tasks WHERE id=?) IS NULL THEN 'needs_attention' ELSE 'completed' END, outcome=? WHERE task_id=?").run(s.task_id, body.slice(0, 1000), s.task_id);
  }
  if (isWatched(s.id)) return; // you're looking at it already
  const title = kind === "input" ? `Needs you · ${s.title}` : `Done · ${s.title}`;
  // `since` pins the buttons to this prompt: if the agent has moved on, the server refuses them.
  const since = (db.query("SELECT agent_state_at FROM sessions WHERE id = ?").get(s.id) as { agent_state_at: number | null } | null)?.agent_state_at ?? null;
  notify(kind, { title, body, url: `/s/${s.id}`, tag: `s-${s.id}`, ...(actions.length ? { session: s.id, since, actions } : {}) }).catch(() => {});
}

/** What Claude reads back from a hook: extra context for the model (team messages), or "keep going" (shifts). */
export type HookReply = { hookSpecificOutput?: { hookEventName: string; additionalContext: string }; decision?: "block"; reason?: string };
const context = (event: string, text: string): HookReply => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

/** Claude compactions that Claude started itself, mid-turn (PreCompact trigger "auto"). */
const autoCompacting = new Set<string>();

/** The agent finished its turn and waits for you: its task goes to Review and you get a push. */
function turnEnded(s: Row, was: string | null) {
  setState(s, "waiting");
  if (!isTaskReviewer(s.id)) {
    moveTask(s.task_id, "doing", "review");
    if (was === "working" || was === "needs-input") push(s, "done", "Finished — your turn.");
  }
}

/** Why Claude's turn ended on an API error (its StopFailure hook), in plain words. */
const STOP_FAILURES: Record<string, string> = {
  rate_limit: "it hit this account's usage limit",
  overloaded: "Claude's servers were overloaded",
  server_error: "Claude's servers had an error",
  authentication_failed: "its login stopped working (sign in again on the Accounts page)",
  oauth_org_not_allowed: "its login isn't allowed for this organisation",
  account_on_hold: "the account is on hold",
  verification_required: "the account needs verifying",
  billing_error: "there's a billing problem on the account",
  invalid_request: "Claude refused the request",
  model_not_found: "the model it was set to use isn't available on this account",
  cloud_credential_error: "its cloud login stopped working",
  max_output_tokens: "its reply hit the output limit",
};
/** Errors that go away by themselves: an agent on shift may try again. The rest need you. */
const PASSING_FAILURES = new Set(["overloaded", "server_error", "max_output_tokens", "unknown"]);

/**
 * The turn ended on an API error, so no Stop hook comes. Without this the session
 * showed Working and its task sat in Doing, holding an autopilot slot, all night.
 */
function turnFailed(s: Row, payload: any) {
  const error = typeof payload?.error === "string" ? payload.error : "unknown";
  const why = STOP_FAILURES[error] ?? `the API returned an error (${clip(error.replace(/_/g, " "), 60)})`;
  // A shift would type the next prompt straight into the same error, twice, and then report "ran out of work".
  if (!PASSING_FAILURES.has(error) && shiftView(s.id)?.active) endShift(s.id, "error");
  setState(s, "waiting", `Stopped: ${why}`);
  if (shiftView(s.id)?.active) return; // a passing error: the shift's next prompt is the retry
  if (isTaskReviewer(s.id)) return;
  if (s.task_id) {
    const r = db.query("UPDATE tasks SET status = 'review', last_failure = ?, updated_at = ? WHERE id = ? AND status = 'doing'").run(why, now(), s.task_id);
    if (r.changes) emit("tasks");
  }
  push(s, "input", `Stopped before finishing: ${why}.`);
}

/**
 * `reads`: Claude reads this hook's reply (the hooks file marks those commands with r=1).
 * Agents started with an older hooks file send their output to /dev/null, so anything
 * handed over there would be lost: team messages stay queued (they get typed in when the
 * agent is idle) and a shift lets the agent stop, then types its next prompt instead.
 */
export function handleHook(tool: string, event: string, sessionId: string, payload: any, reads = true): HookReply | undefined {
  const s = db.query("SELECT id, title, tool, task_id, agent_state, status FROM sessions WHERE id = ?").get(sessionId) as Row | null;
  if (!s || s.status === "closed") return;
  // Hooks run only once the agent is past its startup screens: forget any dialog seen before.
  if (tool === "claude" || (tool === "codex" && event === "turn")) clearStartup(sessionId);

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
        if (payload?.source === "compact") {
          const autoTrigger = autoCompacting.delete(s.id);
          const mine = compacted(s.id); // one the agent asked ansai for
          if (mine?.continues) return void setState(s, "working", "Picking up after compacting");
          if (mine) return void turnEnded(s, "working"); // it said it would wait for you
          if (autoTrigger) return; // Claude's own, mid-turn: it carries on by itself
        }
        setState(s, "waiting");
        return;
      }
      case "PreCompact": {
        // Yours (/compact), the agent's (ansai typed it), or Claude's own near its limit: all take a minute.
        if (payload?.trigger === "auto") autoCompacting.add(s.id);
        setState(s, "working", "Compacting the conversation");
        return;
      }
      case "UserPromptSubmit": {
        // /compact isn't a prompt: PreCompact covers it, and queued team messages must not ride along into it.
        if (typeof payload?.prompt === "string" && /^\/compact\b/.test(payload.prompt.trim())) return;
        if (!isTaskReviewer(s.id)) moveTask(s.task_id, "review", "doing");
        setState(s, "working");
        const msgs = reads ? takePending(s.id) : null;
        return msgs ? context(event, msgs) : undefined;
      }
      case "PreToolUse":
        if (s.agent_state !== "working") setState(s, "working");
        // Also counts as shift work here: agents started before PostToolUse was hooked only send PreToolUse.
        shiftWorked(s.id, payload?.tool_name);
        return;
      case "PostToolUse": {
        shiftWorked(s.id, payload?.tool_name);
        if (!reads) return;
        const msgs = takePending(s.id);
        const file = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
        const full = typeof file === "string" && EDITS.has(String(payload?.tool_name)) ? getSession(s.id) : null;
        const warn = full ? editWarning(full, file) : null;
        const text = [warn, msgs, contextNudge(s.id)].filter(Boolean).join("\n\n");
        return text ? context(event, text) : undefined;
      }
      case "Notification": {
        const msg = clip(payload?.message);
        const type = String(payload?.notification_type ?? "");
        const idle = type === "idle_prompt" || /waiting for your input/i.test(msg);
        if (idle) {
          // Claude says it has sat at its prompt for a minute, yet ansai still has it mid-turn: the
          // turn's Stop hook never arrived (ansai was restarting, or the agent predates StopFailure).
          // End the turn now. On shift, "waiting" is enough: the next prompt gets typed in.
          if (s.agent_state === "working" && !compactionRunning(s.id) && !shiftView(s.id)?.active) return void turnEnded(s, "working");
          setState(s, "waiting", msg);
          return;
        }
        setState(s, "needs-input", msg);
        push(s, "input", msg || "Waiting for your approval", APPROVAL_ACTIONS);
        return;
      }
      case "Stop": {
        // Messages that arrived during the turn and are worth another turn (direct ones, or yours):
        // Claude reads them and keeps going. Other agents' broadcasts wait for its next turn.
        const full = getSession(s.id);
        const msgs = reads && full && wakes(full) ? takePending(s.id) : null;
        if (msgs) {
          if (s.agent_state !== "working") setState(s, "working");
          return context(event, msgs);
        }
        // The agent asked to be compacted (the compact tool): let the turn end, compact, then hand it its next step.
        // Before the shift's keep-going, which would never let the turn end.
        if (reads && startCompaction(s.id)) return;
        // On shift: Claude gets its next prompt and continues in the same turn.
        const keepGoing = reads ? claudeStop(getSession(s.id)!) : null;
        if (keepGoing) {
          if (s.agent_state !== "working") setState(s, "working");
          return keepGoing;
        }
        if (!reads && shiftView(s.id)?.active) {
          // An older hooks file can't keep it going in the same turn: it stops, and the next prompt is typed in.
          setState(s, "waiting");
          return;
        }
        turnEnded(s, s.agent_state);
        return;
      }
      case "StopFailure":
        turnFailed(s, payload);
        return;
    }
    return;
  }

  if (tool === "codex" && event === "turn" && payload?.type === "agent-turn-complete") {
    const last = clip(payload["last-assistant-message"]);
    setState(s, "waiting", last || null);
    // On shift the next prompt gets typed in shortly (shifts.nudgeIdle), so the task stays in Doing and no push goes out.
    if (codexTurnEnded(getSession(s.id)!)) return;
    if (!isTaskReviewer(s.id)) moveTask(s.task_id, "doing", "review");
    push(s, "done", last || "Finished — your turn.");
  }
}

/** Codex has no approval hook: the reconciler reports what its screen shows. */
export function codexScreen(id: string, prompt: string | null) {
  const s = db.query("SELECT id, title, tool, task_id, agent_state, status FROM sessions WHERE id = ?").get(id) as Row | null;
  if (!s || s.status !== "running") return;
  if (prompt && s.agent_state !== "needs-input") {
    setState(s, "needs-input", prompt);
    push(s, "input", prompt, APPROVAL_ACTIONS);
  } else if (!prompt && s.agent_state === "needs-input") {
    setState(s, "working");
  }
}

/** A startup dialog appeared (message) or went away (null) on a Claude screen. */
export function startupScreen(id: string, message: string | null, was?: string) {
  const s = db.query("SELECT id, title, tool, task_id, agent_state, status FROM sessions WHERE id = ?").get(id) as Row | null;
  if (!s || s.status !== "running") return;
  if (message) {
    setState(s, "needs-input", message);
    // The dialog's own answer (e.g. Trust folder = Down + Enter): plain Enter would pick "No, exit".
    const p = getSession(id) ? sessionView(getSession(id)!).startup : null;
    push(s, "input", message, p?.accept ? [{ id: "accept", title: p.accept, keys: p.acceptKeys }] : []);
  } else if (s.agent_state === "needs-input" && was) {
    // Hooks take over from here (SessionStart sets "waiting"). Only undo our own "Needs you":
    // if the message is no longer the dialog's, it's a real approval and must stay.
    const r = db.query("UPDATE sessions SET agent_state = NULL, agent_message = NULL WHERE id = ? AND agent_state = 'needs-input' AND agent_message = ?").run(id, was);
    if (r.changes) emit("sessions");
  }
}

/** Why a run failed, or null when it ended normally (closed by you, or a clean exit). */
function exitFailure(code: number | null, how: ExitHow): string | null {
  if (how === "closed") return null;
  if (how === "vanished") return "its terminal disappeared (killed, or the laptop restarted)";
  return code ? `the agent exited with code ${code}` : null;
}

/**
 * An autopilot run that died mid-task (still in Doing: it hadn't finished, and it wasn't
 * waiting on a question) goes back in the queue, up to AUTO_RETRIES times. The next run's
 * prompt carries this note and the branch's commits as a handoff. Returns true if re-queued.
 */
function retryAutopilotRun(s: Row, code: number | null, how: ExitHow): boolean {
  const failure = exitFailure(code, how);
  if (!s.auto || !failure || !s.task_id) return false;
  const t = db.query("SELECT status, attempts FROM tasks WHERE id = ?").get(s.task_id) as { status: string; attempts: number } | null;
  if (!t || t.status !== "doing" || t.attempts >= AUTO_RETRIES) return false;
  if (db.query("SELECT 1 FROM sessions WHERE task_id = ? AND id != ? AND status = 'running'").get(s.task_id, s.id)) return false;
  const n = t.attempts + 1;
  db.query(
    `UPDATE tasks SET status = 'todo', queued = 1, attempts = ?, last_failure = ?, summary = ?, done_at = NULL, updated_at = ? WHERE id = ?`,
  ).run(n, failure, `The previous run stopped before finishing: ${failure}. Retry ${n} of ${AUTO_RETRIES}.`, now(), s.task_id);
  db.query("UPDATE schedule_occurrences SET status='queued', outcome=? WHERE task_id=?").run(failure, s.task_id);
  emit("tasks");
  return true;
}

/** Called by the reconciler when an agent process exits. */
/**
 * How a session ended: "closed" = you closed it (never retried), "vanished" = its tmux
 * session disappeared (killed, laptop restarted), "exited" = the agent process ended
 * with `code` (0 is a normal exit, e.g. /exit).
 */
export type ExitHow = "closed" | "vanished" | "exited";

export function onExited(id: string, code: number | null, how: ExitHow = "exited") {
  const s = db.query("SELECT id, title, tool, task_id, agent_state, status, auto FROM sessions WHERE id = ?").get(id) as Row | null;
  if (!s) return;
  dropClaims(id);
  dropCompaction(id);

  // If the process disappeared before finish_task (or a turn-complete hook),
  // release the task from Doing so it cannot look active forever or block the
  // project's next queued task. Keep it for the user to review and rerun.
  // Leave it alone while another session (a rerun) is still working the task.
  const reviewer = isTaskReviewer(s.id);
  if (s.task_id && !reviewer && retryAutopilotRun(s, code, how)) {
    // re-queued; autopilot starts it again with a handoff
  } else if (s.task_id && !reviewer) {
    const reason = code === null
      ? "The agent session ended before the task was marked complete. Check the session, then rerun or update the task."
      : `The agent session exited with code ${code} before the task was marked complete. Check the session, then rerun or update the task.`;
    const failure = exitFailure(code, how);
    const recovered = db.query(
      `UPDATE tasks SET status = 'review', summary = COALESCE(summary, ?), last_failure = COALESCE(?, last_failure), updated_at = ? WHERE id = ? AND status = 'doing'
         AND NOT EXISTS (SELECT 1 FROM sessions WHERE task_id = ? AND id != ? AND status = 'running')`,
    ).run(reason, failure, now(), s.task_id, s.task_id, s.id);
    if (recovered.changes) {
      db.query("UPDATE schedule_occurrences SET status='needs_attention', outcome=? WHERE task_id=?").run(reason, s.task_id);
      emit("tasks");
    }
  }

  if (isWatched(id) || !code) return; // clean exits are expected
  notify("exited", { title: `Exited · ${s.title}`, body: `The agent stopped with code ${code}.`, url: `/s/${id}`, tag: `s-${id}` }).catch(() => {});
}
