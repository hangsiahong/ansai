import { spawn } from "node:child_process";
import { db, getSetting, now, setSetting } from "./db";
import { emit } from "./events";

export type CheckResult = { ok: boolean; cmd: string; code: number | null; ms: number; at: number; tail: string; timedOut?: boolean };
export type ChecksState = CheckResult | { running: true; cmd: string; at: number };

export const CHECKS_TIMEOUT_MS = 10 * 60_000;
const TAIL_LINES = 80;
const TAIL_CHARS = 6000;

export const getChecks = (projectId: string) => getSetting<string>(`checks:${projectId}`, "");
export function setChecks(projectId: string, cmd: string) {
  const v = cmd.trim().slice(0, 2000);
  setSetting(`checks:${projectId}`, v);
  emit("projects");
  return v;
}

export function tailOf(out: string, lines = TAIL_LINES, chars = TAIL_CHARS): string {
  const t = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd().split("\n").slice(-lines).join("\n");
  return t.length > chars ? `…${t.slice(-chars)}` : t;
}

// The service's own ANSAI_* (home, port, tmux socket, session key) must not reach a project's tests.
function checkEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" };
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("ANSAI_") && !(k in env)) env[k] = v;
  return env;
}

export function runCommand(cwd: string, cmd: string, timeoutMs = CHECKS_TIMEOUT_MS): Promise<CheckResult> {
  const at = now();
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    const child = spawn("bash", ["-c", cmd], { cwd, env: checkEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const keep = (b: Buffer) => {
      out += b.toString();
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const killGroup = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    const done = (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) out += `\n[ansai] stopped after ${Math.round(timeoutMs / 1000)}s`;
      resolve({ ok: !timedOut && code === 0, cmd, code, ms: now() - at, at, tail: tailOf(out), ...(timedOut ? { timedOut } : {}) });
    };
    child.on("error", (e) => {
      out += `\n${e.message}`;
      done(null);
    });
    child.on("close", done);
  });
}

// One run at a time: several agents finishing together would otherwise run every test suite at once.
let queue: Promise<unknown> = Promise.resolve();
const running = new Set<string>();

export const checksRunning = (taskId: string) => running.has(taskId);

export async function runTaskChecks(taskId: string, cwd: string, cmd: string, timeoutMs = CHECKS_TIMEOUT_MS): Promise<CheckResult> {
  running.add(taskId);
  saveChecks(taskId, { running: true, cmd, at: now() });
  const result = queue.then(() => runCommand(cwd, cmd, timeoutMs));
  queue = result.catch(() => {});
  try {
    const r = await result;
    saveChecks(taskId, r);
    return r;
  } finally {
    running.delete(taskId);
  }
}

function saveChecks(taskId: string, state: ChecksState) {
  db.query("UPDATE tasks SET checks = ? WHERE id = ?").run(JSON.stringify(state), taskId);
  emit("tasks");
}

export function parseChecks(raw: string | null): ChecksState | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ChecksState;
  } catch {
    return null;
  }
}
