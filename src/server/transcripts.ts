import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ServerWebSocket } from "bun";
import { config } from "./config";
import { db } from "./db";
import { emit } from "./events";
import { getAccount } from "./accounts";
import { getSession, type SessionRow } from "./sessions";
import { createTask, setPlan } from "./tasks";
import { getSettings } from "./autopilot";

/**
 * Chat view = the agent's own conversation log, rendered natively.
 * Claude Code and Codex append every message and tool call to a JSONL file
 * while they run in tmux; we tail that file (new bytes only) and turn lines
 * into chat items. Input still goes to the same live session, so Chat and
 * Terminal are two views of one agent.
 */

export type ChatItem =
  | { id: string; k: "user"; text: string; ts: number }
  | { id: string; k: "assistant"; text: string; ts: number }
  | { id: string; k: "thinking"; text: string; ts: number }
  | { id: string; k: "note"; text: string; ts: number }
  | { id: string; k: "tool"; ts: number; name: string; title: string; input?: Record<string, unknown>; result?: string; error?: boolean; done: boolean };

type ToolItem = Extract<ChatItem, { k: "tool" }>;

const MAX_ITEMS = 1500;
const FIRST_SEND = 400;
const MAX_FIRST_READ = 12 * 1024 * 1024; // very long logs: start near the end

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… ${s.length - n} more characters` : s);
const one = (s: string, n = 120) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

// ----------------------------------------------------------------- discovery

function claudeDir(s: SessionRow) {
  const a = s.account_id ? getAccount(s.account_id) : null;
  return a?.dir ?? join(config.home, ".claude");
}
function codexHome(s: SessionRow) {
  const a = s.account_id ? getAccount(s.account_id) : null;
  return a?.dir ?? join(config.home, ".codex");
}
const claimed = (path: string, id: string) => !!db.query("SELECT 1 FROM sessions WHERE transcript = ? AND id != ?").get(path, id);

async function firstLine(path: string): Promise<string> {
  const text = await Bun.file(path).slice(0, 512 * 1024).text();
  const nl = text.indexOf("\n");
  return nl >= 0 ? text.slice(0, nl) : text;
}

/** Find (and remember) which log file belongs to a session. */
export async function resolveTranscript(s: SessionRow): Promise<string | null> {
  if (s.transcript && existsSync(s.transcript)) return s.transcript;
  // Claude's hook already named the log; it just isn't written until the first message. Wait for it
  // rather than guessing — a guess can pick another Claude conversation in the same folder.
  if (s.tool === "claude" && s.transcript) return null;
  let found: string | null = null;

  if (s.tool === "claude") {
    // No hook data (older sessions): a log *created* after this session started, in this folder.
    const dir = join(claudeDir(s), "projects", s.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    if (existsSync(dir)) {
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => {
          const st = statSync(join(dir, f));
          return { path: join(dir, f), born: st.birthtimeMs || st.ctimeMs };
        })
        .filter((f) => f.born >= s.created_at - 2000 && !claimed(f.path, s.id))
        .sort((a, b) => a.born - b.born);
      found = files[0]?.path ?? null;
    }
  } else if (s.tool === "codex") {
    // Rollout files start with a session_meta line carrying cwd + start time.
    const best: { path: string; t: number }[] = [];
    for (const dayOffset of [0, 1]) {
      const d = new Date(s.created_at + dayOffset * 86400_000);
      const dir = join(codexHome(s), "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const path = join(dir, f);
        if (statSync(path).mtimeMs < s.created_at - 5000 || claimed(path, s.id)) continue;
        try {
          const meta = JSON.parse(await firstLine(path));
          const t = Date.parse(meta?.payload?.timestamp ?? meta?.timestamp);
          if (meta?.payload?.cwd === s.cwd && t >= s.created_at - 10_000) best.push({ path, t });
        } catch {}
      }
    }
    found = best.sort((a, b) => a.t - b.t)[0]?.path ?? null;
  }

  if (found) db.query("UPDATE sessions SET transcript = ? WHERE id = ?").run(found, s.id);
  return found;
}

// ------------------------------------------------------------------- parsing

/** Team messages ansai typed into an idle agent; the chat shows them from the team channel instead. */
const isTeamDelivery = (t: string) => /^ansai: (a message|\d+ messages) from your team\./.test(t);

type ParseState = {
  tools: Map<string, ToolItem>;
  title: string | null;
  firstUser: string | null;
  /** Latest model + reasoning effort the log reports (they change with /model, /effort). */
  model: string | null;
  effort: string | null;
  /** Files this agent has written or edited (absolute or cwd-relative path → last time), for teammates. */
  touched: Map<string, number>;
  /** Tokens the model read on its last call (the conversation's current size). */
  context: number | null;
};
const freshState = (): ParseState => ({ tools: new Map(), title: null, firstUser: null, model: null, effort: null, touched: new Map(), context: null });

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
function noteTouched(st: ParseState, path: unknown, ts: number) {
  if (typeof path !== "string" || !path) return;
  st.touched.delete(path); // keep insertion order = recency
  st.touched.set(path, ts);
  if (st.touched.size > 200) st.touched.delete(st.touched.keys().next().value!);
}

function toolTitle(name: string, input: any): { title: string; keep?: Record<string, unknown> } {
  const file = (p: unknown) => (typeof p === "string" ? p.replace(config.home, "~") : "");
  switch (name) {
    case "Bash":
      return { title: input?.description ? String(input.description) : one(String(input?.command ?? ""), 90), keep: { command: clip(String(input?.command ?? ""), 4000) } };
    case "Read":
      return { title: `Read ${basename(String(input?.file_path ?? ""))}`, keep: { file_path: file(input?.file_path) } };
    case "Write":
      return { title: `Write ${basename(String(input?.file_path ?? ""))}`, keep: { file_path: file(input?.file_path), content: clip(String(input?.content ?? ""), 6000) } };
    case "Edit":
      return {
        title: `Edit ${basename(String(input?.file_path ?? ""))}`,
        keep: { file_path: file(input?.file_path), old_string: clip(String(input?.old_string ?? ""), 6000), new_string: clip(String(input?.new_string ?? ""), 6000) },
      };
    case "MultiEdit":
      return {
        title: `Edit ${basename(String(input?.file_path ?? ""))} (${input?.edits?.length ?? 0} changes)`,
        keep: {
          file_path: file(input?.file_path),
          edits: (input?.edits ?? []).slice(0, 20).map((e: any) => ({ old_string: clip(String(e.old_string ?? ""), 3000), new_string: clip(String(e.new_string ?? ""), 3000) })),
        },
      };
    case "Grep":
      return { title: `Search “${one(String(input?.pattern ?? ""), 50)}”` };
    case "Glob":
      return { title: `Find ${one(String(input?.pattern ?? ""), 60)}` };
    case "WebFetch":
      return { title: `Fetch ${one(String(input?.url ?? ""), 70)}` };
    case "WebSearch":
      return { title: `Search the web: ${one(String(input?.query ?? ""), 60)}` };
    case "Task":
    case "Agent":
      return { title: `Agent: ${one(String(input?.description ?? input?.prompt ?? ""), 70)}` };
    case "TodoWrite":
      return { title: "Plan", keep: { todos: (input?.todos ?? []).slice(0, 40).map((t: any) => ({ content: one(String(t.content ?? ""), 160), status: t.status })) } };
    case "AskUserQuestion": {
      const qs = (input?.questions ?? []).slice(0, 4).map((q: any) => ({
        question: String(q.question ?? ""),
        options: (q.options ?? []).slice(0, 6).map((o: any) => ({ label: String(o.label ?? o), description: o.description ? String(o.description) : "" })),
      }));
      return { title: qs[0]?.question ? one(qs[0].question, 90) : "Question", keep: { questions: qs } };
    }
    default: {
      const json = JSON.stringify(input ?? {});
      let title = name;
      if (name.startsWith("mcp__")) {
        const [server = "", tool = ""] = name.slice(5).replace(/^claude_ai_/, "").split("__");
        title = `${server.replace(/_/g, " ")} · ${tool.replace(/_/g, " ")}`;
      }
      return { title, keep: json.length > 2 ? { json: clip(json, 2000) } : undefined };
    }
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return clip(content, 8000);
  if (Array.isArray(content))
    return clip(
      content
        .map((c: any) => (c?.type === "text" ? String(c.text ?? "") : c?.type === "image" ? "[image]" : ""))
        .filter(Boolean)
        .join("\n"),
      8000,
    );
  return "";
}

/** A shift's "keep going" prompt (typed in, or Claude's Stop hook feedback) becomes a one-line note. */
function shiftNote(text: string): string | null {
  const m = text.replace(/^Stop hook feedback:\s*/, "").match(/^ansai shift: you're on shift until (.+?) \(/);
  return m ? `Kept going · on shift until ${m[1]}` : null;
}

/** Claude stores slash commands, reminders and command output as user text; keep only what a person typed. */
function cleanClaudeUser(text: string): { kind: "user" | "note"; text: string } | null {
  let t = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    // Claude Code 2.1 wraps pasted text (everything the compose box sends) in these tags.
    .replace(/<pasted_content id="[^"]*">\n?([\s\S]*?)\n?<\/pasted_content id="[^"]*">/g, "$1")
    .trim();
  if (!t) return null;
  if (isTeamDelivery(t)) return null; // shown from the team channel instead
  const shift = shiftNote(t);
  if (shift) return { kind: "note", text: shift };
  if (t.startsWith("[Request interrupted")) return { kind: "note", text: "Interrupted" };
  const cmd = t.match(/<command-name>([\s\S]*?)<\/command-name>(?:[\s\S]*?<command-args>([\s\S]*?)<\/command-args>)?/);
  if (cmd) return { kind: "user", text: `${cmd[1]!.trim()} ${cmd[2]?.trim() ?? ""}`.trim() };
  if (/^<(local-command-|bash-stdout|bash-stderr|command-message)/.test(t)) return null;
  const bash = t.match(/^<bash-input>([\s\S]*?)<\/bash-input>/);
  if (bash) return { kind: "user", text: `! ${bash[1]!.trim()}` };
  if (t.startsWith("Caveat: The messages below")) return null;
  return { kind: "user", text: t };
}

function parseClaude(line: string, st: ParseState, out: ChatItem[]) {
  const j = JSON.parse(line);
  if (j.type === "ai-title" && j.aiTitle) st.title = String(j.aiTitle);
  if (j.isSidechain) return; // sub-agent internals
  const ts = Date.parse(j.timestamp) || Date.now();
  if (j.type === "assistant" && typeof j.message?.model === "string" && !j.message.model.startsWith("<")) {
    st.model = j.message.model; // "<synthetic>" = Claude's own error/interrupt notes
    st.effort = typeof j.effort === "string" ? j.effort : null;
    const u = j.message.usage;
    if (u) st.context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
  }
  // A compaction (yours or Claude Code's own) shrinks the context right away; don't
  // wait for the next reply to show it, or a finished /compact looks like it did nothing.
  if (j.type === "system" && j.subtype === "compact_boundary") {
    const after = Number(j.compactMetadata?.postTokens);
    st.context = Number.isFinite(after) && after > 0 ? after : null;
  }
  if (j.type === "user") {
    if (j.isMeta) return;
    if (j.isCompactSummary) return void out.push({ id: j.uuid, k: "note", text: "Conversation compacted", ts });
    const c = j.message?.content;
    const blocks = typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : [];
    blocks.forEach((b: any, i: number) => {
      if (b.type === "text") {
        const raw = String(b.text ?? "");
        // /model and /effort answer in the log (the next reply then names the exact model id).
        // A session's first /model can land seconds late, after a following /effort, so it
        // leaves the effort alone.
        const setModel = raw.match(/^<local-command-stdout>Set model to `?([^`\n<]+?)`?(?: and saved| \(|<|$)/);
        if (setModel) st.model = setModel[1]!.trim();
        const setEffort = raw.match(/^<local-command-stdout>Set effort level to ([a-z]+)\b/);
        if (setEffort) st.effort = setEffort[1]!;
        const u = cleanClaudeUser(raw);
        if (!u) return;
        // A slash command (/model, /effort, /login…) isn't what you asked for; it mustn't name the session or its task.
        if (u.kind === "user" && !st.firstUser && !raw.includes("<command-name>")) st.firstUser = u.text;
        out.push({ id: `${j.uuid}:${i}`, k: u.kind, text: u.text, ts } as ChatItem);
      } else if (b.type === "image") {
        out.push({ id: `${j.uuid}:${i}`, k: "user", text: "🖼 image", ts });
      } else if (b.type === "tool_result") {
        const item = st.tools.get(b.tool_use_id);
        if (!item) return;
        item.result = resultText(b.content);
        item.error = !!b.is_error;
        item.done = true;
        out.push(item);
      }
    });
  } else if (j.type === "assistant") {
    (j.message?.content ?? []).forEach((b: any, i: number) => {
      const id = `${j.uuid}:${i}`;
      if (b.type === "text" && String(b.text ?? "").trim()) out.push({ id, k: "assistant", text: clip(String(b.text), 40000), ts });
      else if (b.type === "thinking" && String(b.thinking ?? "").trim()) out.push({ id, k: "thinking", text: clip(String(b.thinking), 12000), ts });
      else if (b.type === "tool_use") {
        if (EDIT_TOOLS.has(String(b.name))) noteTouched(st, b.input?.file_path ?? b.input?.notebook_path, ts);
        const { title, keep } = toolTitle(String(b.name), b.input);
        const item: ToolItem = { id: String(b.id), k: "tool", ts, name: String(b.name), title, input: keep, done: false };
        st.tools.set(item.id, item);
        out.push(item);
      }
    });
  } else if (j.type === "system" && j.level === "error" && j.content) {
    out.push({ id: j.uuid, k: "note", text: one(String(j.content), 200), ts });
  }
}

