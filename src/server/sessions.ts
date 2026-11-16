import { writeFileSync, existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { config, cleanEnv } from "./config";
import { db, newId, now } from "./db";
import { badRequest, conflict, notFound } from "./errors";
import { TOOLS, relaunchChoice, type ToolId } from "./tools";
import { runDeadline, sessionTokens } from "./runs";
import { agySignInHint, checkKeyring, noteAgySignedOut } from "./agyauth";
import { getProject, touchProject } from "./projects";
import { emit } from "./events";
import { shiftView } from "./shifts";
import { accountEnv, getAccount, refreshAccountsSoon, resolveAccount, type AccountRow } from "./accounts";
import { agySaw, codexScreen, onExited, playbookNote, startupScreen, withHooks, type HookOpts } from "./hooks";
import { isLean } from "./lean";
import { dropAttachments } from "./attachments";
import { KEY_ENV, dropSessionKey, hasSessionKey, sessionKey } from "./sessionkeys";

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

type TmuxResult = { code: number; out: string; err: string };
let runTmux = async (args: string[], stdin?: string): Promise<TmuxResult> => {
  const p = Bun.spawn([...tmuxBase(), ...args], {
    stdin: stdin !== undefined ? new Blob([stdin]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: cleanEnv(),
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, out, err: err.trim() };
};
const tmux = (args: string[], stdin?: string) => runTmux(args, stdin);
/** Tests: stand in for the tmux binary (they never touch a real tmux server). */
export function setTmux(f: typeof runTmux): typeof runTmux {
  const was = runTmux;
  runTmux = f;
  return was;
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
/** When the pane last printed anything (ms), as of the last reconcile; null before ansai has seen it. */
export const paneActivity = (tmuxName: string): number | null => live.get(tmuxName)?.activity ?? null;

/** A dialog the agent shows before it starts (trust this folder, bypass-mode warning, first-run setup). */
export type StartupPrompt = { kind: string; message: string; accept: string | null; acceptKeys: string[]; decline: string | null; declineKeys: string[] };
const startup = new Map<string, StartupPrompt>(); // keyed by session id

/** Startup buttons only while the agent is still on that screen; a later real approval gets its own. */
function visibleStartup(s: Pick<SessionRow, "id" | "agent_state" | "agent_message">): StartupPrompt | null {
  const p = startup.get(s.id);
  return p && p.message && s.agent_state === "needs-input" && s.agent_message === p.message ? p : null;
}
/** The agent is past its startup screens (a hook fired): forget the dialog. */
export function clearStartup(id: string): boolean {
  return startup.delete(id);
}
export const hasStartup = (id: string) => startup.has(id);
/** Record a detected startup dialog (the watcher; tests). */
export function rememberStartup(id: string, p: StartupPrompt) {
  startup.set(id, p);
}

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
  // Signed out, agy opens on its sign-in menu. Signing in is a Google OAuth flow, so nothing is answered for you.
  {
    kind: "login",
    match: /You are currently not signed i[n]\.[\s\S]*Select login method[\s\S]*1\. Google OAut[h]/i,
    message: "agy isn't signed in. Run `agy` in a terminal on this laptop to sign in (it opens Google sign-in), then restart this session.",
    accept: null,
    acceptKeys: [],
  },
];
const DIALOGS: Partial<Record<ToolId, Dialog[]>> = { claude: CLAUDE_DIALOGS, codex: CODEX_DIALOGS, agy: AGY_DIALOGS };

/**
 * The startup screen an agent's terminal shows, if any. Agents re-wrap their text to the
 * terminal's width (a phone's is narrow: "You are currently / not signed in.") and draw
 * boxes, so borders and line breaks are flattened to single spaces before matching.
 */
export function startupDialog(tool: ToolId, screen: string) {
  const flat = screen.replace(/[\u2500-\u257f]/g, " ").replace(/\s+/g, " ");
  return (DIALOGS[tool] ?? []).find((x) => x.match.test(flat)) ?? null;
}

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
    startup: visibleStartup(s),
    shift: shiftView(s.id),
    /** Tokens spent so far (from the agent's log), and when an autopilot run hits its time limit. */
    tokens: sessionTokens(s.id),
    deadline: runDeadline(s),
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
  /** Special system instructions for constrained sessions such as independent reviewers. */
  instructions?: string;
  readOnly?: boolean;
  /** Run immediately after the session row exists, before hooks can report results. */
  onCreated?: (id: string) => void;
};

/** Lean startup for the project, and the account's Claude config folder (whose plugins it checks). */
const hookOpts = (projectId: string | null | undefined, account: AccountRow | null): HookOpts => ({
  lean: isLean(projectId),
  configDir: account?.tool === "claude" && account.dir ? account.dir : undefined,
});

function sessionEnv(id: string, account: AccountRow | null, cwd: string): string[] {
  const env: Record<string, string> = { ANSAI_SESSION_ID: id, [KEY_ENV]: sessionKey(id), ...accountEnv(account, cwd) };
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
  const launch = { yolo: o.yolo, model: o.model || undefined, effort: o.effort || undefined, readOnly: o.readOnly };
  // agy has no system-prompt flag, so its playbook goes in front of the first prompt (only when there is one).
  const playbook = o.tool === "shell" ? "" : playbookNote(project?.id);
  const prompt = o.tool === "agy" && playbook && o.prompt?.trim() ? `${playbook}\n\n${o.prompt.trim()}` : o.prompt?.trim();
  const argv = o.argv ?? withHooks(o.tool, tool.argv({ ...launch, prompt: prompt || undefined }), id, o.instructions ? "" : playbook, o.instructions, hookOpts(project?.id, account));
  const title =
    o.title?.trim() ||
    (o.prompt?.trim() ? o.prompt.trim().split("\n")[0]!.slice(0, 60) : `${tool.label}${project ? " · " + project.name : ""}`);

  await ensureServer();
  const r = await tmux(["new-session", "-d", "-s", tmuxName, "-x", "160", "-y", "48", "-c", cwd, ...sessionEnv(id, account, cwd), "--", ...argv]);
  if (r.code !== 0) {
    dropSessionKey(id);
    throw new Error(`tmux: ${r.err || "failed to start session"}`);
  }

  db.query(
    `INSERT INTO sessions (id, project_id, task_id, account_id, tool, title, cwd, argv, tmux_name, status, created_at, auto, msg_cursor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, (SELECT COALESCE(MAX(id), 0) FROM messages))`,
  ).run(id, project?.id ?? null, o.taskId ?? null, account?.id ?? null, tool.id, title, cwd, JSON.stringify(argv), tmuxName, now(), o.auto ? 1 : 0);
  o.onCreated?.(id);
  if (project) touchProject(project.id);
  await reconcile();
  refreshAccountsSoon();
  return sessionView(getSession(id)!);
}

// Within this, the agent's prompt cache is still warm: resuming its conversation is cheap.
// Past it, resuming re-writes the whole context at full price, so a fresh start is better.
export const WARM_MS = 55 * 60_000;

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
  if (db.query("SELECT 1 FROM sessions WHERE id = ? AND title LIKE 'Review · %'").get(id) || db.query("SELECT 1 FROM task_reviews WHERE session_id = ?").get(id)) throw conflict("retry this independent review from the task sheet");
  const argv = JSON.parse(s.argv) as string[];
  // A restarted agent shouldn't replay the original prompt (or a login flow), but keeps its model and effort.
  const tool = TOOLS[s.tool];
  const keep = { yolo: argv.some((a) => a.startsWith("--dangerously")), ...relaunchChoice(argv, s) };
  // Pick the conversation back up while its cache is warm (claude --resume <id>, codex resume <id>).
  const conv = resumableConversation(s);
  const fresh = tool.argv(keep);
  const launch = !conv ? fresh : s.tool === "claude" ? [...fresh, "--resume", conv] : [fresh[0]!, "resume", conv, ...fresh.slice(1)];
  const account = s.account_id ? getAccount(s.account_id) : null;
  const base = s.tool === "shell" ? argv : withHooks(s.tool, launch, s.id, playbookNote(s.project_id), undefined, hookOpts(s.project_id, account));
  // An agent started before keys existed has none; if it can't be restarted it must stay believed without one.
  const keyed = hasSessionKey(s.id);
  const failed = (err: string) => {
    if (!keyed) dropSessionKey(s.id);
    return new Error(`tmux: ${err}`);
  };
  const env = sessionEnv(s.id, account, s.cwd); // also prepares the profile, which a respawn needs too
  const alive = (await tmux(["has-session", "-t", s.tmux_name])).code === 0;
  if (alive) {
    // A respawned pane gets the environment its tmux session was made with, which has no key for those older agents.
    const r = await tmux(["respawn-pane", "-k", "-t", s.tmux_name, "-c", s.cwd, "-e", `${KEY_ENV}=${sessionKey(s.id)}`, "--", ...base]);
    if (r.code !== 0) throw failed(r.err);
  } else {
    await ensureServer();
    const r = await tmux(["new-session", "-d", "-s", s.tmux_name, "-x", "160", "-y", "48", "-c", s.cwd, ...env, "--", ...base]);
    if (r.code !== 0) throw failed(r.err);
  }
  db.query("UPDATE sessions SET argv = ?, agent_state = NULL WHERE id = ?").run(JSON.stringify(base), id);
  db.query("UPDATE sessions SET status = 'running', exit_code = NULL, ended_at = NULL WHERE id = ?").run(id);
  await reconcile();
  return sessionView(getSession(id)!);
}

export async function closeSession(id: string) {
  const s = getSession(id);
  if (!s) throw notFound("no such session");
  await tmux(["kill-session", "-t", s.tmux_name]);
  db.query("UPDATE sessions SET status = 'closed', ended_at = COALESCE(ended_at, ?) WHERE id = ?").run(now(), id);
  if (s.status === "running") onExited(id, null, "closed"); // closing an already-exited session changes nothing
  live.delete(s.tmux_name);
  await dropAttachments(id); // the files you attached were for this agent only
  await reconcile();
}

export async function renameSession(id: string, title: string) {
  db.query("UPDATE sessions SET title = ? WHERE id = ?").run(title.slice(0, 120), id);
}

// --------------------------------------------------------------- interaction

// tmux has lost the session (killed, or its server died); the row catches up on the next reconcile.
const PANE_GONE = /can't find (session|pane|window)|no server running|error connecting/i;

/** The error for a failed tmux command on a session's pane: 409 when tmux has lost the pane, else a server fault. */
export function paneError(err: string): Error {
  return PANE_GONE.test(err) ? conflict("this session isn't running; restart it") : new Error(`tmux: ${err}`);
}

/** Readable after the agent exits too (remain-on-exit keeps the pane); 409 once tmux has lost it. */
export async function captureHistory(id: string, lines = 3000): Promise<string> {
  const s = getSession(id);
  if (!s) throw notFound("no such session");
  const r = await tmux(["capture-pane", "-p", "-J", "-S", `-${lines}`, "-t", s.tmux_name]);
  if (r.code !== 0) throw paneError(r.err);
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

/** What is being typed into each session right now; the next text waits for it. */
const typing = new Map<string, Promise<void>>();
let pasteSeq = 0;

/**
 * Paste text as a bracketed paste (so multi-line prompts don't submit early), then optionally press Enter.
 * One at a time per session: a team message, a shift's next prompt and your own text can all
 * be sent in the same moment, and two pastes running together used to overwrite each other
 * (one text typed twice or not at all) or press Enter between the other's paste and its Enter.
 */
export function sendText(id: string, text: string, enter = true): Promise<void> {
  const run = (typing.get(id) ?? Promise.resolve()).then(() => typeText(id, text, enter));
  const settled = run.catch(() => {});
  typing.set(id, settled);
  void settled.then(() => {
    if (typing.get(id) === settled) typing.delete(id);
  });
  return run;
}

async function typeText(id: string, text: string, enter: boolean) {
  const s = liveSession(id);
  const t = s.tmux_name;
  const inMode = (await tmux(["display", "-p", "-t", t, "#{pane_in_mode}"])).out.trim() === "1";
  if (inMode) await tmux(["send-keys", "-t", t, "-X", "cancel"]);
  if (text) {
    const buf = `ansai-${s.id}-${++pasteSeq}`; // its own buffer, so nothing else can replace it before the paste
    // The row lags tmux by up to a reconcile tick, so a just-killed pane fails here: 409, not 500.
    let r = await tmux(["load-buffer", "-b", buf, "-"], text);
    if (r.code !== 0) throw paneError(r.err);
    r = await tmux(["paste-buffer", "-p", "-d", "-b", buf, "-t", t]);
    if (r.code !== 0) {
      await tmux(["delete-buffer", "-b", buf]); // -d only deletes it after a paste that worked
      throw paneError(r.err);
    }
  }
  if (enter) {
    if (text) await Bun.sleep(120); // let TUIs finish ingesting the paste
    const r = await tmux(["send-keys", "-t", t, "Enter"]);
    if (r.code !== 0) throw paneError(r.err);
    if (s.tool === "codex" && text.trim() && !text.trimStart().startsWith("/")) codexPrompted(s.id);
  }
}

/**
 * Codex only says when a turn ends, so a prompt typed in through ansai (yours, a team
 * message, a shift's next prompt) is what marks it "working". Before, it stayed "idle"
 * through such turns, and only its moving screen kept ansai from typing into it again.
 */
function codexPrompted(id: string) {
  const r = db
    .query("UPDATE sessions SET agent_state = 'working', agent_state_at = ?, agent_message = NULL WHERE id = ? AND status = 'running' AND (agent_state IS NULL OR agent_state = 'waiting')")
    .run(Date.now(), id);
  if (r.changes) emit("sessions");
}

const NAMED_KEYS = new Set(["Enter", "Escape", "Tab", "BTab", "Up", "Down", "Left", "Right", "C-c", "Space", "BSpace"]);

/** Press keys in the agent's terminal without a terminal open (chat view answers prompts this way). */
export async function sendKeys(id: string, keys: string[]) {
  const s = liveSession(id);
  for (const k of keys.slice(0, 20)) {
    let r;
    if (NAMED_KEYS.has(k)) r = await tmux(["send-keys", "-t", s.tmux_name, k]);
    else if (/^[ -~]{1,8}$/.test(k)) r = await tmux(["send-keys", "-t", s.tmux_name, "-l", k]);
    else throw badRequest(`unsupported key: ${k}`);
    if (r.code !== 0) throw paneError(r.err);
  }
}

const CODEX_ASK = /Would you like to (run the following command|make the following edits|grant these permissions|send input to the existing terminal)/;

/** Codex shows approvals only on screen; read the visible pane of running Codex sessions. */
export async function watchCodexScreens(at = Date.now()) {
  const rows = db.query("SELECT id, tmux_name, agent_state, agent_state_at FROM sessions WHERE tool = 'codex' AND status = 'running'").all() as Pick<
    SessionRow,
    "id" | "tmux_name" | "agent_state" | "agent_state_at"
  >[];
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
    if (!prompt && r.agent_state === "working") codexStopped(r, cap.out, at);
  }
}

/**
 * Codex says when a turn ends, but not when you interrupt one (Esc), and a turn's end can be
 * missed while ansai restarts: it would say "working" for good. A working Codex redraws its
 * timer every second and shows "esc to interrupt", so one whose screen has been still for
 * 10 s, with its input box showing and no such hint, has stopped.
 */
function codexStopped(r: Pick<SessionRow, "id" | "tmux_name" | "agent_state_at">, screen: string, at: number) {
  const l = live.get(r.tmux_name);
  if (!l || at - l.activity < CODEX_QUIET_MS || at - (r.agent_state_at ?? at) < CODEX_QUIET_MS) return;
  if (/esc to interrup[t]/i.test(screen) || !atPrompt("codex", screen)) return;
  const lines = screen.split("\n").map((x) => x.trimEnd());
  const box = lines.findLastIndex((x) => x === "›" || x.startsWith("› "));
  // The last thing Codex wrote above its box is its own note that you stopped it (as Claude's log says for Claude).
  const interrupted = /^■ Conversation interrupte[d]/.test(lines.slice(0, box).findLast((x) => /^[•■›]/.test(x)) ?? "");
  const u = db
    .query("UPDATE sessions SET agent_state = 'waiting', agent_state_at = ?, agent_message = ? WHERE id = ? AND agent_state = 'working'")
    .run(Date.now(), interrupted ? "Interrupted" : null, r.id);
  if (u.changes) emit("sessions");
}
const CODEX_QUIET_MS = 10_000;

/** What Antigravity's screen says about its turn. */
export type AgySaw =
  | { state: "working" }
  | { state: "idle"; interrupted: boolean }
  /** `approval`: its own "Requesting permission" question, where Enter allows and Esc refuses. */
  | { state: "ask"; prompt: string; approval: boolean }
  | { state: "unknown" };

/**
 * Read an Antigravity CLI screen (checked against 1.5.9, 38 to 100 columns wide):
 * - Its input box is a "> " line between two rules at the bottom, with one footer line under
 *   it. While a turn runs the footer starts with "esc to cancel"; at rest it doesn't. The
 *   spinner can sit still for many seconds mid-turn, so a quiet screen says nothing.
 * - A question replaces the box with a numbered menu ("> 1. Yes, run command"), and the
 *   footer still says "esc to cancel".
 * Your earlier prompts are shown as "> text" under a rule too, so only a box with nothing
 * but its footer below it counts.
 */
export function agyScreen(screen: string): AgySaw {
  const lines = screen.split("\n").map((l) => l.trimEnd());
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  const rules = lines.flatMap((l, i) => (/^─{20,}$/.test(l) ? [i] : []));
  const [top, bottom] = rules.length >= 2 ? (rules.slice(-2) as [number, number]) : [-1, -1];
  const below = lines.length - 1 - bottom; // a footer with nothing to say is a blank line, dropped above
  const box = top >= 0 && /^>(\s|$)/.test(lines[top + 1] ?? "") && below <= 2;
  const cancel = lines.slice(-2).some((l) => /^\s*esc to cancel\b/.test(l));
  if (box) {
    if (cancel) return { state: "working" };
    const above = lines.slice(0, top).findLast((l) => l.trim()) ?? "";
    return { state: "idle", interrupted: /^\s*⎿\s+Interrupted\b/.test(above) };
  }
  const ask = lines.findLastIndex((l) => /^Requesting permission for:/.test(l));
  if (ask >= 0 && lines.slice(ask).some((l) => /^>\s*\d+\.\s/.test(l))) {
    const after = lines.slice(ask + 1).map((l) => l.trim()).filter(Boolean);
    const question = after.find((l) => l.endsWith("?")) ?? "Antigravity asks for permission.";
    const detail = after[0] && after[0] !== question ? after[0] : "";
    return { state: "ask", prompt: `${question} ${detail}`.trim().slice(0, 200), approval: true };
  }
  if (cancel && lines.slice(-4).some((l) => /↑\/↓ Navigate/.test(l))) return { state: "ask", prompt: "Antigravity is asking you something.", approval: false };
  return { state: "unknown" };
}

/** How long agy's box must show no turn before the turn counts as over (a screen caught mid-redraw). */
const AGY_SETTLE_MS = 3000;
/** The same for an agy that ansai never saw working: it may not have started on its first prompt yet. */
const AGY_MISSED_MS = 10_000;
const agyIdleSince = new Map<string, number>();

/**
 * agy has no hooks and no MCP, so it never said anything: its session had no state, and
 * a task it was given stayed in Doing for good, holding an autopilot slot. Its screen
 * says enough: working, asking for permission, or back at its prompt (the turn is over).
 */
export async function watchAgyScreens(at = Date.now()) {
  const rows = db.query("SELECT id, tmux_name, agent_state, argv FROM sessions WHERE tool = 'agy' AND status = 'running'").all() as Pick<
    SessionRow,
    "id" | "tmux_name" | "agent_state" | "argv"
  >[];
  for (const id of agyIdleSince.keys()) if (!rows.some((r) => r.id === id)) agyIdleSince.delete(id);
  for (const r of rows) {
    if (startup.has(r.id)) continue; // the trust or sign-in screen; watchStartupScreens owns it
    const cap = await tmux(["capture-pane", "-p", "-t", r.tmux_name]);
    if (cap.code !== 0 || startupDialog("agy", cap.out)) continue;
    const saw = agyScreen(cap.out);
    if (saw.state !== "idle") agyIdleSince.delete(r.id);
    if (saw.state === "unknown") continue;
    // A menu you opened yourself (no turn was running) isn't the agent asking.
    if (saw.state === "ask" && !saw.approval && r.agent_state !== "working" && r.agent_state !== "needs-input") continue;
    if (saw.state !== "idle" || r.agent_state === "waiting") {
      agySaw(r.id, saw);
      continue;
    }
    // Started on a prompt (-i) and at rest with no state: its whole turn went by unseen (ansai was down).
    const missed = r.agent_state === null && launchedWithPrompt(r.argv);
    if (r.agent_state === null && !missed) {
      agySaw(r.id, saw); // opened without a prompt: it waits for you
      continue;
    }
    const since = agyIdleSince.get(r.id) ?? at;
    agyIdleSince.set(r.id, since);
    if (at - since < (missed ? AGY_MISSED_MS : AGY_SETTLE_MS)) continue;
    agyIdleSince.delete(r.id);
    agySaw(r.id, saw, missed);
  }
}

function launchedWithPrompt(argv: string): boolean {
  try {
    return (JSON.parse(argv) as string[]).includes("-i");
  } catch {
    return false;
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
    .query(
      // Sessions with an entry are checked whatever their state, so a dialog that went away is forgotten promptly.
      // So is agy: no hook ever takes over from this watcher, and it can ask you to sign in again later.
      `SELECT id, tool, account_id, tmux_name, cwd, agent_state FROM sessions WHERE tool IN ('claude', 'codex', 'agy') AND status = 'running'
         AND (agent_state IS NULL OR agent_state = 'needs-input' OR tool = 'agy' OR id IN (SELECT value FROM json_each(?)))`,
    )
    .all(JSON.stringify([...startup.keys()])) as Pick<SessionRow, "id" | "tool" | "account_id" | "tmux_name" | "cwd" | "agent_state">[];
  for (const r of rows) {
    const cap = await tmux(["capture-pane", "-p", "-J", "-t", r.tmux_name]);
    if (cap.code !== 0) continue;
    let d = startupDialog(r.tool, cap.out);
    const prev = startup.get(r.id);
    if (d?.kind === "login" && r.tool === "agy" && prev?.kind !== "login") {
      noteAgySignedOut(r.account_id ?? ""); // Accounts and autopilot see it right away
      refreshAccountsSoon();
      // A locked keyring looks the same as signed out; say which it is.
      if (await checkKeyring()) d = { ...d, message: `agy can't read its sign-in. ${agySignInHint()} Then restart this session.` };
    }
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
      if (prev.kind !== "trust-auto") startupScreen(r.id, null, prev.message);
    }
  }
}

/** Claude's input box at the bottom of its screen: what is typed in it, and how many lines (its footer) sit under it. */
function claudeBox(screen: string): { text: string; below: number } | null {
  const lines = screen.split("\n").map((l) => l.trimEnd());
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  const rules = lines.flatMap((l, i) => (/^─{20,}$/.test(l.trim()) ? [i] : []));
  if (rules.length < 2) return null;
  const [top, bottom] = rules.slice(-2) as [number, number];
  // The box is: rule, "❯ text", wrapped lines, rule. Claude puts a no-break space after ❯.
  const first = lines[top + 1] ?? "";
  if (!first.startsWith("❯")) return null;
  return { text: first.slice(1).trim(), below: lines.length - 1 - bottom };
}

/**
 * Esc while Claude is still thinking makes it rewind: your prompt goes back into its
 * input box, nothing is logged (so the log's "[Request interrupted…]" check can't see
 * it), and no hook fires, so the session would say "working" forever. On screen it's
 * Claude's idle input box, with text in it, at the bottom, and no "esc to interrupt"
 * (Claude shows that exactly while a turn runs).
 */
export function claudeRewound(screen: string): boolean {
  if (/esc to interrup[t]/i.test(screen)) return false;
  const box = claudeBox(screen);
  return !!box && !!box.text && box.below <= 3; // the box with at most its footer under it
}

/**
 * Is the agent's own input box on its screen, so text followed by Enter becomes a prompt?
 * When a menu is up instead (a model picker, a usage-limit choice, a trust or approval
 * question), the box is gone, the text is thrown away and Enter picks whatever row is
 * focused. Checked against Claude Code 2.1 and Codex 0.169 screens:
 * - Claude draws its box between two rules at the bottom, with a short footer under it;
 *   every menu replaces the box.
 * - Codex's box is a "› " line near the bottom with its status lines under it. A menu's
 *   focused row is "› 1. …" and its last line says "enter … esc …".
 * - Antigravity: see agyScreen.
 * Other tools have no known screen, so nothing is held for them.
 */
export function atPrompt(tool: ToolId, screen: string): boolean {
  if (tool === "claude") {
    const box = claudeBox(screen);
    return !!box && box.below <= 5;
  }
  if (tool === "agy") {
    const saw = agyScreen(screen).state;
    return saw === "working" || saw === "idle";
  }
  if (tool !== "codex") return true;
  if (CODEX_ASK.test(screen)) return false;
  const lines = screen.split("\n").map((l) => l.trimEnd());
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  const i = lines.findLastIndex((l) => l === "›" || l.startsWith("› "));
  if (i < 0 || lines.length - 1 - i > 10) return false; // its status lines wrap on a narrow screen
  if (/^›\s+\d+\.\s/.test(lines[i]!)) return false;
  return !lines.slice(-3).some((l) => /\benter\b.*\besc\b/i.test(l));
}

/** Read the agent's screen and say whether its input box is showing (false when the pane can't be read). */
export async function promptShowing(s: Pick<SessionRow, "tool" | "tmux_name">): Promise<boolean> {
  if (s.tool !== "claude" && s.tool !== "codex" && s.tool !== "agy") return true;
  const cap = await tmux(["capture-pane", "-p", "-t", s.tmux_name]);
  return cap.code === 0 && atPrompt(s.tool, cap.out);
}

const offPrompt = new Set<string>();
/**
 * For text ansai types by itself (a team message, a shift's next prompt): is this agent's
 * input box showing right now? When it isn't, the text is held and tried again later;
 * the log says so once, until the box is back.
 */
export async function readyToType(s: Pick<SessionRow, "id" | "tool" | "tmux_name">): Promise<boolean> {
  if (await promptShowing(s)) {
    offPrompt.delete(s.id);
    return true;
  }
  if (!offPrompt.has(s.id)) {
    offPrompt.add(s.id);
    console.warn(`[ansai] not typing into ${s.id}: its input box isn't on screen (a menu or a question is). Trying again when it is.`);
  }
  return false;
}

/**
 * Type a prompt once the agent's input box is showing, waiting a little for it
 * (a screen is still being redrawn right after a turn ends). 409 if it never shows.
 */
export async function sendAtPrompt(id: string, text: string, waitMs = 10_000): Promise<void> {
  for (const end = Date.now() + waitMs; ; ) {
    if (await promptShowing(liveSession(id))) return sendText(id, text, true);
    if (Date.now() >= end) throw conflict("the agent's input box isn't on its screen (a menu or a question is), so nothing was typed");
    await Bun.sleep(Math.min(500, waitMs));
  }
}

const QUIET_MS = 8000;

/** A Claude "working" for 8 s+ with no output since, showing a rewound prompt: it's waiting for you. */
async function watchRewinds(at = Date.now()) {
  const rows = db
    .query("SELECT id, tmux_name, agent_state_at FROM sessions WHERE tool = 'claude' AND status = 'running' AND agent_state = 'working'")
    .all() as Pick<SessionRow, "id" | "tmux_name" | "agent_state_at">[];
  for (const r of rows) {
    const l = live.get(r.tmux_name);
    // The spinner redraws while Claude works, so any output in the last 8 s means it may be.
    if (!l || at - l.activity < QUIET_MS || at - (r.agent_state_at ?? at) < QUIET_MS) continue;
    const cap = await tmux(["capture-pane", "-p", "-t", r.tmux_name]);
    if (cap.code !== 0 || !claudeRewound(cap.out)) continue;
    const u = db
      .query("UPDATE sessions SET agent_state = 'waiting', agent_state_at = ?, agent_message = 'Interrupted' WHERE id = ? AND agent_state = 'working'")
      .run(Date.now(), r.id);
    if (u.changes) emit("sessions");
  }
}

// ---------------------------------------------------------------- reconcile

let lastStatusSig = "";
let lastActivitySig = "";

const PANE_FORMAT = "#{session_name}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_current_command}\t#{window_activity}\t#{session_attached}";

export type Pane = { dead: boolean; code: number | null } & Live;

/** ansai's panes in `tmux list-panes -a -F PANE_FORMAT` output, by tmux session name. */
export function parsePanes(out: string): Map<string, Pane> {
  const panes = new Map<string, Pane>();
  for (const line of out.split("\n")) {
    if (!line.startsWith("ansai-")) continue;
    const [name, dead, code, cmd, act, att] = line.split("\t");
    panes.set(name!, { dead: dead === "1", code: code ? Number(code) : null, activity: Number(act) * 1000, command: cmd ?? "", attached: Number(att) || 0 });
  }
  return panes;
}

/** Sync DB status with what tmux actually has. Returns true if anything changed. */
export async function reconcile(): Promise<boolean> {
  const r = await tmux(["list-panes", "-a", "-F", PANE_FORMAT]);
  if (r.code === 0) {
    listFailures = 0;
    return applyPanes(parsePanes(r.out));
  }
  if (/no server running|error connecting|server exited|lost server/i.test(r.err)) {
    serverChecked = false; // start it scoped again next time
    listFailures = 0;
    return applyPanes(new Map()); // tmux itself is gone, and every agent with it
  }
  // tmux couldn't answer this once (out of processes or memory, killed mid-call). That says
  // nothing about the agents: taking it as "no panes" marked every session exited, re-queued
  // its autopilot task and ended its shift, while the agents were still running. Look again
  // next tick; only a failure that keeps coming back is believed.
  if (++listFailures < LIST_FAILURES_BELIEVED) {
    if (listFailures === 1) console.warn(`[ansai] tmux couldn't list its sessions (will look again): ${r.err || `exit ${r.code}`}`);
    return false;
  }
  return applyPanes(new Map());
}
let listFailures = 0;
const LIST_FAILURES_BELIEVED = 5;

/** reconcile() once tmux has answered: each open row follows its pane (tests hand it panes directly). */
export function applyPanes(seen: Map<string, Pane>): boolean {
  for (const [name, p] of seen) live.set(name, { activity: p.activity, command: p.command, attached: p.attached });
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
      .then(() => watchCodexScreens())
      .then(watchStartupScreens)
      .then(() => watchAgyScreens())
      .then(() => watchRewinds())
      .catch((e) => console.error("reconcile:", e))
      .finally(() => setTimeout(tick, ms));
  tick();
}
