import { config } from "./config";

export type ToolId = "claude" | "codex" | "agy" | "shell";

export type LaunchOpts = {
  prompt?: string;
  yolo?: boolean;
  /** Profile directory for a non-default account (phase 3). */
  accountDir?: string | null;
};

type ToolDef = {
  id: ToolId;
  label: string;
  bin: string;
  argv: (o: LaunchOpts) => string[];
  /** Env that points the CLI at a separate account/profile directory. */
  accountEnv: (dir: string) => Record<string, string>;
};

export const TOOLS: Record<ToolId, ToolDef> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    argv: (o) => ["claude", ...(o.yolo ? ["--dangerously-skip-permissions"] : []), ...(o.prompt ? [o.prompt] : [])],
    accountEnv: (dir) => ({ CLAUDE_CONFIG_DIR: dir }),
  },
  codex: {
    id: "codex",
    label: "Codex",
    bin: "codex",
    argv: (o) => [
      "codex",
      ...(o.yolo ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
      ...(o.prompt ? [o.prompt] : []),
    ],
    accountEnv: (dir) => ({ CODEX_HOME: dir }),
  },
  agy: {
    id: "agy",
    label: "Antigravity",
    bin: "agy",
    argv: (o) => ["agy", ...(o.yolo ? ["--dangerously-skip-permissions"] : []), ...(o.prompt ? ["-i", o.prompt] : [])],
    // agy keeps its state under ~/.gemini; a separate HOME isolates the profile.
    accountEnv: (dir) => ({ HOME: dir }),
  },
  shell: {
    id: "shell",
    label: "Shell",
    bin: config.shell,
    argv: () => [config.shell, "-l"],
    accountEnv: () => ({}),
  },
};

export function isTool(t: unknown): t is ToolId {
  return typeof t === "string" && t in TOOLS;
}

export function toolList() {
  return Object.values(TOOLS).map((t) => ({
    id: t.id,
    label: t.label,
    installed: !!Bun.which(t.bin),
  }));
}
