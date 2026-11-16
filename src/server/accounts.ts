import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config } from "./config";
import { db, getSetting, now, setSetting } from "./db";
import { emit } from "./events";
import { notify } from "./push";
import { renewClaudeLogin } from "./renew";
import { badRequest, conflict, notFound } from "./errors";
import { heldUntil } from "./holds";
import { fetchClaudeLimits, loginRejected, prune, scanClaude, scanCodex, storedLimits, tokenSummary, type TokenSummary } from "./usage";
import { agyModels, agySignedIn, agySignInHint } from "./agyauth";

export type AgentTool = "claude" | "codex" | "agy";
export const AGENT_TOOLS: AgentTool[] = ["claude", "codex", "agy"];
export const isAgentTool = (t: unknown): t is AgentTool => typeof t === "string" && (AGENT_TOOLS as string[]).includes(t);

export type AccountRow = {
  id: string;
  tool: AgentTool;
  name: string;
  dir: string | null; // null = the login you already have on this laptop
  email: string | null;
  plan: string | null;
  is_default: number; // preferred account for new sessions of this tool
  created_at: number;
};

const PROFILES = join(config.dataDir, "profiles");
const H = config.home;

/** Config that should follow you into every profile (settings, memory, skills…) but not the login. */
const SHARED: Record<AgentTool, string[]> = {
  claude: ["settings.json", "CLAUDE.md", "agents", "commands", "skills", "plugins", "output-styles", "keybindings.json", "hooks"],
  codex: ["config.toml", "AGENTS.md", "prompts", "skills", "rules"],
  agy: [],
};

function linkIfMissing(src: string, dst: string) {
  if (!existsSync(src)) return;
  try {
    lstatSync(dst);
    return; // already there (file, dir or link)
  } catch {}
  try {
    symlinkSync(src, dst);
  } catch {}
}

/** agy has no config-dir variable, so a profile is a separate HOME that links everything except ~/.gemini. */
function syncFakeHome(dir: string) {
  mkdirSync(join(dir, ".gemini"), { recursive: true });
  for (const name of readdirSync(H)) {
    if (name === ".gemini" || name === ".ansai") continue;
    linkIfMissing(join(H, name), join(dir, name));
  }
  linkIfMissing(join(H, ".gemini", "config"), join(dir, ".gemini", "config"));
}

function linkShared(tool: AgentTool, dir: string) {
  if (tool === "agy") return syncFakeHome(dir);
  const base = tool === "claude" ? join(H, ".claude") : join(H, ".codex");
  for (const name of SHARED[tool]) linkIfMissing(join(base, name), join(dir, name));
}

// Same shape Claude Code gives a project entry it creates itself.
const CLAUDE_PROJECT_DEFAULTS = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
};

/** Trusted here or in a parent folder, the way Claude Code checks it. */
function claudeTrusts(cfg: any, folder: string): boolean {
  for (let p = folder; ; p = dirname(p)) {
    if (cfg?.projects?.[p]?.hasTrustDialogAccepted === true) return true;
    if (p === dirname(p)) return false;
  }
}

/**
 * Claude Code asks "Do you trust this folder?" once per config dir, and a new profile trusts
 * nothing, so sessions on a second account stop at that dialog (default answer: exit).
 * A folder your normal login already trusts is marked trusted in the profile too.
 */
