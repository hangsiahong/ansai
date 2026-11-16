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
