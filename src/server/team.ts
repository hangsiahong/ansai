import { isAbsolute, normalize, relative } from "node:path";
import { db, getSetting, now, setSetting } from "./db";
import { badRequest, conflict, notFound } from "./errors";
import { emit } from "./events";
import { getProject } from "./projects";
import { getSession, readyToType, sendText, sessionView, type SessionRow } from "./sessions";
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
  return takeForTyping(sessionId)?.text ?? null;
}

/**
 * takePending for text that is about to be typed into the agent's terminal, which can
 * fail (the pane just died). `giveBack` then puts the messages back as undelivered, so
 * they aren't shown as Delivered and lost; they go out with the next delivery instead.
 */
export function takeForTyping(sessionId: string): { text: string; giveBack: () => void } | null {
  const s = getSession(sessionId);
  if (!s || s.status !== "running") return null;
  const msgs = pendingFor(s);
  if (!msgs.length) return null;
  const before = s.msg_cursor ?? 0;
  const last = msgs[msgs.length - 1]!.id;
  const at = now();
  db.query("UPDATE sessions SET msg_cursor = ? WHERE id = ? AND msg_cursor < ?").run(last, s.id, last);
  db.query("UPDATE messages SET delivered_at = ? WHERE to_session = ? AND id <= ? AND delivered_at IS NULL").run(at, s.id, last);
  emit("messages");
  return {
    text: format(msgs, s),
    giveBack: () => {
      const r = db.query("UPDATE sessions SET msg_cursor = ? WHERE id = ? AND msg_cursor = ?").run(before, s.id, last);
      if (!r.changes) return; // something newer was delivered since: leave it
      db.query("UPDATE messages SET delivered_at = NULL WHERE to_session = ? AND id > ? AND id <= ? AND delivered_at = ?").run(s.id, before, last, at);
      emit("messages");
    },
  };
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

/** What happens to a direct message right now: delivered mid-turn, typed in, or held (and why). */
export function deliveryNote(target: SessionRow): string {
  if (target.agent_state === "working") return target.tool === "codex" ? "It's working; ansai types this in when its turn ends." : "It's working, so it reads this between steps.";
  if (target.agent_state === "needs-input") return "It's waiting for the user's approval; it reads this once it continues.";
  const at = sessionView(target).activity_at;
  const why = holdReason(target, at ? Date.now() - at : null);
  if (why) return `It won't be woken for this (${why}); it reads it on its next turn.`;
  return "It's idle, so ansai types it in now.";
}

/** `label`: who a message with no sending agent is from (default "You"; ansai's own say so). */
export function postMessage(o: { from: SessionRow | null; to?: string | null; projectId?: string | null; body: string; label?: string }): Message {
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
    .get(projectId, o.from?.id ?? null, o.from ? agentLabel(o.from) : (o.label ?? "You"), target?.id ?? null, target ? agentLabel(target) : null, body, now()) as Message;
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
/**
 * Is this agent sitting at its prompt, so typing a message in is safe? Its turn
 * ended and the screen has been still. Codex reports only when a turn ends, so
 * one that hasn't finished a turn yet (no state) counts once its screen has been
 * still for 10 s — a working Codex keeps redrawing its spinner and timer.
 */
export function isIdle(s: Pick<SessionRow, "tool" | "agent_state">, quietMs: number | null): boolean {
  if (quietMs === null) return false; // ansai hasn't seen the screen yet
  if (s.agent_state === "waiting") return quietMs >= 3000;
  if (s.tool === "codex" && s.agent_state === null) return quietMs >= 10_000;
  return false;
}

// Past this, the agent's prompt cache has gone cold: waking it re-reads its whole context at full price.
const COLD_MS = 55 * 60_000;

/**
 * Why a direct message shouldn't wake this idle agent (null = fine to wake).
 * It still gets the message, on its next turn.
 */
export function holdReason(s: Pick<SessionRow, "task_id">, idleMs: number | null): string | null {
  if (s.task_id) {
    const t = db.query("SELECT status, summary FROM tasks WHERE id = ?").get(s.task_id) as { status: string; summary: string | null } | null;
    if (t && (t.status === "done" || (t.status === "review" && t.summary))) return "its task is finished";
  }
  if (idleMs !== null && idleMs > COLD_MS) return "it has been idle for over 55 minutes";
  return null;
}

/**
 * Type pending messages into this agent now? Only at its prompt, only for messages
 * that wake (direct ones, or your broadcasts), and not into a finished or cold agent,
 * unless you messaged it yourself (a review, a follow-up): that always wakes it.
 */
export function shouldType(s: SessionRow, quietMs: number | null): boolean {
  if (!isIdle(s, quietMs) || !wakes(s)) return false;
  const fromYou = db.query("SELECT 1 FROM messages WHERE id > ? AND from_session IS NULL AND to_session = ? LIMIT 1").get(s.msg_cursor ?? 0, s.id);
  return !!fromYou || !holdReason(s, quietMs);
}

export async function deliverIdle() {
  const rows = db
    .query(
      `SELECT * FROM sessions WHERE status = 'running' AND tool IN ('claude', 'codex')
         AND (agent_state = 'waiting' OR (tool = 'codex' AND agent_state IS NULL))`,
    )
    .all() as SessionRow[];
  for (const s of rows) {
    if (delivering.has(s.id)) continue;
    const at = sessionView(s).activity_at;
    if (!shouldType(s, at ? Date.now() - at : null)) continue;
    delivering.add(s.id);
    let taken: ReturnType<typeof takeForTyping> = null;
    try {
      // A menu or a question on its screen instead of its input box: the message waits (still undelivered).
      if (!(await readyToType(s))) continue;
      taken = takeForTyping(s.id);
      if (taken) await sendText(s.id, taken.text, true);
    } catch (e) {
      taken?.giveBack(); // not typed: don't leave it marked Delivered
      console.error(`[ansai] couldn't type a team message into ${s.id}:`, e instanceof Error ? e.message : e);
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
        claimsOf(r).length ? `  claimed: ${claimsOf(r).join(", ")}` : "",
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

// -------------------------------------------------------------------- claims

/**
 * Advisory file claims: "I'm changing these, please don't." Agents still see
 * every file; claims show up in list_agents, and an agent that edits a file
 * someone else claimed (or recently edited) is told right after the edit.
 * They belong to running sessions and lapse when those end. Also written to the
 * database: ansai restarts while agents work, and a claim that vanished with it let
 * a second agent claim and change the same files with no warning to either.
 */
type Claim = { reason: string; at: number };
const claims = new Map<string, Map<string, Claim>>(); // session id → path (relative to its cwd) → claim
const MAX_CLAIMS = 50;
const CLAIMS_KEY = "claims:";

function saveClaims(sessionId: string) {
  const mine = claims.get(sessionId);
  if (mine?.size) setSetting(CLAIMS_KEY + sessionId, Object.fromEntries(mine));
  else {
    claims.delete(sessionId);
    db.query("DELETE FROM settings WHERE key = ?").run(CLAIMS_KEY + sessionId);
  }
}

/** ansai just started: the claims of agents that are still running are still theirs. */
export function resumeClaims() {
  claims.clear();
  const rows = db.query("SELECT key, value FROM settings WHERE key LIKE ?").all(`${CLAIMS_KEY}%`) as { key: string; value: string }[];
  for (const r of rows) {
    const id = r.key.slice(CLAIMS_KEY.length);
    const mine = new Map<string, Claim>();
    try {
      for (const [path, c] of Object.entries(JSON.parse(r.value) as Record<string, Partial<Claim>>)) mine.set(path, { reason: String(c?.reason ?? ""), at: Number(c?.at) || now() });
    } catch {}
    if (mine.size && db.query("SELECT 1 FROM sessions WHERE id = ? AND status = 'running'").get(id)) claims.set(id, mine);
    else db.query("DELETE FROM settings WHERE key = ?").run(r.key);
  }
}

/** A path as the agent's project sees it: relative to its working folder when inside it. */
export function relPath(s: Pick<SessionRow, "cwd">, p: string): string {
  const abs = isAbsolute(p) ? normalize(p) : normalize(`${s.cwd}/${p}`);
  const rel = relative(s.cwd, abs);
  return rel.startsWith("..") ? abs : rel;
}

/** Other running agents that share this agent's project (or repo checkout). */
function teammates(me: SessionRow): SessionRow[] {
  return db
    .query(`SELECT * FROM sessions WHERE status = 'running' AND tool IN ('claude', 'codex') AND id != ? AND (project_id = ? OR cwd = ?)`)
    .all(me.id, me.project_id ?? "", me.cwd) as SessionRow[];
}

function liveClaims(s: SessionRow): Map<string, Claim> {
  return claims.get(s.id) ?? new Map();
}

export function claimFiles(me: SessionRow, paths: string[], reason: string): string {
  const mine = claims.get(me.id) ?? new Map<string, Claim>();
  const taken: string[] = [];
  const got: string[] = [];
  const others = teammates(me);
  for (const raw of paths.slice(0, MAX_CLAIMS)) {
    const p = relPath(me, String(raw).trim());
    if (!p) continue;
    const holder = others.find((o) => liveClaims(o).has(p));
    if (holder) {
      taken.push(`${p} (claimed by ${agentLabel(holder)}, id ${holder.id}: ${liveClaims(holder).get(p)!.reason || "no reason given"})`);
      continue;
    }
    mine.set(p, { reason: reason.slice(0, 200), at: now() });
    got.push(p);
  }
  while (mine.size > MAX_CLAIMS) mine.delete(mine.keys().next().value!);
  claims.set(me.id, mine);
  saveClaims(me.id);
  const out = [];
  if (got.length) out.push(`Claimed: ${got.join(", ")}. Other agents see this in list_agents; release_files when you're done.`);
  if (taken.length) out.push(`Already claimed, so not yours: ${taken.join("; ")}. Ask that agent with send_message before changing these.`);
  return out.join("\n") || "Nothing to claim.";
}

export function releaseFiles(me: SessionRow, paths?: string[]): string {
  const mine = claims.get(me.id);
  if (!mine?.size) return "You have no claims.";
  if (!paths?.length) mine.clear();
  else for (const p of paths) mine.delete(relPath(me, p));
  saveClaims(me.id);
  return mine.size ? `Still claimed: ${[...mine.keys()].join(", ")}.` : "Released all your claims.";
}

export function claimsOf(s: SessionRow): string[] {
  return [...liveClaims(s).entries()].map(([p, c]) => (c.reason ? `${p} (${c.reason})` : p));
}

const warned = new Set<string>(); // "me|other|path": say it once per pair and file

/**
 * Called after an agent edits a file: if another running agent claimed it, or
 * edited it too, say so (once), so the two can sort it out before it turns into
 * a merge conflict or a silent overwrite.
 */
export function editWarning(me: SessionRow, file: string): string | null {
  const p = relPath(me, file);
  const hits: string[] = [];
  for (const o of teammates(me)) {
    const key = `${me.id}|${o.id}|${p}`;
    if (warned.has(key)) continue;
    const claim = liveClaims(o).get(p);
    const touched = !claim && touchedFiles(o, 200).includes(p);
    if (!claim && !touched) continue;
    warned.add(key);
    hits.push(
      claim
        ? `${p} is claimed by ${agentLabel(o)} (agent id ${o.id})${claim.reason ? `: ${claim.reason}` : ""}.`
        : `${agentLabel(o)} (agent id ${o.id}) has also edited ${p}${o.cwd === me.cwd ? " in this same folder" : ""}.`,
    );
  }
  if (!hits.length) return null;
  return [
    "ansai: heads-up about the file you just changed.",
    ...hits,
    "Check with them using send_message before changing it further, so you don't overwrite each other or end up with a merge conflict.",
  ].join("\n");
}

/** Forget a finished session's claims (called when it exits or closes). */
export function dropClaims(sessionId: string) {
  claims.delete(sessionId);
  saveClaims(sessionId);
}

// --------------------------------------------------------------------- board

export type BoardAgent = {
  id: string;
  tool: string;
  title: string;
  state: string | null;
  task: string | null;
  branch: string | null;
  files: string[];
  claims: string[];
};
export type Board = { agents: BoardAgent[]; overlaps: { path: string; agents: string[] }[] };

/** Who's on what in a project: each running agent's files and claims, and files two of them touch. */
export function teamBoard(projectId: string): Board {
  const rows = db
    .query(
      `SELECT s.*, t.title AS task_title, t.worktree_branch AS branch FROM sessions s LEFT JOIN tasks t ON t.id = s.task_id
        WHERE s.status = 'running' AND s.tool IN ('claude', 'codex') AND s.project_id = ? ORDER BY s.created_at`,
    )
    .all(projectId) as (SessionRow & { task_title: string | null; branch: string | null })[];
  const agents = rows.map((r) => ({
    id: r.id,
    tool: r.tool,
    title: r.title,
    state: r.agent_state,
    task: r.task_title && r.task_title !== r.title ? r.task_title : null,
    branch: r.branch,
    files: touchedFiles(r, 30),
    claims: [...liveClaims(r).keys()],
  }));
  const by = new Map<string, Set<string>>();
  for (const a of agents) for (const f of new Set([...a.files, ...a.claims])) by.set(f, (by.get(f) ?? new Set()).add(a.id));
  const overlaps = [...by.entries()].filter(([, ids]) => ids.size > 1).map(([path, ids]) => ({ path, agents: [...ids] }));
  return { agents, overlaps };
}

// ------------------------------------------------------------------ playbooks

/**
 * A project's playbook: your standing instructions for every agent working in it
 * ("run bun test before finishing", "never touch the migrations"). Editable from
 * the project page; agents get it with ansai's MCP instructions when they start.
 */
const PLAYBOOK_MAX = 8000;
export const getPlaybook = (projectId: string) => getSetting<string>(`playbook:${projectId}`, "");
export function setPlaybook(projectId: string, text: string) {
  const t = text.trim();
  if (t.length > PLAYBOOK_MAX) throw badRequest(`keep the playbook under ${PLAYBOOK_MAX} characters`);
  setSetting(`playbook:${projectId}`, t);
  return t;
}
