import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, cleanEnv } from "./config";
import { accountEnv, getAccount, resolveAccount, type AccountRow, type AgentTool } from "./accounts";
import { badRequest, conflict, notFound } from "./errors";
import { db } from "./db";
import { captureHistory, getSession, sendText, sessionView, type SessionRow } from "./sessions";

/**
 * What each agent can be started with: its models and reasoning levels, plus
 * what it uses when you don't pick (so "Default" can say what that means).
 * Claude takes aliases that always point at the newest model; Codex lists its
 * models in a cache file; agy prints them with `agy models`.
 */

export type ModelOption = {
  id: string;
  label: string;
  efforts?: string[];
  /** The effort this model starts at when none is picked (its own setting can differ from the global one). */
  defaultEffort?: string | null;
};
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

/** "claude-opus-5-5" → 505; "claude-sonnet-4-20250514" → 400 (a date isn't a minor version). */
const claudeVersion = (id: string) => {
  const m = id.match(/^claude-[a-z]+-(\d+)(?:-(\d{1,2})(?!\d))?/);
  return m ? Number(m[1]) * 100 + Number(m[2] ?? 0) : -1;
};

/**
 * The effort Claude starts a model at: its own entry in modelSettings, else the
 * global effortLevel. An alias ("opus") means the newest model of that family:
 * the newest id this machine's sessions ran on, else the newest one in modelSettings.
 */
export function claudeDefaultEffort(settings: any, model: string, seen: string[] = []): string | null {
  const per: Record<string, any> = settings?.modelSettings && typeof settings.modelSettings === "object" ? settings.modelSettings : {};
  const top = typeof settings?.effortLevel === "string" ? settings.effortLevel : null;
  const own = (id: string) => (typeof per[id]?.effortLevel === "string" ? (per[id].effortLevel as string) : null);
  if (model.startsWith("claude-")) return own(model.replace(/\[.*\]$/, "")) ?? top;
  const family = `claude-${model.toLowerCase()}-`;
  const newest = (ids: string[]) => ids.filter((x) => x.startsWith(family)).sort((x, y) => claudeVersion(y) - claudeVersion(x))[0];
  const id = newest(seen) ?? newest(Object.keys(per).filter((k) => own(k)));
  return (id && own(id)) ?? top;
}

