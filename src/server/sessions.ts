import { writeFileSync, existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { config, cleanEnv } from "./config";
import { db, newId, now } from "./db";
import { badRequest, conflict, notFound } from "./errors";
import { TOOLS, relaunchChoice, type ToolId } from "./tools";
import { getProject, touchProject } from "./projects";
import { emit } from "./events";
import { shiftView } from "./shifts";
import { accountEnv, getAccount, refreshAccountsSoon, resolveAccount, type AccountRow } from "./accounts";
import { codexScreen, onExited, startupScreen, withHooks } from "./hooks";

// ---------------------------------------------------------------- tmux plumbing

const TMUX_CONF = `# managed by ansai — regenerated on start
set -g default-terminal "tmux-256color"
set -as terminal-features ",xterm-256color:RGB"
set -sg escape-time 0
set -g history-limit 50000
# Keep the server alive with no sessions; ansai starts it once in its own systemd scope.
set -s exit-empty off
set -g status off
set -g mouse on
set -g window-size latest
set -g remain-on-exit on
set -g focus-events on
set -g allow-rename off
set -g set-titles off
# No prefix key: Ctrl-B etc. must reach the agents. ansai drives tmux via commands.
set -g prefix None
unbind C-b
# Detach when attached from a local terminal: Ctrl-Alt-d
bind -n C-M-d detach-client
`;

export function writeTmuxConf() {
  writeFileSync(config.tmuxConf, TMUX_CONF);
}

export function tmuxBase(): string[] {
  return ["tmux", "-u", "-L", config.tmuxSocket, "-f", config.tmuxConf];
}

let serverChecked = false;

/**
 * Agents must outlive ansai. Under systemd, everything in ansai.service's cgroup is
 * signalled when the service stops (even with KillMode=process), so the tmux server is
 * started in its own transient scope instead. Without systemd, a plain start is fine.
 */
async function ensureServer() {
  if (serverChecked) return;
  const probe = await tmux(["list-sessions"]);
  if (probe.code === 0 || !/no server running|error connecting|No such file/i.test(probe.err)) {
    serverChecked = true;
    return;
  }
  const scoped = Bun.which("systemd-run") && process.env.XDG_RUNTIME_DIR;
  const cmd = scoped
    ? ["systemd-run", "--user", "--scope", "--quiet", "--collect", `--unit=ansai-tmux-${Date.now()}`, ...tmuxBase(), "start-server"]
    : [...tmuxBase(), "start-server"];
  const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe", env: cleanEnv() });
  const err = await new Response(p.stderr).text();
  if ((await p.exited) !== 0 && scoped) {
    console.error("[ansai] systemd-run failed, starting tmux directly:", err.trim());
    await tmux(["start-server"]);
  }
  serverChecked = true;
}

async function tmux(args: string[], stdin?: string) {
  const p = Bun.spawn([...tmuxBase(), ...args], {
    stdin: stdin !== undefined ? new Blob([stdin]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: cleanEnv(),
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, out, err: err.trim() };
}

// --------------------------------------------------------------------- model

export type SessionRow = {
  id: string;
  project_id: string | null;
  task_id: string | null;
  account_id: string | null;
  tool: ToolId;
  title: string;
  cwd: string;
  argv: string;
  tmux_name: string;
  status: "running" | "exited" | "closed";
  exit_code: number | null;
  agent_state: string | null;
  agent_state_at: number | null;
  agent_message: string | null;
  transcript: string | null;
  model: string | null;
  effort: string | null;
  auto: number;
  /** Newest team message id already delivered to this agent. */
  msg_cursor: number;
  created_at: number;
  ended_at: number | null;
};

type Live = { activity: number; command: string; attached: number };
const live = new Map<string, Live>(); // keyed by tmux_name

/** A dialog the agent shows before it starts (trust this folder, bypass-mode warning, first-run setup). */
export type StartupPrompt = { kind: string; message: string; accept: string | null; acceptKeys: string[]; decline: string | null; declineKeys: string[] };
const startup = new Map<string, StartupPrompt>(); // keyed by session id

type Dialog = { kind: string; match: RegExp; message: string; accept: string | null; acceptKeys: string[]; decline?: string; declineKeys?: string[] };
// Claude Code 2.1's startup screens. Both yes/no menus open on "No, exit", so accepting is Down + Enter.
// Every pattern has an escape or a [x] class, so this file's own text on an agent's screen
// (say, a diff of it in an approval prompt) can never match it.
const CLAUDE_DIALOGS: Dialog[] = [
  {
    kind: "trust",
    match: /(Is this a project you created or one you trust|Do you trust the files in this folder)\?/i,
    message: "Claude asks whether you trust this folder before it starts.",
    accept: "Trust folder",
    acceptKeys: ["Down", "Enter"],
    decline: "Exit",
    declineKeys: ["Enter"],
  },
  {
    kind: "bypass",
    match: /running in Bypass Permissions mod[e]/i,
    message: "Claude wants you to confirm auto-approve (bypass permissions) mode.",
    accept: "Accept",
    acceptKeys: ["Down", "Enter"],
    decline: "Exit",
    declineKeys: ["Enter"],
  },
  { kind: "theme", match: /Choose the text style that looks bes[t]/i, message: "First run: Claude asks for a text style.", accept: "Use default", acceptKeys: ["Enter"] },
  { kind: "login", match: /Select login metho[d]/i, message: "This account isn't signed in. Open the terminal to sign in.", accept: null, acceptKeys: [] },
  { kind: "apikey", match: /Do you want to use this API key\?/i, message: "Claude asks whether to use an API key from your environment.", accept: null, acceptKeys: [] },
];
// Codex 0.169 asks to trust the folder, with option 1 (trust and continue) preselected; Esc goes back.
// Patterns need the menu too, so an agent merely showing this text (say, this file) doesn't trip them.
const CODEX_DIALOGS: Dialog[] = [
  {
    kind: "trust",
    match: /Trust this folder\? Codex can read[\s\S]*1\. Trust and continue/i,
    message: "Codex asks whether you trust this folder before it starts.",
    accept: "Trust folder",
    acceptKeys: ["Enter"],
    decline: "Back",
    declineKeys: ["Escape"],
  },
];
// Antigravity CLI asks to trust the project, with its yes option preselected; Down + Enter exits.
const AGY_DIALOGS: Dialog[] = [
  {
    kind: "trust",
    match: /Do you trust the contents of this project\?[\s\S]*Yes, I trust this folder[\s\S]*No, exit/i,
    message: "Antigravity asks whether you trust this folder before it starts.",
    accept: "Trust folder",
    acceptKeys: ["Enter"],
    decline: "Exit",
    declineKeys: ["Down", "Enter"],
  },
];
const DIALOGS: Partial<Record<ToolId, Dialog[]>> = { claude: CLAUDE_DIALOGS, codex: CODEX_DIALOGS, agy: AGY_DIALOGS };

export function sessionView(s: SessionRow) {
  const l = live.get(s.tmux_name);
  const project = s.project_id ? getProject(s.project_id) : null;
  return {
    ...s,
    argv: JSON.parse(s.argv) as string[],
    project_name: project?.name ?? null,
    activity_at: l?.activity ?? null,
    current_command: l?.command ?? null,
    clients: l?.attached ?? 0,
    startup: startup.get(s.id) ?? null,
    shift: shiftView(s.id),
  };
}
export type SessionView = ReturnType<typeof sessionView>;

export function getSession(id: string): SessionRow | null {
  return db.query("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | null;
}

export function listSessions(opts: { projectId?: string; includeClosed?: boolean } = {}) {
  const where: string[] = [];
  const args: string[] = [];
  if (!opts.includeClosed) where.push("status != 'closed'");
  if (opts.projectId) {
    where.push("project_id = ?");
    args.push(opts.projectId);
  }
  const rows = db
    .query(`SELECT * FROM sessions ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC`)
    .all(...args) as SessionRow[];
  return rows.map(sessionView);
}

// ------------------------------------------------------------------ lifecycle

export type CreateOpts = {
  projectId?: string;
  cwd?: string;
  tool: ToolId;
  title?: string;
  prompt?: string;
  yolo?: boolean;
  /** Model and reasoning effort to start with; unset = the agent's own default. */
  model?: string | null;
  effort?: string | null;
  accountId?: string | null;
  taskId?: string | null;
  /** Internal: run this exact command instead of the tool's normal one (e.g. a login flow). */
  argv?: string[];
  /** Internal: started by autopilot from the queue. */
  auto?: boolean;
};

function sessionEnv(id: string, account: AccountRow | null, cwd: string): string[] {
  const env: Record<string, string> = { ANSAI_SESSION_ID: id, ...accountEnv(account, cwd) };
  return Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
}

export async function createSession(o: CreateOpts) {
  const tool = TOOLS[o.tool];
  const project = o.projectId ? getProject(o.projectId) : null;
  if (o.projectId && !project) throw badRequest("no such project");
  const cwd = o.cwd ?? project?.path ?? config.home;
  if (!existsSync(cwd)) throw conflict(`directory does not exist: ${cwd}`);
  if (!Bun.which(tool.bin)) throw new Error(`${tool.label} (${tool.bin}) is not installed`);

  const account = o.tool === "shell" ? null : resolveAccount(o.tool, o.accountId);
  const id = newId("s");
  const tmuxName = `ansai-${id}`;
  const launch = { yolo: o.yolo, model: o.model || undefined, effort: o.effort || undefined };
  const playbook = o.tool !== "shell" ? effectivePlaybook(project?.playbook ?? "") : "";
  const prompt = [playbook, o.prompt?.trim()].filter(Boolean).join("\n\n");
  const argv = o.argv ?? withHooks(o.tool, tool.argv({ ...launch, prompt: prompt || undefined }), id);
  const title =
    o.title?.trim() ||
    (o.prompt?.trim() ? o.prompt.trim().split("\n")[0]!.slice(0, 60) : `${tool.label}${project ? " · " + project.name : ""}`);

  await ensureServer();
  const r = await tmux(["new-session", "-d", "-s", tmuxName, "-x", "160", "-y", "48", "-c", cwd, ...sessionEnv(id, account, cwd), "--", ...argv]);
  if (r.code !== 0) throw new Error(`tmux: ${r.err || "failed to start session"}`);

  db.query(
    `INSERT INTO sessions (id, project_id, task_id, account_id, tool, title, cwd, argv, tmux_name, status, created_at, auto, msg_cursor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, (SELECT COALESCE(MAX(id), 0) FROM messages))`,
  ).run(id, project?.id ?? null, o.taskId ?? null, account?.id ?? null, tool.id, title, cwd, JSON.stringify(argv), tmuxName, now(), o.auto ? 1 : 0);
  if (project) touchProject(project.id);
  await reconcile();
  refreshAccountsSoon();
  return sessionView(getSession(id)!);
}

// Within this, the agent's prompt cache is still warm: resuming its conversation is cheap.
// Past it, resuming re-writes the whole context at full price, so a fresh start is better.
const WARM_MS = 55 * 60_000;

/**
 * The agent's own conversation id, if resuming it is worth it: taken from its log's
 * file name (Claude: <id>.jsonl; Codex: rollout-<time>-<id>.jsonl), and only while
 * the log was written to recently enough for the cache to be warm.
 */
export function resumableConversation(s: Pick<SessionRow, "tool" | "transcript">, now = Date.now()): string | null {
  if ((s.tool !== "claude" && s.tool !== "codex") || !s.transcript) return null;
  const id = basename(s.transcript).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1];
  if (!id) return null;
  try {
    return now - statSync(s.transcript).mtimeMs < WARM_MS ? id : null;
  } catch {
    return null;
  }
}

/** Re-run the same command in the same pane (after the agent exited, or to force a restart). */
export async function restartSession(id: string) {
  const s = getSession(id);
  if (!s) throw notFound("no such session");
  const argv = JSON.parse(s.argv) as string[];
  // A restarted agent shouldn't replay the original prompt (or a login flow), but keeps its model and effort.
  const tool = TOOLS[s.tool];
  const keep = { yolo: argv.some((a) => a.startsWith("--dangerously")), ...relaunchChoice(argv, s) };
  // Pick the conversation back up while its cache is warm (claude --resume <id>, codex resume <id>).
  const conv = resumableConversation(s);
  const playbook = s.tool !== "shell" ? effectivePlaybook(s.project_id ? getProject(s.project_id)?.playbook ?? "" : "") : "";
  const fresh = tool.argv({ ...keep, prompt: playbook || undefined });
  const launch = !conv ? fresh : s.tool === "claude" ? [...fresh, "--resume", conv] : [fresh[0]!, "resume", conv, ...fresh.slice(1)];
  const base = s.tool === "shell" ? argv : withHooks(s.tool, launch, s.id);
  const account = s.account_id ? getAccount(s.account_id) : null;
  const env = sessionEnv(s.id, account, s.cwd); // also prepares the profile, which a respawn needs too
  const alive = (await tmux(["has-session", "-t", s.tmux_name])).code === 0;
  if (alive) {
    const r = await tmux(["respawn-pane", "-k", "-t", s.tmux_name, "-c", s.cwd, "--", ...base]);
    if (r.code !== 0) throw new Error(`tmux: ${r.err}`);
  } else {
    await ensureServer();
    const r = await tmux(["new-session", "-d", "-s", s.tmux_name, "-x", "160", "-y", "48", "-c", s.cwd, ...env, "--", ...base]);
    if (r.code !== 0) throw new Error(`tmux: ${r.err}`);
  }
  db.query("UPDATE sessions SET argv = ?, agent_state = NULL WHERE id = ?").run(JSON.stringify(base), id);
  db.query("UPDATE sessions SET status = 'running', exit_code = NULL, ended_at = NULL WHERE id = ?").run(id);
  await reconcile();
  return sessionView(getSession(id)!);
}

/** Render the stored project guidance in the agent's prompt with an explicit conflict rule. */
export function effectivePlaybook(text: string): string {
  const content = text.trim();
  return content ? `Project playbook (managed by ansai; source: this project's Playbook setting):\n${content}\n\nPrecedence: follow system and developer instructions first. Repository instruction files govern repository-specific requirements and take precedence over this playbook where they conflict. Follow this playbook for project guidance not covered by higher-priority instructions.` : "";
}

export async function closeSession(id: string) {
  const s = getSession(id);
  if (!s) throw notFound("no such session");
  await tmux(["kill-session", "-t", s.tmux_name]);
  db.query("UPDATE sessions SET status = 'closed', ended_at = COALESCE(ended_at, ?) WHERE id = ?").run(now(), id);
  if (s.status === "running") onExited(id, null, "closed"); // closing an already-exited session changes nothing
  live.delete(s.tmux_name);
  await reconcile();
}

export async function renameSession(id: string, title: string) {
  db.query("UPDATE sessions SET title = ? WHERE id = ?").run(title.slice(0, 120), id);
}

// --------------------------------------------------------------- interaction

export async function captureHistory(id: string, lines = 3000): Promise<string> {
  const s = getSession(id);
  if (!s) throw notFound("no such session");
  const r = await tmux(["capture-pane", "-p", "-J", "-S", `-${lines}`, "-t", s.tmux_name]);
  if (r.code !== 0) throw new Error(`tmux: ${r.err}`);
  return r.out.replace(/\s+$/, "") + "\n";
}

/** Input only makes sense for a live agent; a stopped one answers 409 instead of a tmux error. */
function liveSession(id: string): SessionRow {
  const s = getSession(id);
  if (!s) throw notFound("no such session");
  if (s.status !== "running") throw conflict(s.status === "closed" ? "this session is closed" : "this session isn't running; restart it first");
  return s;
}

export async function scroll(id: string, dir: "up" | "down" | "exit") {
  const s = liveSession(id);
  if (dir === "up") await tmux(["copy-mode", "-e", "-u", "-t", s.tmux_name]);
  else {
    const inMode = (await tmux(["display", "-p", "-t", s.tmux_name, "#{pane_in_mode}"])).out.trim() === "1";
    if (inMode) await tmux(["send-keys", "-t", s.tmux_name, "-X", dir === "down" ? "page-down" : "cancel"]);
  }
}

/** Paste text as a bracketed paste (so multi-line prompts don't submit early), then optionally press Enter. */
export async function sendText(id: string, text: string, enter = true) {
  const s = liveSession(id);
  const t = s.tmux_name;
  const inMode = (await tmux(["display", "-p", "-t", t, "#{pane_in_mode}"])).out.trim() === "1";
  if (inMode) await tmux(["send-keys", "-t", t, "-X", "cancel"]);
  if (text) {
    const buf = `ansai-${s.id}`;
    let r = await tmux(["load-buffer", "-b", buf, "-"], text);
    if (r.code !== 0) throw new Error(`tmux: ${r.err}`);
    r = await tmux(["paste-buffer", "-p", "-d", "-b", buf, "-t", t]);
    if (r.code !== 0) throw new Error(`tmux: ${r.err}`);
  }
  if (enter) {
    if (text) await Bun.sleep(120); // let TUIs finish ingesting the paste
    await tmux(["send-keys", "-t", t, "Enter"]);
  }
}

const NAMED_KEYS = new Set(["Enter", "Escape", "Tab", "BTab", "Up", "Down", "Left", "Right", "C-c", "Space", "BSpace"]);

/** Press keys in the agent's terminal without a terminal open (chat view answers prompts this way). */
export async function sendKeys(id: string, keys: string[]) {
  const s = liveSession(id);
  for (const k of keys.slice(0, 20)) {
    if (NAMED_KEYS.has(k)) await tmux(["send-keys", "-t", s.tmux_name, k]);
    else if (/^[ -~]{1,8}$/.test(k)) await tmux(["send-keys", "-t", s.tmux_name, "-l", k]);
    else throw badRequest(`unsupported key: ${k}`);
  }
}

const CODEX_ASK = /Would you like to (run the following command|make the following edits|grant these permissions|send input to the existing terminal)/;

/** Codex shows approvals only on screen; read the visible pane of running Codex sessions. */
async function watchCodexScreens() {
  const rows = db.query("SELECT id, tmux_name FROM sessions WHERE tool = 'codex' AND status = 'running'").all() as { id: string; tmux_name: string }[];
  for (const r of rows) {
    if (startup.has(r.id)) continue; // a startup dialog, not an approval; watchStartupScreens owns it
    const cap = await tmux(["capture-pane", "-p", "-J", "-t", r.tmux_name]);
    if (cap.code !== 0) continue;
    const lines = cap.out.split("\n");
    const i = lines.findIndex((l) => CODEX_ASK.test(l));
    let prompt: string | null = null;
    if (i >= 0) {
      const ask = lines[i]!.trim().replace(/^[^A-Za-z]+/, "");
      const detail = lines
        .slice(i + 1, i + 6)
        .map((l) => l.trim().replace(/^[│|>$]+\s*/, ""))
        .find((l) => l && !/^(›|\d+\.|Yes|No)/.test(l));
      prompt = detail ? `${ask} ${detail}`.slice(0, 200) : ask;
    }
    codexScreen(r.id, prompt);
  }
}

/**
 * Claude (and Codex) show a few screens before they run hooks (so before ansai hears from it):
 * the folder-trust question, the bypass-mode warning, first-run setup. Spot them on
 * screen so the session says "Needs you" instead of sitting there silently. Task
 * worktrees ansai made from your own project are trusted automatically.
 */
async function watchStartupScreens() {
  const rows = db
    .query(`SELECT id, tool, tmux_name, cwd, agent_state FROM sessions WHERE tool IN ('claude', 'codex', 'agy') AND status = 'running' AND (agent_state IS NULL OR agent_state = 'needs-input')`)
    .all() as Pick<SessionRow, "id" | "tool" | "tmux_name" | "cwd" | "agent_state">[];
  for (const r of rows) {
    const cap = await tmux(["capture-pane", "-p", "-J", "-t", r.tmux_name]);
    if (cap.code !== 0) continue;
    const d = (DIALOGS[r.tool] ?? []).find((x) => x.match.test(cap.out));
    const prev = startup.get(r.id);
    if (r.agent_state === "needs-input" && !prev) {
      // Either a real approval (from hooks; leave it alone), or a startup screen this ansai
      // hasn't seen yet because it restarted while the agent sat on it: without the entry the
      // UI would offer generic Allow (Enter), which on these menus picks "No, exit".
      if (!d) continue;
      if (!(d.kind === "trust" && r.cwd.startsWith(config.dataDir + "/worktrees/"))) {
        startup.set(r.id, { kind: d.kind, message: d.message, accept: d.accept, acceptKeys: d.acceptKeys, decline: d.decline ?? null, declineKeys: d.declineKeys ?? [] });
        emit("sessions"); // already marked Needs you (and pushed) before the restart
        continue;
      }
    }
    if (d?.kind === "trust" && r.cwd.startsWith(config.dataDir + "/worktrees/")) {
      if (prev?.kind !== "trust-auto") {
        startup.set(r.id, { kind: "trust-auto", message: "", accept: null, acceptKeys: [], decline: null, declineKeys: [] });
        for (const k of d.acceptKeys) await tmux(["send-keys", "-t", r.tmux_name, k]);
      }
      continue;
    }
    if (d && prev?.kind !== d.kind) {
      startup.set(r.id, { kind: d.kind, message: d.message, accept: d.accept, acceptKeys: d.acceptKeys, decline: d.decline ?? null, declineKeys: d.declineKeys ?? [] });
      startupScreen(r.id, d.message);
    } else if (!d && prev) {
      startup.delete(r.id);
      if (prev.kind !== "trust-auto") startupScreen(r.id, null);
    }
  }
}

// ---------------------------------------------------------------- reconcile

let lastStatusSig = "";
let lastActivitySig = "";

/** Sync DB status with what tmux actually has. Returns true if anything changed. */
export async function reconcile(): Promise<boolean> {
  const r = await tmux([
    "list-panes",
    "-a",
    "-F",
    "#{session_name}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_current_command}\t#{window_activity}\t#{session_attached}",
  ]);
  const seen = new Map<string, { dead: boolean; code: number | null }>();
  if (r.code !== 0 && /no server running|error connecting/i.test(r.err)) serverChecked = false; // start it scoped again next time
  if (r.code === 0) {
    for (const line of r.out.split("\n")) {
      if (!line.startsWith("ansai-")) continue;
      const [name, dead, code, cmd, act, att] = line.split("\t");
      seen.set(name!, { dead: dead === "1", code: code ? Number(code) : null });
      live.set(name!, { activity: Number(act) * 1000, command: cmd ?? "", attached: Number(att) || 0 });
    }
  }
  const running = db.query("SELECT id, tmux_name, status FROM sessions WHERE status != 'closed'").all() as Pick<
    SessionRow,
    "id" | "tmux_name" | "status"
  >[];
  const upd = db.query("UPDATE sessions SET status = ?, exit_code = ?, ended_at = COALESCE(ended_at, ?) WHERE id = ?");
  for (const s of running) {
    const t = seen.get(s.tmux_name);
    if (!t) {
      // tmux session vanished (killed outside ansai, or reboot)
      upd.run("exited", null, now(), s.id);
      // Only on the transition: exited sessions whose tmux is gone come through here every tick.
      if (s.status === "running") onExited(s.id, null, "vanished");
      live.delete(s.tmux_name);
    } else if (t.dead && s.status === "running") {
      upd.run("exited", t.code, now(), s.id);
      onExited(s.id, t.code, "exited");
    }
    else if (!t.dead && s.status === "exited")
      db.query("UPDATE sessions SET status = 'running', exit_code = NULL, ended_at = NULL WHERE id = ?").run(s.id);
  }
  const statusSig = JSON.stringify(db.query("SELECT id, status, title, agent_state FROM sessions WHERE status != 'closed'").all());
  const activitySig = JSON.stringify([...live.entries()].map(([k, v]) => [k, Math.floor(v.activity / 3000), v.attached]));
  const statusChanged = statusSig !== lastStatusSig;
  const changed = statusChanged || activitySig !== lastActivitySig;
  lastStatusSig = statusSig;
  lastActivitySig = activitySig;
  if (changed) emit("sessions");
  if (statusChanged) emit("tasks"); // tasks show their linked sessions
  return changed;
}

export function startReconcileLoop(ms = 2000) {
  const tick = () =>
    reconcile()
      .then(watchCodexScreens)
      .then(watchStartupScreens)
      .catch((e) => console.error("reconcile:", e))
      .finally(() => setTimeout(tick, ms));
  tick();
}