function carryClaudeTrust(dir: string, cwd: string) {
  const folder = resolve(cwd);
  if (folder === H) return; // Claude only trusts the home folder for one session at a time
  const path = join(dir, ".claude.json");
  if (!existsSync(path)) return; // not signed in yet; the login flow comes first
  const prof = readJson(path);
  if (!prof || typeof prof !== "object") return; // unreadable (mid-write?): leave it alone
  if (prof.projects?.[folder]?.hasTrustDialogAccepted === true) return;
  if (!claudeTrusts(readJson(join(H, ".claude.json")), folder)) return;
  prof.projects = { ...prof.projects, [folder]: { ...CLAUDE_PROJECT_DEFAULTS, ...prof.projects?.[folder], hasTrustDialogAccepted: true } };
  const tmp = `${path}.ansai-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(prof, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    console.error("[ansai] could not carry folder trust into the profile:", e);
  }
}

// ------------------------------------------------------------------ rows

export function ensureDefaultAccounts() {
  for (const tool of AGENT_TOOLS) {
    db.query(
      `INSERT OR IGNORE INTO accounts (id, tool, name, dir, is_default, created_at) VALUES (?, ?, 'Default login', NULL, 0, ?)`,
    ).run(`${tool}-default`, tool, now());
    const hasPreferred = db.query("SELECT 1 FROM accounts WHERE tool = ? AND is_default = 1").get(tool);
    if (!hasPreferred) db.query("UPDATE accounts SET is_default = 1 WHERE id = ?").run(`${tool}-default`);
  }
}

export function getAccount(id: string): AccountRow | null {
  return db.query("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | null;
}

/** The account a new session should use: the one picked, else the preferred one for that tool. */
export function resolveAccount(tool: string, accountId?: string | null): AccountRow | null {
  if (!isAgentTool(tool)) return null;
  if (accountId) {
    const a = getAccount(accountId);
    if (!a) throw badRequest("no such account");
    if (a.tool !== tool) throw badRequest(`that account belongs to ${a.tool}, not ${tool}`);
    return a;
  }
  return db.query("SELECT * FROM accounts WHERE tool = ? ORDER BY is_default DESC, created_at LIMIT 1").get(tool) as AccountRow | null;
}

/** Env that points the CLI at this account's profile (prepared for a session in `cwd`). Empty for your normal login. */
export function accountEnv(a: AccountRow | null, cwd: string): Record<string, string> {
  if (!a?.dir) return {};
  linkShared(a.tool, a.dir); // pick up config added since the profile was made
  if (a.tool === "claude") carryClaudeTrust(a.dir, cwd);
  if (a.tool === "claude") return { CLAUDE_CONFIG_DIR: a.dir };
  if (a.tool === "codex") return { CODEX_HOME: a.dir };
  // agy keeps its login in the desktop keychain; without D-Bus it can't see the main login.
  return { HOME: a.dir, DBUS_SESSION_BUS_ADDRESS: "disabled:" };
}

export function createAccount(toolRaw: unknown, nameRaw: unknown): AccountRow {
  if (!isAgentTool(toolRaw)) throw badRequest("accounts are for claude, codex or agy");
  const tool = toolRaw;
  const name = String(nameRaw ?? "").trim().slice(0, 60);
  if (!name) throw badRequest("give the account a name, e.g. Work or Personal");
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "account";
  let id = `${tool}-${slug}`;
  for (let n = 2; getAccount(id); n++) id = `${tool}-${slug}-${n}`;
  const dir = join(PROFILES, tool, id.slice(tool.length + 1));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  linkShared(tool, dir);
  db.query("INSERT INTO accounts (id, tool, name, dir, is_default, created_at) VALUES (?, ?, ?, ?, 0, ?)").run(id, tool, name, dir, now());
  invalidate();
  return getAccount(id)!;
}

export function updateAccount(id: string, patch: { name?: unknown; preferred?: unknown }) {
  const a = getAccount(id);
  if (!a) throw notFound("no such account");
  if (patch.name !== undefined) {
    const name = String(patch.name).trim().slice(0, 60);
    if (!name) throw badRequest("name can't be empty");
    db.query("UPDATE accounts SET name = ? WHERE id = ?").run(name, id);
  }
  if (patch.preferred) db.query("UPDATE accounts SET is_default = (id = ?) WHERE tool = ?").run(id, a.tool);
  invalidate();
  return getAccount(id);
}

export function deleteAccount(id: string) {
  const a = getAccount(id);
  if (!a) throw notFound("no such account");
  if (!a.dir) throw conflict("this is your laptop's normal login; sign out from the CLI itself");
  const running = db.query("SELECT count(*) AS n FROM sessions WHERE account_id = ? AND status = 'running'").get(id) as { n: number };
  if (running.n) throw conflict("close the sessions using this account first");
  const dir = resolve(a.dir);
  if (!dir.startsWith(PROFILES + "/")) throw new Error("refusing to delete a folder outside ~/.ansai/profiles");
  rmSync(dir, { recursive: true, force: true });
  db.transaction(() => {
    db.query("DELETE FROM usage_events WHERE account_id = ?").run(id);
    db.query("DELETE FROM usage_files WHERE account_id = ?").run(id);
    db.query("DELETE FROM usage_limits WHERE account_id = ?").run(id);
    db.query("DELETE FROM accounts WHERE id = ?").run(id);
  })();
  if (a.is_default) db.query("UPDATE accounts SET is_default = 1 WHERE id = ?").run(`${a.tool}-default`);
  invalidate();
}

/** Command that signs this account in, usable from a phone (device code / paste-code flows). */
export function loginArgv(a: AccountRow): string[] {
  const info = readInfo(a);
  if (a.tool === "claude") return info.logged_in ? ["claude", "/login"] : ["claude"];
  if (a.tool === "codex") return ["codex", "login", "--device-auth"];
  return ["agy"];
}

// ------------------------------------------------------------- reading info

export type Limit = { id: string; label: string; used_percent: number; resets_at: number | null; reset: boolean };
type LoginProblem = "expired" | "rejected";
type Info = {
  email: string | null;
  plan: string | null;
  logged_in: boolean;
  limits: Limit[];
  limits_at: number | null;
  note: string | null;
  /** When the login stops being renewable on its own (Claude refresh token); null when unknown. */
  login_expires_at?: number | null;
  login_problem?: LoginProblem | null;
};

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function jwtClaims(token: unknown): any {
  if (typeof token !== "string") return null;
  try {
    return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const shortDate = (ms: number) => new Date(ms).toLocaleDateString("en", { month: "short", day: "numeric" });

function limit(id: string, label: string, pct: unknown, resetsAt: number | null): Limit | null {
  const n = Number(pct);
  if (!Number.isFinite(n)) return null;
  // Snapshot taken before the window rolled over: it has reset since.
  const reset = resetsAt !== null && resetsAt < now();
  return { id, label, used_percent: reset ? 0 : Math.round(n), resets_at: reset ? null : resetsAt, reset };
}

function claudeInfo(a: AccountRow): Info {
  const dir = a.dir ?? join(H, ".claude");
  const state = readJson(a.dir ? join(a.dir, ".claude.json") : join(H, ".claude.json")) ?? {};
  const creds = readJson(join(dir, ".credentials.json"))?.claudeAiOauth ?? null;
  const oa = state.oauthAccount ?? {};
  const tier = String(creds?.rateLimitTier ?? oa.organizationRateLimitTier ?? "").match(/(\d+x)$/)?.[1];
  const base = oa.planDisplayName ?? (creds?.subscriptionType ? cap(String(creds.subscriptionType)) : null);
  // planDisplayName already names the tier; only the raw subscription type needs the "20x" suffix.
  const plan = oa.planDisplayName ?? (base ? `${base}${tier ? ` ${tier}` : ""}` : state.primaryApiKey ? "API key" : null);

  const limits: Limit[] = [];
  let limits_at: number | null = null;
  // Two sources: Claude Code's own cache (only rewritten when its usage view loads) and our own poll of
  // the same endpoint (usage.ts). Whichever is newer wins.
  const cu = state.cachedUsageUtilization;
  let u: any = null;
  if (cu?.utilization && (!cu.accountUuid || !oa.accountUuid || cu.accountUuid === oa.accountUuid)) {
    limits_at = cu.fetchedAtMs ?? null;
    u = cu.utilization;
  }
  const live = storedLimits(a.id);
  if (live && (!u || live.at >= (limits_at ?? 0))) {
    u = live.data;
    limits_at = live.at;
  }
  if (u) {
    const named: [string, string][] = [
      ["five_hour", "5-hour"],
      ["seven_day", "Weekly"],
      ["seven_day_opus", "Weekly · Opus"],
      ["seven_day_sonnet", "Weekly · Sonnet"],
    ];
    for (const [k, label] of named) {
      const v = u[k];
      if (!v) continue;
      const l = limit(k, label, v.utilization, v.resets_at ? Date.parse(v.resets_at) : null);
      if (l) limits.push(l);
    }
  }
  // The access token lasts hours (30 minutes on some accounts) and Claude Code renews it while a session runs.
  // The refresh token is what keeps the login alive; once it lapses, or Anthropic rejects the token, only a
  // fresh sign-in helps. Know that early: say so here and warn before it happens (warnLogins).
  const t = now();
  const loginExpires = Number(creds?.refreshTokenExpiresAt) || null;
  const accessValid = Number(creds?.expiresAt) > t;
  const problem: LoginProblem | null =
    loginExpires !== null && loginExpires < t && !accessValid ? "expired" : loginRejected(a.id, creds?.expiresAt) ? "rejected" : null;
  const hasLogin = !!(creds?.refreshToken || creds?.accessToken || state.primaryApiKey);
  const loginNote =
    problem === "expired"
      ? `This login lapsed on ${shortDate(loginExpires!)}. Sign in again.`
      : problem === "rejected"
        ? "Claude rejected this login (it was signed out elsewhere or revoked). Sign in again."
        : null;
  return {
    email: oa.emailAddress ?? null,
    plan,
    logged_in: hasLogin && !problem,
    limits,
    limits_at,
    note: loginNote ?? (limits_at ? null : "Limits appear after Claude Code checks them (run a session or /usage)."),
    login_expires_at: loginExpires,
    login_problem: problem,
  };
}

function codexInfo(a: AccountRow): Info {
  const home = a.dir ?? join(H, ".codex");
  const auth = readJson(join(home, "auth.json"));
  const claims = jwtClaims(auth?.tokens?.id_token);
  const oa = claims?.["https://api.openai.com/auth"] ?? {};
  const plan = auth?.auth_mode === "chatgpt" || oa.chatgpt_plan_type ? (oa.chatgpt_plan_type ? cap(String(oa.chatgpt_plan_type)) : "ChatGPT") : auth?.OPENAI_API_KEY ? "API key" : null;

  const limits: Limit[] = [];
  const stored = storedLimits(a.id);
  if (stored) {
    for (const key of ["primary", "secondary"]) {
      const w = stored.data?.[key];
      if (!w) continue;
      const mins = Number(w.window_minutes);
      const label = mins === 300 ? "5-hour" : mins === 10080 ? "Weekly" : mins >= 1440 ? `${Math.round(mins / 1440)}-day` : `${Math.round(mins / 60)}-hour`;
      const l = limit(key, label, w.used_percent, w.resets_at ? Number(w.resets_at) * 1000 : null);
      if (l) limits.push(l);
    }
  }
  const credits = stored?.data?.credits;
  return {
    email: claims?.email ?? null,
    plan,
    logged_in: !!(auth?.tokens?.refresh_token || auth?.OPENAI_API_KEY),
    limits,
    limits_at: stored?.at ?? null,
    note: credits?.has_credits ? `Credits: ${credits.unlimited ? "unlimited" : credits.balance}` : stored ? null : "Limits appear after Codex finishes a turn.",
  };
}

function agyInfo(a: AccountRow): Info {
  const home = a.dir ?? H;
  // What `agy models` last said (checked in the usage loop); until then, whether agy was ever set up here.
  const signedIn = agySignedIn(a.id) ?? existsSync(join(home, ".gemini", "antigravity-cli"));
  return {
    email: null,
    plan: null,
    logged_in: signedIn,
    limits: [],
    limits_at: null,
    note: !signedIn
      ? `Signed out. ${agySignInHint()}`
      : a.dir
        ? "Experimental: agy keeps logins in the desktop keychain, so this profile signs in separately (paste-code flow)."
        : "agy doesn't expose plan or limits locally.",
  };
}

/** Is this agy account signed in? Asks `agy models` when the cached answer is stale (null: couldn't tell). */
export async function checkAgySignIn(accountId: string | null): Promise<boolean | null> {
  const a = resolveAccount("agy", accountId);
  return (await agyModels(a?.id ?? "", () => accountEnv(a, H))).signedIn;
}

function readInfo(a: AccountRow): Info {
  if (a.tool === "claude") return claudeInfo(a);
  if (a.tool === "codex") return codexInfo(a);
  return agyInfo(a);
}

// ------------------------------------------------------------ list + scan

export type AccountView = AccountRow & {
  logged_in: boolean;
  login_expires_at: number | null;
  login_problem: LoginProblem | null;
  running: number;
  usage: { limits: Limit[]; limits_at: number | null; tokens: TokenSummary; note: string | null };
  /** At its usage limit: autopilot starts nothing new on it until then (holds.ts). */
  held_until?: number | null;
};

let cache: { at: number; list: AccountView[] } | null = null;
const invalidate = () => {
  cache = null;
  emit("accounts");
};

/** Accounts with what is known about them. The limit hold is read fresh: it changes the moment a run stops. */
export function listAccounts(): AccountView[] {
  return cachedAccounts().map((a) => ({ ...a, held_until: heldUntil(a.id) }));
}

function cachedAccounts(): AccountView[] {
  if (cache && now() - cache.at < 10_000) return cache.list;
  const rows = db.query("SELECT * FROM accounts ORDER BY tool, dir IS NOT NULL, created_at").all() as AccountRow[];
  const running = db
    .query(
      `SELECT COALESCE(account_id, tool || '-default') AS id, count(*) AS n FROM sessions
       WHERE status = 'running' AND tool != 'shell' GROUP BY 1`,
    )
    .all() as { id: string; n: number }[];
  const runMap = new Map(running.map((r) => [r.id, r.n]));
  const list = rows.map((a) => {
    const info = readInfo(a);
    if (info.email !== a.email || info.plan !== a.plan)
      db.query("UPDATE accounts SET email = ?, plan = ? WHERE id = ?").run(info.email, info.plan, a.id);
    return {
      ...a,
      email: info.email,
      plan: info.plan,
      logged_in: info.logged_in,
      login_expires_at: info.login_expires_at ?? null,
      login_problem: info.login_problem ?? null,
      running: runMap.get(a.id) ?? 0,
      usage: { limits: info.limits, limits_at: info.limits_at, tokens: tokenSummary(a.id), note: info.note },
    };
  });
  cache = { at: now(), list };
  return list;
}

const LOGIN_WARN_MS = 5 * 86400_000;
const LOGIN_WARN_EVERY_MS = 24 * 3600_000;

/** Accounts whose Claude login needs a fresh sign-in now, or soon enough that doing it later risks a bad moment. */
export function loginWarnings(list: AccountView[], t = now()): { id: string; kind: string; title: string; body: string }[] {
  const out: { id: string; kind: string; title: string; body: string }[] = [];
  for (const a of list) {
    if (a.tool !== "claude") continue;
    if (a.login_problem) {
      out.push({ id: a.id, kind: a.login_problem, title: `Sign in again · ${a.name}`, body: a.usage.note ?? "This Claude login no longer works." });
    } else if (a.logged_in && a.login_expires_at !== null && a.login_expires_at - t < LOGIN_WARN_MS) {
      const days = Math.max(1, Math.ceil((a.login_expires_at - t) / 86400_000));
      out.push({
        id: a.id,
        kind: "soon",
        title: `Login ends soon · ${a.name}`,
        body: `It stops renewing on ${shortDate(a.login_expires_at)} (${days} day${days === 1 ? "" : "s"}). Sign in again from Accounts now, while nothing depends on it.`,
      });
    }
  }
  return out;
}

/** One nudge a day per account, only while there's something to fix. Reuses the "needs you" push. */
async function warnLogins(list: AccountView[]) {
  for (const w of loginWarnings(list)) {
    const key = `login-warned:${w.id}`;
    const last = getSetting<{ at: number; kind: string }>(key, { at: 0, kind: "" });
    if (last.kind === w.kind && now() - last.at < LOGIN_WARN_EVERY_MS) continue;
    setSetting(key, { at: now(), kind: w.kind });
    notify("input", { title: w.title, body: w.body, url: "/accounts", tag: `login-${w.id}` }).catch(() => {});
  }
}

let scanning = false;
let lastSig = "";
export async function scanUsage() {
  if (scanning) return;
  scanning = true;
  try {
    const rows = db.query("SELECT * FROM accounts").all() as AccountRow[];
    for (const a of rows) {
      if (a.tool === "claude") {
        const dir = a.dir ?? join(H, ".claude");
        await scanClaude(a.id, dir);
        await renewClaudeLogin(a.id, dir, !!a.dir); // before the limits poll, so a fresh token is used right away
        await fetchClaudeLimits(a.id, dir);
      }
      if (a.tool === "codex") await scanCodex(a.id, a.dir ?? join(H, ".codex"));
      if (a.tool === "agy") await agyModels(a.id, () => accountEnv(a, H)); // sign-in state, at most once a minute
    }
    prune();
  } catch (e) {
    console.error("[ansai] usage scan failed:", e);
  } finally {
    scanning = false;
  }
  cache = null;
  const accounts = listAccounts();
  warnLogins(accounts).catch((e) => console.error("[ansai] login warning failed:", e));
  const sig = JSON.stringify(accounts.map((a) => [a.id, a.email, a.plan, a.logged_in, a.login_expires_at, a.login_problem, a.running, a.usage]));
  if (sig !== lastSig) {
    lastSig = sig;
    emit("accounts");
  }
}

export function startUsageLoop(ms = 60_000) {
  const tick = () => scanUsage().finally(() => setTimeout(tick, ms));
  setTimeout(tick, 1500);
}

export function refreshAccountsSoon() {
  cache = null;
  emit("accounts");
}
