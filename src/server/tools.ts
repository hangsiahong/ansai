import { config } from "./config";

export type ToolId = "claude" | "codex" | "agy" | "shell";

export type LaunchOpts = {
  prompt?: string;
  yolo?: boolean;
  /** Model alias or id to start with; unset = the agent's own default. */
  model?: string;
  /** Reasoning effort to start with; unset = the agent's own default. */
  effort?: string;
};

type ToolDef = {
  id: ToolId;
  label: string;
  bin: string;
  argv: (o: LaunchOpts) => string[];
};

/** Every reasoning level any of the CLIs takes (Codex adds "ultra" on some models). */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Model ids/aliases go straight into argv, so they must not look like a flag. */
export const isModelId = (m: string) => /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,99}$/.test(m);

const modelFlags = (flag: string, o: LaunchOpts) => (o.model ? [flag, o.model] : []);

export const TOOLS: Record<ToolId, ToolDef> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    argv: (o) => [
      "claude",
      ...(o.yolo ? ["--dangerously-skip-permissions"] : []),
      ...modelFlags("--model", o),
      ...(o.effort ? ["--effort", o.effort] : []),
      ...(o.prompt ? [o.prompt] : []),
    ],
  },
  codex: {
    id: "codex",
    label: "Codex",
    bin: "codex",
    argv: (o) => [
      "codex",
      ...(o.yolo ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
      ...modelFlags("-m", o),
      ...(o.effort ? ["-c", `model_reasoning_effort="${o.effort}"`] : []),
      ...(o.prompt ? [o.prompt] : []),
    ],
  },
  agy: {
    id: "agy",
    label: "Antigravity",
    bin: "agy",
    argv: (o) => [
      "agy",
      ...(o.yolo ? ["--dangerously-skip-permissions"] : []),
      ...modelFlags("--model", o),
      ...(o.effort ? ["--effort", o.effort] : []),
      ...(o.prompt ? ["-i", o.prompt] : []),
    ],
  },
  shell: {
    id: "shell",
    label: "Shell",
    bin: config.shell,
    argv: () => [config.shell, "-l"],
  },
};

/** The model and effort a session was launched with, read back from its argv (so a restart keeps them). */
export function launchChoice(argv: string[]): { model?: string; effort?: string } {
  const out: { model?: string; effort?: string } = {};
  for (let i = 1; i < argv.length - 1; i++) {
    const a = argv[i]!;
    const next = argv[i + 1]!;
    if ((a === "--model" || a === "-m") && isModelId(next)) out.model = next;
    else if (a === "--effort" && (EFFORTS as readonly string[]).includes(next)) out.effort = next;
    else if (a === "-c") {
      const m = next.match(/^model_reasoning_effort="?([a-z]+)"?$/);
      if (m && (EFFORTS as readonly string[]).includes(m[1]!)) out.effort = m[1];
    }
  }
  return out;
}

/**
 * What a restarted (or resumed) agent should run on: what it was last running,
 * so a live /model or /effort switch survives, else what it was launched with.
 * Right after /model, Claude's log names the model ("Haiku 5.5"), not its id;
 * the family alias stands in until the next reply gives the id.
 */
export function relaunchChoice(argv: string[], last: { model: string | null; effort: string | null }): { model?: string; effort?: string } {
  const out = launchChoice(argv);
  const model = last.model && isModelId(last.model) ? last.model : last.model?.match(/^(fable|opus|sonnet|haiku)\b/i)?.[1]?.toLowerCase();
  if (model) out.model = model;
  if (last.effort && (EFFORTS as readonly string[]).includes(last.effort)) out.effort = last.effort;
  return out;
}

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