function codexOutput(raw: unknown): string {
  if (typeof raw !== "string") return resultText(raw);
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return resultText(v.map((x: any) => ({ type: "text", text: x.text ?? "" })));
    if (v && typeof v === "object" && "output" in v) return clip(String((v as any).output ?? ""), 8000);
  } catch {}
  return clip(raw, 8000);
}

function codexTool(name: string, raw: string): { title: string; keep?: Record<string, unknown> } {
  if (name === "update_plan") {
    try {
      const plan = (JSON.parse(raw)?.plan ?? []) as { step?: string; status?: string }[];
      return { title: "Plan", keep: { todos: plan.slice(0, 40).map((p) => ({ content: one(String(p.step ?? ""), 160), status: String(p.status ?? "pending") })) } };
    } catch {}
  }
  if (name === "apply_patch" || raw.includes("*** Begin Patch")) {
    const files = [...raw.matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)].map((m) => basename(m[1]!.trim()));
    return { title: files.length ? `Edit ${files.join(", ")}` : "Apply patch", keep: { patch: clip(raw, 8000) } };
  }
  const cmd = raw.match(/\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? raw.match(/"command"\s*:\s*\[([^\]]*)\]/)?.[1];
  if (cmd) {
    const pretty = cmd.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/^"bash",\s*"-lc",\s*"/, "").replace(/"$/, "");
    return { title: one(pretty, 90), keep: { command: clip(pretty, 4000) } };
  }
  // Codex "code mode": a script calling tools.<name>({...})
  const call = raw.match(/tools\.([a-zA-Z_]+)\s*\(/)?.[1];
  if (call) {
    const arg = raw.match(/\b(?:q|query|url|path|pattern)\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
    const label = call.replace(/__/g, " ").replace(/_/g, " ");
    return { title: arg ? `${label}: ${one(arg, 70)}` : label, keep: { code: clip(raw, 4000) } };
  }
  return { title: name, keep: { code: clip(raw, 4000) } };
}

function parseCodex(line: string, st: ParseState, out: ChatItem[], key: string) {
  const j = JSON.parse(line);
  if (j.type === "turn_context") {
    const c = j.payload ?? {};
    if (typeof c.model === "string") st.model = c.model;
    const effort = c.effort ?? c.collaboration_mode?.settings?.reasoning_effort;
    st.effort = typeof effort === "string" ? effort : null;
    return;
  }
  if (j.type === "event_msg" && j.payload?.type === "token_count") {
    const u = j.payload.info?.last_token_usage; // input_tokens already includes cached input
    if (u) st.context = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
    return;
  }
  if (j.type !== "response_item") return;
  const p = j.payload ?? {};
  const ts = Date.parse(j.timestamp) || Date.now();
  switch (p.type) {
    case "message": {
      const text = (p.content ?? []).map((c: any) => String(c.text ?? "")).join("\n").trim();
      if (!text) return;
      if (p.role === "user") {
        // environment, AGENTS.md and other instructions Codex injects as user turns
        if (text.startsWith("<") || text.startsWith("# AGENTS.md instructions") || text.includes("<INSTRUCTIONS>")) return;
        if (isTeamDelivery(text)) return;
        const shift = shiftNote(text);
        if (shift) return void out.push({ id: key, k: "note", text: shift, ts });
        if (!st.firstUser) st.firstUser = text;
        out.push({ id: key, k: "user", text, ts });
      } else if (p.role === "assistant") out.push({ id: key, k: "assistant", text: clip(text, 40000), ts });
      return;
    }
    case "reasoning": {
      const text = (p.summary ?? []).map((s: any) => String(s.text ?? "")).join("\n").trim();
      if (text) out.push({ id: key, k: "thinking", text: clip(text, 12000), ts });
      return;
    }
    case "function_call":
    case "custom_tool_call":
    case "local_shell_call": {
      const raw = p.type === "local_shell_call" ? JSON.stringify({ command: p.action?.command ?? [] }) : String(p.input ?? p.arguments ?? "");
      for (const m of raw.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\n\\"]+)/g)) noteTouched(st, m[1]!.trim(), ts);
      const { title, keep } = codexTool(String(p.name ?? "shell"), raw);
      const item: ToolItem = { id: String(p.call_id ?? key), k: "tool", ts, name: String(p.name ?? "shell"), title, input: keep, done: false };
      st.tools.set(item.id, item);
      out.push(item);
      return;
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      const item = st.tools.get(String(p.call_id));
      if (!item) return;
      item.result = codexOutput(p.output);
      item.error = /exit code: [1-9]|"exit_code":\s*[1-9]/i.test(item.result.slice(0, 400));
      item.done = true;
      out.push(item);
      return;
    }
  }
}

// --------------------------------------------------------------------- tails

type Sub = ServerWebSocket<any>;

class ChatTail {
  path: string | null = null;
  offset = 0;
  items: ChatItem[] = [];
  index = new Map<string, number>();
  st: ParseState = freshState();
  subs = new Set<Sub>();
  timer: ReturnType<typeof setInterval> | null = null;
  idleTimer: ReturnType<typeof setTimeout> | null = null;
  busy = false;
  truncated = false;

  constructor(public sessionId: string) {}

  private reset(path: string | null) {
    this.path = path;
    this.offset = 0;
    this.items = [];
    this.index.clear();
    this.st = freshState();
    this.truncated = false;
  }

  private apply(upserts: ChatItem[]): ChatItem[] {
    const changed = new Map<string, ChatItem>();
    for (const it of upserts) {
      const i = this.index.get(it.id);
      if (i === undefined) {
        this.index.set(it.id, this.items.length);
        this.items.push(it);
      } else this.items[i] = it;
      changed.set(it.id, it);
    }
    if (this.items.length > MAX_ITEMS) {
      this.items = this.items.slice(-MAX_ITEMS);
      this.index = new Map(this.items.map((x, i) => [x.id, i]));
      this.truncated = true;
    }
    return [...changed.values()];
  }

  send(ws: Sub, msg: object) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }
  broadcast(msg: object) {
    const s = JSON.stringify(msg);
    for (const ws of this.subs) if (ws.readyState === 1) ws.send(s);
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const s = getSession(this.sessionId);
      if (!s || (s.tool !== "claude" && s.tool !== "codex")) return;
      const want = await resolveTranscript(s);
      if (!want) return;
      if (want !== this.path) {
        // first attach, or Claude started a fresh log after /clear
        const hadPath = this.path !== null;
        this.reset(want);
        if (hadPath) this.broadcast({ t: "reset" });
      }
      const file = Bun.file(want);
      const size = file.size;
      if (size < this.offset) {
        this.reset(want);
        this.broadcast({ t: "reset" });
      }
      if (size === this.offset) return;
      let start = this.offset;
      if (start === 0 && size > MAX_FIRST_READ) {
        start = size - MAX_FIRST_READ;
        this.truncated = true;
      }
      const buf = Buffer.from(await file.slice(start, size).arrayBuffer());
      let from = 0;
      if (start !== this.offset) from = buf.indexOf(10) + 1; // skip partial first line
      const lastNl = buf.lastIndexOf(10);
      if (lastNl < from) return;
      const upserts: ChatItem[] = [];
      let pos = from;
      while (pos <= lastNl) {
        const nl = buf.indexOf(10, pos);
        const line = buf.subarray(pos, nl).toString("utf8");
        const key = `${start + pos}`;
        pos = nl + 1;
        if (!line.trim()) continue;
        try {
          if (s.tool === "claude") parseClaude(line, this.st, upserts);
          else parseCodex(line, this.st, upserts, key);
        } catch {}
      }
      const firstLoad = this.offset === 0;
      this.offset = start + lastNl + 1;
      const changed = this.apply(upserts);
      if (!firstLoad && changed.length) this.broadcast({ t: "items", items: changed });
      if (firstLoad) for (const ws of this.subs) this.sendInit(ws);
      this.autoTitle(s);
      this.recordModel(s);
      if (!firstLoad && this.st.context !== this.sentCtx) this.broadcast({ t: "ctx", tokens: (this.sentCtx = this.st.context) });
      this.recordAsTask(s);
      this.mirrorPlan(s, changed);
      if (!firstLoad) this.noteInterrupt(s, upserts);
    } catch (e) {
      console.error("[ansai] chat tail:", e);
    } finally {
      this.busy = false;
    }
  }

  /** Last context size sent to viewers. */
  sentCtx: number | null = null;

  sendInit(ws: Sub) {
    this.sentCtx = this.st.context;
    this.send(ws, { t: "init", items: this.items.slice(-FIRST_SEND), more: this.truncated || this.items.length > FIRST_SEND, found: !!this.path, ctx: this.st.context });
  }

  /** The latest plan (TodoWrite / update_plan) shows up on the session's backlog task. */
  private mirrorPlan(s: SessionRow, changed: ChatItem[]) {
    const taskId = getSession(s.id)?.task_id;
    if (!taskId) return;
    const plans = changed.filter((x): x is ToolItem => x.k === "tool" && Array.isArray((x.input as any)?.todos));
    const last = plans[plans.length - 1];
    if (last) setPlan(taskId, (last.input as any).todos);
  }

  /**
   * Claude sends no hook when you interrupt it (Esc), so its state would stay "working"
   * (or "needs-input", when Esc declined a permission) until the next prompt. Its log
   * does record the interrupt: when that's the newest thing it wrote, it's waiting for you.
   */
  private noteInterrupt(s: SessionRow, upserts: ChatItem[]) {
    const last = upserts[upserts.length - 1];
    if (s.tool !== "claude" || !last || last.k !== "note" || last.text !== "Interrupted") return;
    const r = db
      .query(`UPDATE sessions SET agent_state = 'waiting', agent_state_at = ?, agent_message = 'Interrupted' WHERE id = ? AND agent_state IN ('working', 'needs-input')`)
      .run(Date.now(), s.id);
    if (r.changes) emit("sessions");
  }

  /** Keep the session's model + effort in step with what the agent last ran on. */
  private recordModel(s: SessionRow) {
    if (!this.st.model) return;
    const fresh = getSession(s.id);
    if (!fresh || (fresh.model === this.st.model && fresh.effort === this.st.effort)) return;
    db.query("UPDATE sessions SET model = ?, effort = ? WHERE id = ?").run(this.st.model, this.st.effort, s.id);
    emit("sessions");
  }

  /** Sessions you start by hand are recorded in the backlog (Settings → Backlog). */
  private recordAsTask(s: SessionRow) {
    const fresh = getSession(s.id);
    if (!fresh || fresh.task_id || !this.st.firstUser || fresh.title.startsWith("Sign in")) return;
    if (!getSettings().trackSessions) return;
    const first = this.st.firstUser.trim();
    const task = createTask({
      title: one(first.split("\n")[0]!, 100),
      body: first.includes("\n") || first.length > 100 ? clip(first, 4000) : "",
      projectId: fresh.project_id,
      status: "doing",
      source: "session",
      queued: false,
    });
    db.query("UPDATE sessions SET task_id = ? WHERE id = ? AND task_id IS NULL").run(task.id, s.id);
    emit("sessions");
  }

  /** Sessions started without a name get Claude's own title, or the first thing you asked. */
  private autoTitle(s: SessionRow) {
    if (!/^(Claude Code|Codex|Antigravity)( · .+)?$/.test(s.title)) return;
    const t = this.st.title ?? (this.st.firstUser ? one(this.st.firstUser.split("\n")[0]!, 60) : null);
    if (t && t !== s.title) {
      db.query("UPDATE sessions SET title = ? WHERE id = ?").run(t, s.id);
      emit("sessions");
    }
  }

  start() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.timer) this.timer = setInterval(() => this.poll(), 800);
  }
  stopSoon() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.subs.size) return;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      // Running agents keep a (slow) background tail for plans and task tracking.
      if (getSession(this.sessionId)?.status !== "running") tails.delete(this.sessionId);
    }, 60_000);
  }
}