function claudeChoices(a: AccountRow | null): ModelChoices {
  const s = readJson(join(a?.dir ?? join(config.home, ".claude"), "settings.json")) ?? {};
  const seen = (db.query("SELECT DISTINCT model FROM sessions WHERE tool = 'claude' AND model LIKE 'claude-%'").all() as { model: string }[]).map((r) => r.model);
  const model = typeof s.model === "string" ? s.model : null;
  return {
    models: CLAUDE_MODELS.map((m) => ({ ...m, defaultEffort: claudeDefaultEffort(s, m.id, seen) })),
    efforts: CLAUDE_EFFORTS,
    // With no default model set, Claude picks one by plan; only a global level is certain then.
    default: { model, effort: model ? claudeDefaultEffort(s, model, seen) : s.modelSettings ? null : (s.effortLevel ?? null) },
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
      defaultEffort: typeof m.default_reasoning_level === "string" ? m.default_reasoning_level : null,
    }));
  let toml = "";
  try {
    toml = readFileSync(join(home, "config.toml"), "utf8");
  } catch {}
  const top = toml.split(/^\s*\[/m)[0] ?? ""; // only top-level keys, not [profiles.x] ones
  const key = (k: string) => top.match(new RegExp(`^\\s*${k}\\s*=\\s*"([^"]+)"`, "m"))?.[1] ?? null;
  // A configured reasoning effort applies to every model; without one, each starts at its own default.
  const effort = key("model_reasoning_effort");
  if (effort) for (const m of models) m.defaultEffort = effort;
  return {
    models,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    default: { model: key("model"), effort: effort ?? models.find((m) => m.id === key("model"))?.defaultEffort ?? null },
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
 * session keeps its switch; tested with Claude Code 2.1 and agy). The commands
 * were answered before this runs, so their writes have landed; keep watching a
 * little for a late one (longer when a command went unconfirmed).
 */
async function keepDefaults(path: string, keys: string[], before: Record<string, unknown>, watchMs: number) {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (let waited = 0; waited < watchMs; waited += 250) {
    await Bun.sleep(250);
    const now = readDefaults(path, keys);
    if (!now || keys.every((k) => same(now[k], before[k]))) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const j = JSON.parse(text);
    for (const k of keys) {
      if (before[k] === undefined) delete j[k];
      else j[k] = before[k];
    }
    writeFileSync(path, JSON.stringify(j, null, 2) + (text.endsWith("\n") ? "\n" : ""));
  }
}

const fileSize = (path: string) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

/**
 * On screen, the agent's answer to a slash command sits under its echo, marked ⎿
 * (Claude and agy alike). Found by the command's name: agy echoes "/effort" without
 * its argument.
 */
export function answeredOnScreen(screen: string, name: string): boolean {
  const lines = screen.split("\n");
  let i = -1;
  lines.forEach((l, n) => l.includes(name) && (i = n));
  return i >= 0 && lines.slice(i + 1).some((l) => l.trimStart().startsWith("⎿"));
}

/**
 * Type a slash command and wait until the agent has answered it, so the next one
 * isn't typed while it's busy. The screen shows the answer at once; Claude's log
 * has it too, but its first /model in a session lands there seconds late, so only
 * this command's own answer counts. Claude can also swallow a command typed just
 * after that first /model: if this one never reached the screen, type it once more.
 */
async function runCommand(s: SessionRow, command: string): Promise<boolean> {
  const name = command.split(" ")[0]!; // "/model"
  const own = new RegExp(`<local-command-stdout>[^<]*\\b${name.slice(1)}\\b`, "i");
  const log = s.tool === "claude" ? s.transcript : null;
  const from = log ? fileSize(log) : 0;
  const screen = () => captureHistory(s.id, 60).catch(() => "");
  const echoes = (text: string) => text.split(name).length - 1;
  const before = await screen();
  const answered = async () => {
    const now = await screen();
    if (echoes(now) > echoes(before) && answeredOnScreen(now, name)) return true;
    return !!log && fileSize(log) > from && own.test(await Bun.file(log).slice(from).text());
  };
  const wait = async (ms: number) => {
    for (let t = 0; t < ms; t += 200) {
      await Bun.sleep(200);
      if (await answered()) return true;
    }
    return false;
  };
  await sendText(s.id, command);
  if (await wait(3000)) return true;
  if (echoes(await screen()) <= echoes(before)) await sendText(s.id, command); // swallowed: never shown
  return wait(5000);
}

/**
 * Change a running agent's model or effort. Claude and agy take `/model <id>` and
 * `/effort <level>` as typed commands, one after the other once each is answered.
 * Codex's /model takes no argument, so it only opens Codex's own menu.
 * `missed` lists the commands the agent didn't confirm in time.
 */
export async function switchModel(id: string, o: { model?: string; effort?: string }): Promise<{ menu: boolean; missed?: ("model" | "effort")[] }> {
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
  // Typed into a startup or sign-in menu, a command's letters and digits could pick an option.
  if (sessionView(s).startup) throw conflict("the agent is on a startup screen; answer it first");
  if (s.tool === "claude" && !s.agent_state) throw conflict("Claude hasn't started yet; try again in a moment");
  if (s.tool === "agy" && /not signed in|Select login method/i.test(await captureHistory(id, 0).catch(() => "")))
    throw conflict("agy isn't signed in; sign in from its terminal first");
  // Mid-reply, a typed /model waits for the turn to end (/effort applies at once),
  // and by then ansai could no longer tell its write to your defaults apart from yours.
  if (o.model && s.agent_state === "working") throw conflict("the agent is mid-reply; switch the model once it's done");
  const saved = savedDefaults(s.tool, s.account_id);
  const before = saved ? readDefaults(saved.path, saved.keys) : null;
  const missed: ("model" | "effort")[] = [];
  if (o.model && !(await runCommand(s, `/model ${o.model}`))) missed.push("model");
  if (o.effort && !(await runCommand(getSession(id) ?? s, `/effort ${o.effort}`))) missed.push("effort");
  if (saved && before) await keepDefaults(saved.path, saved.keys, before, missed.length ? 5000 : 1000);
  return missed.length ? { menu: false, missed } : { menu: false };
}
