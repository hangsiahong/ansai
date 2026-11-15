import { db, now } from "./db";
import { badRequest, conflict, notFound } from "./errors";
import { emit } from "./events";
import { getProject } from "./projects";
import { getSession, sendText, sessionView, type SessionRow } from "./sessions";
import { touchedFiles } from "./transcripts";
import { TOOLS } from "./tools";

/**
 * Agents talk to each other (and to you) through ansai.
 *
 * The same idea as an "agent mail" server for coding agents, built into the
 * MCP server every agent already gets: list_agents shows who else is working
 * (and which files they are editing), send_message writes to one agent or to
 * everyone in the project, and messages are delivered by ansai, not polled:
 *
 * - Claude, mid-turn: the PostToolUse hook returns them as additionalContext.
 * - Claude, finishing a turn: the Stop hook returns them, so it keeps going.
 * - Claude, typing: the UserPromptSubmit hook attaches them.
 * - An idle agent (Claude or Codex at its prompt) gets direct messages typed in,
 *   which wakes it. Broadcasts from agents wait for its next turn instead, so
 *   one chatty agent can't wake (and spend tokens on) everyone.
 */

export type Message = {
  id: number;
  project_id: string | null;
  from_session: string | null;
  from_label: string;
  to_session: string | null;
  to_label: string | null;
  body: string;
  created_at: number;
  delivered_at: number | null;
};

const TEAM_TOOLS = new Set(["claude", "codex"]);
const BODY_MAX = 8000;
// An agent may send this many messages per window; stops two agents thanking each other forever.
const RATE = { max: 12, windowMs: 10 * 60_000 };

const SHORT: Record<string, string> = { claude: "Claude", codex: "Codex", agy: "agy", shell: "Shell" };
export const agentLabel = (s: Pick<SessionRow, "tool" | "title">) => `${SHORT[s.tool] ?? s.tool} “${s.title.slice(0, 60)}”`;

const ago = (ts: number) => {
  const s = Math.max(0, Math.round((now() - ts) / 1000));
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
};

// ------------------------------------------------------------------ reading

