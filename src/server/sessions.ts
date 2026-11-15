import { writeFileSync, existsSync } from "node:fs";
import { config, cleanEnv } from "./config";
import { db, newId, now } from "./db";
import { TOOLS, type ToolId } from "./tools";
import { getProject, touchProject } from "./projects";
import { emit } from "./events";
import { accountEnv, getAccount, refreshAccountsSoon, resolveAccount, type AccountRow } from "./accounts";
import { codexScreen, onExited, withHooks } from "./hooks";

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
  auto: number;
  created_at: number;
  ended_at: number | null;
};

type Live = { activity: number; command: string; attached: number };
const live = new Map<string, Live>(); // keyed by tmux_name

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
  accountId?: string | null;
  taskId?: string | null;
  /** Internal: run this exact command instead of the tool's normal one (e.g. a login flow). */
  argv?: string[];
  /** Internal: started by autopilot from the queue. */
  auto?: boolean;
};

function sessionEnv(id: string, account: AccountRow | null): string[] {
  const env: Record<string, string> = { ANSAI_SESSION_ID: id, ...accountEnv(account) };
  return Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
}

export async function createSession(o: CreateOpts) {
  const tool = TOOLS[o.tool];
  const project = o.projectId ? getProject(o.projectId) : null;
  const cwd = project?.path ?? o.cwd ?? config.home;
  if (!existsSync(cwd)) throw new Error(`directory does not exist: ${cwd}`);
  if (!Bun.which(tool.bin)) throw new Error(`${tool.label} (${tool.bin}) is not installed`);

  const account = o.tool === "shell" ? null : resolveAccount(o.tool, o.accountId);
  const id = newId("s");
  const tmuxName = `ansai-${id}`;
  const argv = o.argv ?? withHooks(o.tool, tool.argv({ prompt: o.prompt?.trim() || undefined, yolo: o.yolo }), id);
  const title =
    o.title?.trim() ||
    (o.prompt?.trim() ? o.prompt.trim().split("\n")[0]!.slice(0, 60) : `${tool.label}${project ? " · " + project.name : ""}`);

  await ensureServer();
  const r = await tmux(["new-session", "-d", "-s", tmuxName, "-x", "160", "-y", "48", "-c", cwd, ...sessionEnv(id, account), "--", ...argv]);
  if (r.code !== 0) throw new Error(`tmux: ${r.err || "failed to start session"}`);

  db.query(
    `INSERT INTO sessions (id, project_id, task_id, account_id, tool, title, cwd, argv, tmux_name, status, created_at, auto)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
  ).run(id, project?.id ?? null, o.taskId ?? null, account?.id ?? null, tool.id, title, cwd, JSON.stringify(argv), tmuxName, now(), o.auto ? 1 : 0);
  if (project) touchProject(project.id);
  await reconcile();
  refreshAccountsSoon();
  return sessionView(getSession(id)!);
}

/** Re-run the same command in the same pane (after the agent exited, or to force a restart). */
export async function restartSession(id: string) {
  const s = getSession(id);
  if (!s) throw new Error("no such session");
  const argv = JSON.parse(s.argv) as string[];
  // A restarted agent shouldn't replay the original prompt (or a login flow).
  const tool = TOOLS[s.tool];
  const base = s.tool === "shell" ? argv : withHooks(s.tool, tool.argv({ yolo: argv.some((a) => a.startsWith("--dangerously")) }), s.id);
  const account = s.account_id ? getAccount(s.account_id) : null;
  const alive = (await tmux(["has-session", "-t", s.tmux_name])).code === 0;
  if (alive) {
    const r = await tmux(["respawn-pane", "-k", "-t", s.tmux_name, "-c", s.cwd, "--", ...base]);
    if (r.code !== 0) throw new Error(`tmux: ${r.err}`);
  } else {
    await ensureServer();
    const r = await tmux(["new-session", "-d", "-s", s.tmux_name, "-x", "160", "-y", "48", "-c", s.cwd, ...sessionEnv(s.id, account), "--", ...base]);
    if (r.code !== 0) throw new Error(`tmux: ${r.err}`);
  }
  db.query("UPDATE sessions SET argv = ?, agent_state = NULL WHERE id = ?").run(JSON.stringify(base), id);
  db.query("UPDATE sessions SET status = 'running', exit_code = NULL, ended_at = NULL WHERE id = ?").run(id);
  await reconcile();
  return sessionView(getSession(id)!);
}

export async function closeSession(id: string) {
  const s = getSession(id);
  if (!s) throw new Error("no such session");
  await tmux(["kill-session", "-t", s.tmux_name]);
  db.query("UPDATE sessions SET status = 'closed', ended_at = COALESCE(ended_at, ?) WHERE id = ?").run(now(), id);
  live.delete(s.tmux_name);
  await reconcile();
}

export async function renameSession(id: string, title: string) {
  db.query("UPDATE sessions SET title = ? WHERE id = ?").run(title.slice(0, 120), id);
}

// --------------------------------------------------------------- interaction

export async function captureHistory(id: string, lines = 3000): Promise<string> {
  const s = getSession(id);
  if (!s) throw new Error("no such session");
  const r = await tmux(["capture-pane", "-p", "-J", "-S", `-${lines}`, "-t", s.tmux_name]);
  if (r.code !== 0) throw new Error(`tmux: ${r.err}`);
  return r.out.replace(/\s+$/, "") + "\n";
}

export async function scroll(id: string, dir: "up" | "down" | "exit") {
  const s = getSession(id);
  if (!s) throw new Error("no such session");
  if (dir === "up") await tmux(["copy-mode", "-e", "-u", "-t", s.tmux_name]);
  else {
    const inMode = (await tmux(["display", "-p", "-t", s.tmux_name, "#{pane_in_mode}"])).out.trim() === "1";
    if (inMode) await tmux(["send-keys", "-t", s.tmux_name, "-X", dir === "down" ? "page-down" : "cancel"]);
  }
}

/** Paste text as a bracketed paste (so multi-line prompts don't submit early), then optionally press Enter. */
export async function sendText(id: string, text: string, enter = true) {
  const s = getSession(id);
  if (!s) throw new Error("no such session");
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
  const s = getSession(id);
  if (!s) throw new Error("no such session");
  for (const k of keys.slice(0, 20)) {
    if (NAMED_KEYS.has(k)) await tmux(["send-keys", "-t", s.tmux_name, k]);
    else if (/^[ -~]{1,8}$/.test(k)) await tmux(["send-keys", "-t", s.tmux_name, "-l", k]);
    else throw new Error(`unsupported key: ${k}`);
  }
}

const CODEX_ASK = /Would you like to (run the following command|make the following edits|grant these permissions|send input to the existing terminal)/;

/** Codex shows approvals only on screen; read the visible pane of running Codex sessions. */
async function watchCodexScreens() {
  const rows = db.query("SELECT id, tmux_name FROM sessions WHERE tool = 'codex' AND status = 'running'").all() as { id: string; tmux_name: string }[];
  for (const r of rows) {
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
      live.delete(s.tmux_name);
    } else if (t.dead && s.status === "running") {
      upd.run("exited", t.code, now(), s.id);
      onExited(s.id, t.code);
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
      .catch((e) => console.error("reconcile:", e))
      .finally(() => setTimeout(tick, ms));
  tick();
}