const tails = new Map<string, ChatTail>();

export async function subscribeChat(sessionId: string, ws: Sub) {
  let tail = tails.get(sessionId);
  if (!tail) tails.set(sessionId, (tail = new ChatTail(sessionId)));
  tail.subs.add(ws);
  tail.start();
  if (tail.offset > 0) tail.sendInit(ws);
  else {
    await tail.poll();
    if (tail.offset === 0) tail.send(ws, { t: "init", items: [], more: false, found: !!tail.path }); // nothing written yet
  }
}

/** Follow every running Claude/Codex session in the background (every 3 s) so tasks show live plans. */
export function startBackgroundTails(ms = 3000) {
  setInterval(() => {
    const running = db.query("SELECT id FROM sessions WHERE status = 'running' AND tool IN ('claude', 'codex')").all() as { id: string }[];
    const ids = new Set(running.map((r) => r.id));
    for (const { id } of running) {
      let tail = tails.get(id);
      if (!tail) tails.set(id, (tail = new ChatTail(id)));
      if (!tail.subs.size) tail.poll();
    }
    for (const [id, tail] of tails) if (!ids.has(id) && !tail.subs.size && !tail.timer) tails.delete(id);
  }, ms);
}

/** Files a running agent has edited, most recent first (paths relative to its working folder when inside it). */
export function touchedFiles(s: SessionRow, limit = 25): string[] {
  const t = tails.get(s.id);
  if (!t) return [];
  const root = s.cwd.endsWith("/") ? s.cwd : s.cwd + "/";
  return [...t.st.touched.keys()]
    .reverse()
    .slice(0, limit)
    .map((p) => (p.startsWith(root) ? p.slice(root.length) : p.replace(config.home, "~")));
}

export function unsubscribeChat(sessionId: string, ws: Sub) {
  const tail = tails.get(sessionId);
  if (!tail) return;
  tail.subs.delete(ws);
  if (!tail.subs.size) tail.stopSoon();
}

/** A running agent's current context size in tokens (from its log, followed every few seconds), or null. */
export function contextSize(sessionId: string): number | null {
  return tails.get(sessionId)?.st.context ?? null;
}