export function listMessages(o: { projectId?: string | null; sessionId?: string; limit?: number } = {}): Message[] {
  const limit = Math.max(1, Math.min(500, o.limit ?? 150));
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (o.projectId) {
    where.push("project_id = ?");
    args.push(o.projectId);
  }
  if (o.sessionId) {
    where.push("(from_session = ? OR to_session = ? OR (to_session IS NULL AND project_id = (SELECT project_id FROM sessions WHERE id = ?)))");
    args.push(o.sessionId, o.sessionId, o.sessionId);
  }
  const rows = db
    .query(`SELECT * FROM messages ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit) as Message[];
  return rows.reverse();
}

/** Messages this session hasn't been given yet: direct ones, and its project's channel (not its own). */
function pendingFor(s: SessionRow): Message[] {
  return db
    .query(
      `SELECT * FROM messages WHERE id > ? AND COALESCE(from_session, '') != ?
         AND (to_session = ? OR (to_session IS NULL AND project_id IS NOT NULL AND project_id = ?))
       ORDER BY id LIMIT 30`,
    )
    .all(s.msg_cursor ?? 0, s.id, s.id, s.project_id ?? "") as Message[];
}

function format(msgs: Message[], s: SessionRow): string {
  const lines = [
    msgs.length === 1 ? "ansai: a message from your team." : `ansai: ${msgs.length} messages from your team.`,
  ];
  for (const m of msgs) {
    const from = m.from_session ? `${m.from_label} (agent id ${m.from_session})` : "the user (via ansai)";
    const to = m.to_session === s.id ? "to you" : "to everyone in this project";
    lines.push("", `From ${from}, ${to}, ${ago(m.created_at)}:`, m.body);
  }
  const agents = msgs.filter((m) => m.from_session);
  lines.push(
    "",
    agents.length
      ? `Act on this if it affects your work. Reply with the ansai send_message tool (to: "${agents[agents.length - 1]!.from_session}") only when a reply is useful — no acknowledgements. Then carry on with your task.`
      : "This is from the user. Act on it, then carry on.",
  );
  return lines.join("\n");
}

/** Hand over everything pending (marks it delivered). Null when there is nothing. */
export function takePending(sessionId: string): string | null {
  const s = getSession(sessionId);
  if (!s || s.status !== "running") return null;
  const msgs = pendingFor(s);
  if (!msgs.length) return null;
  const last = msgs[msgs.length - 1]!.id;
  db.query("UPDATE sessions SET msg_cursor = ? WHERE id = ? AND msg_cursor < ?").run(last, s.id, last);
  db.query("UPDATE messages SET delivered_at = ? WHERE to_session = ? AND id <= ? AND delivered_at IS NULL").run(now(), s.id, last);
  emit("messages");
  return format(msgs, s);
}

// ------------------------------------------------------------------ sending

function resolveTarget(to: string, from: SessionRow | null): SessionRow {
  const id = to.trim();
  let s = getSession(id);
  if (!s && id.length >= 4) {
    // Accept a unique suffix of the id ("…k2471"), as shown in list_agents.
    const rows = db.query("SELECT id FROM sessions WHERE status = 'running' AND id LIKE ?").all(`%${id}`) as { id: string }[];
    if (rows.length === 1) s = getSession(rows[0]!.id);
  }
  if (!s) throw notFound(`no agent with id ${id}; call list_agents for the ids`);
  if (s.status !== "running") throw conflict(`${agentLabel(s)} isn't running any more`);
  if (!TEAM_TOOLS.has(s.tool)) throw conflict(`${TOOLS[s.tool].label} sessions can't receive messages`);
  if (from && s.id === from.id) throw badRequest("that's you");
  return s;
}

export function postMessage(o: { from: SessionRow | null; to?: string | null; projectId?: string | null; body: string }): Message {
  const body = o.body.trim();
  if (!body) throw badRequest("a message needs some text");
  if (body.length > BODY_MAX) throw badRequest(`keep messages under ${BODY_MAX} characters; share long content as a file path`);
  const target = o.to && o.to !== "all" && o.to !== "everyone" ? resolveTarget(o.to, o.from) : null;
  const projectId = target ? (o.from?.project_id ?? target.project_id) : (o.from?.project_id ?? o.projectId ?? null);
  if (!target && !projectId) throw badRequest("pick a project (or an agent) to send to");
  if (projectId && !getProject(projectId)) throw badRequest("no such project");
  if (o.from) {
    const recent = db.query("SELECT COUNT(*) AS n FROM messages WHERE from_session = ? AND created_at > ?").get(o.from.id, now() - RATE.windowMs) as { n: number };
    if (recent.n >= RATE.max) throw conflict(`message limit reached (${RATE.max} per 10 minutes). Keep working; send one summary later.`);
  }
  const r = db
    .query(
      `INSERT INTO messages (project_id, from_session, from_label, to_session, to_label, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(projectId, o.from?.id ?? null, o.from ? agentLabel(o.from) : "You", target?.id ?? null, target ? agentLabel(target) : null, body, now()) as Message;
  emit("messages");
  queueMicrotask(() => void deliverIdle().catch((e) => console.error("[ansai] team delivery:", e)));
  return r;
}

// ----------------------------------------------------------------- delivery

const delivering = new Set<string>();

/** Should a pending message wake this agent? Direct messages and your own broadcasts do; agents' broadcasts wait. */
export function wakes(s: SessionRow): boolean {
  return !!db
    .query(
      `SELECT 1 FROM messages WHERE id > ? AND COALESCE(from_session, '') != ?
         AND (to_session = ? OR (to_session IS NULL AND from_session IS NULL AND project_id = ?)) LIMIT 1`,
    )
    .get(s.msg_cursor ?? 0, s.id, s.id, s.project_id ?? "");
}

/**
 * Agents sitting at their prompt don't run hooks, so type direct messages in.
 * Only when the agent is truly idle: its turn ended (not at a permission prompt
 * or a startup dialog) and its screen has been still for a few seconds.
 */
export async function deliverIdle() {
  const rows = db
    .query(`SELECT * FROM sessions WHERE status = 'running' AND tool IN ('claude', 'codex') AND agent_state = 'waiting'`)
    .all() as SessionRow[];
  for (const s of rows) {
    if (delivering.has(s.id)) continue;
    const quietFor = Date.now() - (sessionView(s).activity_at ?? 0);
    if (quietFor < 3000 || !wakes(s)) continue;
    delivering.add(s.id);
    try {
      const text = takePending(s.id);
      if (text) await sendText(s.id, text, true);
    } finally {
      delivering.delete(s.id);
    }
  }
}

// ------------------------------------------------------------------- agents

function stateLabel(s: SessionRow): string {
  if (s.agent_state === "needs-input") return "waiting for the user's approval";
  if (s.agent_state === "working") return "working";
  if (s.agent_state === "waiting") return "idle (turn finished)";
  return "starting";
}

/** What list_agents tells an agent about its teammates. */
export function describeAgents(me: SessionRow): string {
  const rows = db
    .query(
      `SELECT s.*, t.title AS task_title, t.worktree_branch AS branch, p.name AS project_name
         FROM sessions s LEFT JOIN tasks t ON t.id = s.task_id LEFT JOIN projects p ON p.id = s.project_id
        WHERE s.status = 'running' AND s.tool IN ('claude', 'codex') AND s.id != ?
        ORDER BY (s.project_id IS ?) DESC, s.created_at DESC LIMIT 30`,
    )
    .all(me.id, me.project_id) as (SessionRow & { task_title: string | null; branch: string | null; project_name: string | null })[];
  if (!rows.length) return "No other agents are running right now.";
  const mine = new Set(touchedFiles(me, 200));
  const out: string[] = [];
  for (const r of rows) {
    const files = touchedFiles(r, 12);
    const overlap = files.filter((f) => mine.has(f));
    out.push(
      [
        `- id ${r.id} · ${agentLabel(r)} · ${stateLabel(r)}`,
        `  project: ${r.project_name ?? "none"}${r.project_id === me.project_id && me.project_id ? " (same as yours)" : ""}${r.branch ? ` · branch ${r.branch}` : ""}`,
        r.task_title && r.task_title !== r.title ? `  task: ${r.task_title}` : "",
        files.length ? `  edited: ${files.join(", ")}` : "",
        overlap.length ? `  ⚠ you both edited: ${overlap.join(", ")} — coordinate before changing these further` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return out.join("\n");
}

/** Recent channel history for read_messages (what was said, including already delivered messages). */
export function describeHistory(me: SessionRow, limit = 20): string {
  const msgs = listMessages({ sessionId: me.id, limit });
  if (!msgs.length) return "No messages yet.";
  return msgs
    .map((m) => {
      const from = m.from_session === me.id ? "you" : m.from_session ? `${m.from_label} [${m.from_session}]` : "the user";
      const to = m.to_session ? (m.to_session === me.id ? "you" : `${m.to_label} [${m.to_session}]`) : "everyone";
      return `[${ago(m.created_at)}] ${from} → ${to}: ${m.body}`;
    })
    .join("\n\n");
}
