import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, cleanEnv } from "./config";
import { accountEnv, getAccount, resolveAccount, type AccountRow, type AgentTool } from "./accounts";
import { badRequest, conflict, notFound } from "./errors";
import { getSession, sendText } from "./sessions";

/**
 * What each agent can be started with: its models and reasoning levels, plus
 * what it uses when you don't pick (so "Default" can say what that means).
 * Claude takes aliases that always point at the newest model; Codex lists its
 * models in a cache file; agy prints them with `agy models`.
 */

export type ModelOption = { id: string; label: string; efforts?: string[] };
export type ModelChoices = {
  models: ModelOption[];
  /** Reasoning levels for models that don't list their own. */
  efforts: string[];
  /** What the agent runs on when nothing is picked (from its own config), if known. */
  default: { model: string | null; effort: string | null };
  /** True when the agent can switch model mid-conversation with `/model <id>` and `/effort <level>`. */
  liveSwitch: boolean;
};

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const CLAUDE_MODELS: ModelOption[] = [
  { id: "fable", label: "Fable" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function claudeChoices(a: AccountRow | null): ModelChoices {
  const s = readJson(join(a?.dir ?? join(config.home, ".claude"), "settings.json")) ?? {};
  return {
    models: CLAUDE_MODELS,
    efforts: CLAUDE_EFFORTS,
    default: { model: typeof s.model === "string" ? s.model : null, effort: typeof s.effortLevel === "string" ? s.effortLevel : null },
    liveSwitch: true,
  };
}

function codexChoices(a: AccountRow | null): ModelChoices {
  const home = a?.dir ?? join(config.home, ".codex");
  // A fresh account profile has no cache until Codex runs there once; the main one lists the same models.
  const cache = [join(home, "models_cache.json"), join(config.home, ".codex", "models_cache.json")].find(existsSync);
  const list = (cache ? readJson(cache)?.models : null) ?? [];
  const models: ModelOption[] = (Array.isArray(list) ? list : [])
    .filter((m: any) => typeof m?.slug === "string" && m.visibility !== "hide")
    .map((m: any) => ({
      id: m.slug,
      label: typeof m.display_name === "string" ? m.display_name : m.slug,
      efforts: Array.isArray(m.supported_reasoning_levels)
        ? m.supported_reasoning_levels.map((l: any) => l?.effort).filter((e: unknown): e is string => typeof e === "string")
        : undefined,
    }));
  let toml = "";
  try {
    toml = readFileSync(join(home, "config.toml"), "utf8");
  } catch {}
  const top = toml.split(/^\s*\[/m)[0] ?? ""; // only top-level keys, not [profiles.x] ones
  const key = (k: string) => top.match(new RegExp(`^\\s*${k}\\s*=\\s*"([^"]+)"`, "m"))?.[1] ?? null;
  return {
    models,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    default: { model: key("model"), effort: key("model_reasoning_effort") },
    liveSwitch: false, // Codex's /model opens its own menu; it takes no argument
  };
}

const agyCache = new Map<string, { at: number; models: ModelOption[] }>();
const AGY_TTL = 10 * 60_000;

async function agyChoices(a: AccountRow | null): Promise<ModelChoices> {
  const key = a?.id ?? "";
  let hit = agyCache.get(key);
  if (!hit || Date.now() - hit.at > AGY_TTL) {
    const models: ModelOption[] = [];
    if (Bun.which("agy")) {
      const p = Bun.spawn(["agy", "models"], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...cleanEnv(), ...accountEnv(a, config.home) } });
      const timer = setTimeout(() => p.kill(), 20_000);
      const out = await new Response(p.stdout).text();
      clearTimeout(timer);
      for (const line of out.split("\n")) {
        const [id, label] = line.split("\t");
        if (id && label && /^[\w.:-]+$/.test(id.trim())) models.push({ id: id.trim(), label: label.trim() });
      }
    }
    hit = { at: models.length ? Date.now() : Date.now() - AGY_TTL + 30_000, models }; // retry a failed fetch sooner
    agyCache.set(key, hit);
  }
  return { models: hit.models, efforts: CLAUDE_EFFORTS, default: { model: null, effort: null }, liveSwitch: true };
}

export async function modelChoices(tool: AgentTool, accountId?: string | null): Promise<ModelChoices> {
  const a = resolveAccount(tool, accountId);
  if (tool === "claude") return claudeChoices(a);
  if (tool === "codex") return codexChoices(a);
  return agyChoices(a);
}

// ------------------------------------------------------------ live switch

/**
 * Where an agent saves a typed /model or /effort as the default for every new
 * session, and under which keys. agy folds the effort into the model name
 * ("Gemini 3.8 Flash (Low)"), so it only writes "model".
 */
function savedDefaults(tool: string, accountId: string | null): { path: string; keys: string[] } | null {
  const a = accountId ? getAccount(accountId) : null;
  if (tool === "claude") return { path: join(a?.dir ?? join(config.home, ".claude"), "settings.json"), keys: ["model", "effortLevel", "modelSettings"] };
  // Extra agy accounts run with HOME set to their profile folder.
  if (tool === "agy") return { path: join(a?.dir ?? config.home, ".gemini", "antigravity-cli", "settings.json"), keys: ["model"] };
  return null;
}

/** The saved-default keys as they are now; a missing file counts as none set. Null if unreadable. */
function readDefaults(path: string, keys: string[]): Record<string, unknown> | null {
  if (!existsSync(path)) return {};
  const j = readJson(path);
  if (!j || typeof j !== "object") return null;
  return Object.fromEntries(keys.map((k) => [k, j[k]]));
}

/**
 * A switch from ansai is meant for this session only, so once the agent has
 * written its defaults file, put those keys back as they were (the running
 * session keeps its switch; tested with Claude Code 2.1 and agy).
 */
async function keepDefaults(path: string, keys: string[], before: Record<string, unknown>) {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  let stable = 0;
  let changed = false;
  for (let i = 0; i < 20 && stable < 3; i++) {
    await Bun.sleep(250);
    const now = readDefaults(path, keys);
    const differs = !!now && keys.some((k) => !same(now[k], before[k]));
    if (differs) changed = true;
    stable = changed ? stable + 1 : 0; // wait for both commands' writes to land
  }
  if (!changed) return;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const j = JSON.parse(text);
  for (const k of keys) {
    if (before[k] === undefined) delete j[k];
    else j[k] = before[k];
  }
  writeFileSync(path, JSON.stringify(j, null, 2) + (text.endsWith("\n") ? "\n" : ""));
}

/**
 * Change a running agent's model or effort. Claude and agy take `/model <id>` and
 * `/effort <level>` as typed commands. Codex's /model takes no argument, so it only
 * opens Codex's own menu.
 */
export async function switchModel(id: string, o: { model?: string; effort?: string }): Promise<{ menu: boolean }> {
  const s = getSession(id);
  if (!s) throw notFound("no such session");
  if (s.status !== "running") throw conflict("this session isn't running; restart it first");
  if (s.tool === "shell") throw badRequest("a shell has no model");
  if (s.agent_state === "needs-input") throw conflict("the agent is waiting for an answer; reply to it first");
  if (s.tool === "codex") {
    await sendText(id, "/model");
    return { menu: true };
  }
  if (!o.model && !o.effort) throw badRequest("pick a model or an effort");
  // Mid-reply, a typed /model waits for the turn to end (/effort applies at once),
  // and by then ansai could no longer tell its write to your defaults apart from yours.
  if (o.model && s.agent_state === "working") throw conflict("the agent is mid-reply; switch the model once it's done");
  const saved = savedDefaults(s.tool, s.account_id);
  const before = saved ? readDefaults(saved.path, saved.keys) : null;
  if (o.model) await sendText(id, `/model ${o.model}`);
  if (o.effort) {
    if (o.model) await Bun.sleep(400); // let the first command finish before typing the next
    await sendText(id, `/effort ${o.effort}`);
  }
  if (saved && before) await keepDefaults(saved.path, saved.keys, before);
  return { menu: false };
}
