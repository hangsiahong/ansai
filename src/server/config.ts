import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";

const home = homedir();

function loginShell(): string {
  try {
    const me = userInfo().username;
    const line = readFileSync("/etc/passwd", "utf8")
      .split("\n")
      .find((l) => l.startsWith(me + ":"));
    const sh = line?.split(":")[6]?.trim();
    if (sh) return sh;
  } catch {}
  return process.env.SHELL || "/bin/bash";
}

const dataDir = process.env.ANSAI_HOME || join(home, ".ansai");
mkdirSync(dataDir, { recursive: true });

export const config = {
  home,
  dataDir,
  dbPath: join(dataDir, "ansai.db"),
  tmuxConf: join(dataDir, "tmux.conf"),
  tmuxSocket: process.env.ANSAI_TMUX_SOCKET || "ansai",
  port: Number(process.env.ANSAI_PORT || 7777),
  // Loopback only. Remote access goes through `tailscale serve`, never a public bind.
  hostname: "127.0.0.1",
  dev: !!process.env.ANSAI_DEV,
  shell: loginShell(),
  projectRoots: (process.env.ANSAI_ROOTS || join(home, "projects"))
    .split(":")
    .filter(Boolean),
  scanDepth: Number(process.env.ANSAI_SCAN_DEPTH || 4),
  // Extra Tailscale logins allowed besides the machine owner (comma separated).
  extraLogins: (process.env.ANSAI_ALLOWED_LOGINS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  extraHosts: (process.env.ANSAI_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
};

/**
 * Env vars that belong to whatever session launched ansai (e.g. a Claude Code
 * session) and must not leak into the agents we spawn.
 */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (
      k === "CLAUDECODE" ||
      k.startsWith("CLAUDE_CODE_") ||
      k === "CLAUDE_PID" ||
      k === "CLAUDE_EFFORT" ||
      k.startsWith("TERM_PROGRAM") ||
      k === "TMUX" ||
      k === "TMUX_PANE" ||
      k.startsWith("ANSAI_") ||
      k.startsWith("BUN_") ||
      k === "NODE_ENV"
    )
      continue;
    env[k] = v;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return { ...env, ...extra };
}
