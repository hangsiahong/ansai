import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { db, getSetting, setSetting } from "./db";
import { gitSync } from "./git";
import { createTask, getTask, projectAutopilot } from "./tasks";
import { getSettings } from "./autopilot";
import { captureHistory, paneActivity } from "./sessions";

/**
 * The doctor: ansai checking itself. Every 10 minutes deterministic detectors look for
 * evidence that ansai misbehaved (errors it keeps logging, state its own code should have
 * moved on from), and each finding becomes a backlog task in ansai's own project, so
 * autopilot fixes it like any other task. Detectors are pure functions over rows and a
 * clock (tests feed them fixtures); gathering the rows is separate.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
/** The first run waits out restart transients (hooks that were in flight, panes not yet seen). */
export const FIRST_RUN_MS = 5 * MIN;
export const EVERY_MS = 10 * MIN;
export const ERROR_WINDOW_MS = HOUR;
/** Errors logged this soon after start are restart noise, not a pattern. */
export const ERROR_GRACE_MS = 2 * MIN;
/** onExited moves a Doing task on the moment its last agent ends; this is a generous margin. */
export const STUCK_DOING_MS = 15 * MIN;
/** A working Claude or Codex redraws its spinner every second, so a pane this quiet isn't working. */
export const SILENT_WORKING_MS = 20 * MIN;
/** compaction.ts gives up on a compaction after 5 minutes. */
export const COMPACTION_STUCK_MS = 20 * MIN;
/** scheduleTick runs every few seconds. */
export const SCHEDULE_LATE_MS = 30 * MIN;
/** nudgeIdle ends expired shifts every few seconds. */
export const SHIFT_LATE_MS = 10 * MIN;
/** A finding whose task is Done is filed again only when the problem starts anew this long after. */
export const REFILE_AFTER_MS = 24 * HOUR;
export const DEFAULT_PER_DAY = 3;

/** `latest`: when the newest instance of the problem began; a regression is one that began after the last fix. */
export type Finding = { key: string; title: string; details: string; priority: number; latest: number };

const p2 = (n: number) => String(n).padStart(2, "0");
function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
function ago(ms: number, at: number): string {
  const m = Math.round((at - ms) / MIN);
  return m < 90 ? `${m} min ago` : `${(m / 60).toFixed(1)} h ago`;
}
const when = (ms: number, at: number) => `${stamp(ms)} (${ago(ms, at)})`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const details = (seen: string, evidence: string[], look: string[]) =>
  [seen, "", "Evidence:", ...evidence.map((e) => `- ${e}`), "", "Where to look:", ...look.map((l) => `- ${l}`)].join("\n");

// ------------------------------------------------------------------ errors ansai logs

type ErrorRule = { kind: "request" | "screen" | "error"; test: RegExp; min: number; priority: number };
/** First match wins. A failed request (guard's 500) or a screen that didn't draw on the phone is a user-facing fault. */
const ERROR_RULES: ErrorRule[] = [
  { kind: "request", test: /^\[ansai\] (?:GET|POST|PUT|PATCH|DELETE) \S+ failed:/, min: 2, priority: 2 },
  { kind: "screen", test: /^\[ansai\] web app error on .* \((?:app|page|sheet) at /, min: 2, priority: 2 },
  { kind: "error", test: /^/, min: 3, priority: 1 },
];

const HINTS: [RegExp, string][] = [
  [/^\[ansai\] (?:GET|POST|PUT|PATCH|DELETE) /, "src/server/index.ts: guard() logged it; the route's handler threw something that isn't an HttpError"],
  [/web app error/, "src/web: the route and the functions named in the error (src/web/crash.tsx reports it; src/server/clienterrors.ts writes the line)"],
  [/push failed/, "src/server/push.ts"],
  [/team (?:delivery|message)/, "src/server/team.ts (deliverIdle)"],
  [/autopilot|finished agent/, "src/server/autopilot.ts"],
  [/schedule/, "src/server/schedules.ts"],
  [/\bmcp\b/, "src/server/mcp.ts"],
  [/claude usage|usage scan|login warning/, "src/server/usage.ts and src/server/accounts.ts"],
  [/^reconcile:|tmux|systemd-run/, "src/server/sessions.ts"],
  [/shift/, "src/server/shifts.ts"],
  [/compact/, "src/server/compaction.ts"],
  [/worktree|reviewer/, "src/server/worktrees.ts and src/server/tasks.ts"],
  [/backup/, "src/server/backup.ts"],
  [/system monitor/, "src/server/health.ts"],
  [/chat tail/, "src/server/transcripts.ts"],
  [/renewing/, "src/server/renew.ts"],
  [/time limit|run watch/, "src/server/limits.ts"],
  [/after its wait/, "src/server/holds.ts"],
];

/** One logged error, made comparable: what varies between occurrences (ids, numbers, paths, quoted titles) is blanked out. */
export function signature(text: string): string {
  let line = text.split("\n")[0] ?? "";
  const web = line.match(/^\[ansai\] web app error on .*? \(([^()]*) at (.*?)\): (.*)$/);
  // The device varies; the stack frames after " | " are evidence, not identity.
  if (web) line = `[ansai] web app error (${web[1]} at ${web[2]}): ${web[3]!.split(" | ")[0]}`;
  return clip(
    line
      .replace(/https?:\/\/\S+/g, "<url>")
      .replace(/"[^"\n]*"/g, '"…"')
      .replace(/“[^”\n]*”/g, "“…”")
      .replace(/(?:~|\/(?:home|tmp|var|usr|opt|run|proc|root|etc|mnt|srv|private|Users|nix|dev))\/[^\s:"'),;]*/g, "<path>")
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
      .replace(/(?<![\w-])(?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]{6,}/gi, "<id>")
      .replace(/\d+(?:\.\d+)*/g, "N")
      .replace(/\s+/g, " ")
      .trim(),
    200,
  );
}

const hash = (s: string) => Bun.hash(s).toString(36).slice(0, 10);

export type ErrorStat = { sig: string; kind: ErrorRule["kind"]; min: number; priority: number; times: number[]; samples: string[]; files: string[] };

/**
 * Errors ansai logged, grouped by signature. Bounded: an error repeating every two seconds
 * keeps its last MAX_TIMES times, and the least recent signatures go past MAX_SIGS.
 */
export class ErrorLog {
  static MAX_TIMES = 100;
  static MAX_SIGS = 200;
  private stats = new Map<string, ErrorStat>();
  /** `root`: the source checkout, cut from stack paths. `since`: errors before it are ignored (startup). */
  constructor(
    private root: string,
    private since = 0,
  ) {}

  record(args: unknown[], at: number) {
    if (at < this.since) return;
    const text = args.map((a) => this.show(a)).join(" ");
    const sig = signature(text);
    if (!sig) return;
    let st = this.stats.get(sig);
    if (!st) {
      const rule = ERROR_RULES.find((r) => r.test.test(text))!;
      st = { sig, kind: rule.kind, min: rule.min, priority: rule.priority, times: [], samples: [], files: [] };
      if (this.stats.size >= ErrorLog.MAX_SIGS) this.stats.delete(this.stats.keys().next().value!);
    }
    this.stats.delete(sig); // re-inserted last, so the Map's first entry is always the least recently seen
    this.stats.set(sig, st);
    st.times.push(at);
    if (st.times.length > ErrorLog.MAX_TIMES) st.times.shift();
    const sample = `${stamp(at)} ${clip(text, 700)}`;
    // The first and the two latest occurrences.
    st.samples = st.samples.length < 3 ? [...st.samples, sample] : [st.samples[0]!, st.samples[2]!, sample];
    for (const f of text.match(/\bsrc\/(?:server|web)\/[\w./-]+\.tsx?:\d+/g) ?? []) if (!st.files.includes(f) && st.files.length < 6) st.files.push(f);
  }

  /** Signatures logged in the window before `at`, with only those times. */
  recent(at: number, window = ERROR_WINDOW_MS): ErrorStat[] {
    const out: ErrorStat[] = [];
    for (const st of this.stats.values()) {
      const times = st.times.filter((t) => t <= at && at - t <= window);
      if (times.length) out.push({ ...st, times });
    }
    return out;
  }

  private show(a: unknown): string {
    if (typeof a === "string") return a.split(this.root + "/").join("");
    if (a instanceof Error) {
      const frames = (a.stack ?? "")
        .split("\n")
        .filter((l) => /^\s*at /.test(l))
        .slice(0, 4)
        .map((l) => l.trim().split(this.root + "/").join(""));
      return [`${a.name}: ${a.message}`, ...frames].join("\n");
    }
    return Bun.inspect(a).split(this.root + "/").join("");
  }
}

export function errorFindings(stats: ErrorStat[], at: number): Finding[] {
  const out: Finding[] = [];
  for (const st of stats) {
    const times = st.times.filter((t) => t <= at && at - t <= ERROR_WINDOW_MS);
    if (times.length < st.min) continue;
    const first = Math.min(...times);
    const last = Math.max(...times);
    const what =
      st.kind === "request" ? "A request keeps failing with a server error" : st.kind === "screen" ? "A screen keeps failing to draw in the web app" : "An error keeps being logged";
    const look = [...st.files.map((f) => `${f} (from the error's stack)`), ...HINTS.filter(([re]) => re.test(st.sig)).map(([, h]) => h)];
    look.push("The line is printed by a console.error call: search src/ for its fixed words to find it.");
    out.push({
      key: `error:${hash(st.sig)}`,
      title: `${what}: ${clip(st.sig.replace(/^\[ansai\] /, ""), 110)}`,
      priority: st.priority,
      latest: last,
      details: details(
        `ansai's own log had this ${times.length}${times.length >= ErrorLog.MAX_TIMES ? "+" : ""} times in the last hour (first ${when(first, at)}, last ${when(last, at)}). Signature (ids, numbers and paths blanked):\n${st.sig}`,
        st.samples.map((s) => `\`${s.replace(/`/g, "'").replace(/\n/g, " ⏎ ")}\``),
        look,
      ),
    });
  }
  return out;
}

// ------------------------------------------------------------------ a task left in Doing

export type DoingRun = { id: string; tool: string; status: string; exit_code: number | null; auto: number; created_at: number; ended_at: number | null };
export type DoingRow = { id: string; title: string; created_at: number; updated_at: number; attempts: number; last_failure: string | null; runs: DoingRun[] };

/**
 * A task in Doing whose agents have all ended, the last one long enough ago. onExited
 * (hooks.ts) moves such a task to Review the moment its last agent ends, so this is ansai
 * failing to. A task with no agent runs was dragged to Doing by hand, and one moved or
 * edited after its last agent ended is the user's doing: neither counts. One created in
 * Doing after its agent ended and never touched since is ansai's own doing, so it does.
 */
export function stuckDoing(rows: DoingRow[], at: number): Finding[] {
  const stuck = rows.flatMap((t) => {
    if (!t.runs.length || t.runs.some((r) => r.status === "running")) return [];
    const ended = Math.max(...t.runs.map((r) => r.ended_at ?? r.created_at));
    if (at - ended < STUCK_DOING_MS || (t.updated_at > ended + MIN && t.updated_at !== t.created_at)) return [];
    return [{ t, ended }];
  });
  if (!stuck.length) return [];
  return [
    {
      key: "stuck-doing",
      title: `A task stayed in Doing after its agent ended (${stuck.length === 1 ? clip(stuck[0]!.t.title, 80) : `${stuck.length} tasks`})`,
      priority: 2,
      latest: Math.max(...stuck.map((s) => s.ended)),
      details: details(
        `These tasks are in Doing, every agent session that worked on them has ended (more than ${STUCK_DOING_MS / MIN} min ago), and nobody moved or edited them since. A task left in Doing looks active and holds an autopilot slot; ansai should have moved it to Review (or re-queued an autopilot retry) when its last agent ended.`,
        stuck.map(({ t, ended }) => {
          const runs = t.runs
            .map((r) => `${r.id} (${r.tool}${r.auto ? ", autopilot" : ""}, ${r.status}${r.exit_code !== null ? ` code ${r.exit_code}` : ""}, started ${stamp(r.created_at)}, ended ${r.ended_at ? stamp(r.ended_at) : "?"})`)
            .join("; ");
          return `task ${t.id} “${clip(t.title, 100)}”: last agent ended ${when(ended, at)}; last touched ${stamp(t.updated_at)}; attempts ${t.attempts}${t.last_failure ? `; last failure: ${t.last_failure}` : ""}. Sessions: ${runs}`;
        }),
        [
          "src/server/hooks.ts: onExited (moves Doing to Review when the last agent ends) and retryAutopilotRun",
          "src/server/sessions.ts: applyPanes and closeSession, which call onExited when a session ends",
          "src/server/autopilot.ts: the restart-recovery path in autopilotTick that sets a task to Doing",
        ],
      ),
    },
  ];
}

// ------------------------------------------------------------------ "working" with nothing on screen

export type WorkingRow = { id: string; title: string; tool: string; task_id: string | null; agent_state_at: number | null; agent_message: string | null; activity: number | null; screen?: string };

export const isSilent = (r: WorkingRow, at: number) =>
  r.activity !== null && r.agent_state_at !== null && at - r.activity >= SILENT_WORKING_MS && at - r.agent_state_at >= SILENT_WORKING_MS;

/**
 * An agent ansai shows as working whose terminal has printed nothing for a long time. A
 * working Claude or Codex redraws its spinner and timer every second, so it has stopped (or
 * sits at a prompt) and ansai missed the hook or screen change that says so. Only the pane
 * can tell: agent_state_at changes on state changes, not per tool call, so a long turn has
 * an old one too.
 */
export function silentWorking(rows: WorkingRow[], at: number): Finding[] {
  const quiet = rows.filter((r) => isSilent(r, at));
  if (!quiet.length) return [];
  return [
    {
      key: "silent-working",
      title: `An agent shows as working but its terminal has been still (${quiet.length === 1 ? clip(quiet[0]!.title, 80) : `${quiet.length} agents`})`,
      priority: 2,
      latest: Math.max(...quiet.map((r) => r.activity!)),
      details: details(
        `ansai has these agents as "working", yet their tmux pane has printed nothing for ${SILENT_WORKING_MS / MIN}+ minutes. A working Claude or Codex redraws its spinner every second, so the turn is over (or the agent waits at a prompt) and ansai's state is wrong: its task stays in Doing, team messages aren't typed in, and you aren't told it needs you.`,
        quiet.map((r) => {
          const screen = r.screen?.trim() ? `\n  Screen now (last lines):\n${r.screen.trimEnd().split("\n").map((l) => `    ${l}`).join("\n")}` : "";
          return `session ${r.id} (${r.tool}) “${clip(r.title, 100)}”${r.task_id ? `, task ${r.task_id}` : ""}: working since ${when(r.agent_state_at!, at)}${r.agent_message ? ` (“${clip(r.agent_message, 80)}”)` : ""}; pane last printed ${when(r.activity!, at)}.${screen}`;
        }),
        [
          "src/server/hooks.ts: handleHook (Stop, StopFailure and the Notification idle prompt end a Claude turn; Codex's turn notify)",
          "src/server/sessions.ts: watchRewinds and codexStopped (screen-based fallbacks for a missed turn end)",
          "src/server/transcripts.ts: the Interrupted check from the agent's log",
        ],
      ),
    },
  ];
}

// ------------------------------------------------------------------ compaction never handed back

export type PlanRow = {
  sessionId: string;
  phase: string;
  at: number;
  sent: boolean;
  session: { title: string; status: string; agent_state: string | null; agent_state_at: number | null; agent_message: string | null } | null;
};

/**
 * A compaction an agent asked for (compaction.ts) that never finished. "compacting" has a
 * 5-minute give-up timer, so one still there long after is stuck. "asked" waits for the
 * turn to end; an agent whose turn ended after it asked, and has been idle since, never got
 * its /compact and never will (an interrupt by you is excluded: that turn is yours).
 */
export function stuckCompactions(rows: PlanRow[], at: number): Finding[] {
  const stuck = rows.flatMap((r) => {
    const s = r.session;
    if (!s || s.status !== "running") return [];
    if (r.phase === "compacting" && at - r.at >= COMPACTION_STUCK_MS) return [{ r, since: r.at, why: `compacting since ${when(r.at, at)}; /compact ${r.sent ? "was" : "was never"} typed` }];
    if (
      r.phase === "asked" &&
      s.agent_state === "waiting" &&
      s.agent_message !== "Interrupted" &&
      s.agent_state_at !== null &&
      s.agent_state_at >= r.at &&
      at - s.agent_state_at >= COMPACTION_STUCK_MS
    )
      return [{ r, since: s.agent_state_at, why: `asked at ${stamp(r.at)}, its turn ended at ${when(s.agent_state_at, at)}, and /compact was never typed` }];
    return [];
  });
  if (!stuck.length) return [];
  return [
    {
      key: "compaction-stuck",
      title: `A compaction an agent asked for never finished (${stuck.length === 1 ? clip(stuck[0]!.r.session!.title, 80) : `${stuck.length} agents`})`,
      priority: 2,
      latest: Math.max(...stuck.map((s) => s.since)),
      details: details(
        `An agent called ansai's compact tool and was promised its next step after the compaction; it never got it, so its autonomous run sits idle until someone looks. The plan is still saved as compact-plan:<session> in settings.`,
        stuck.map(({ r, why }) => `session ${r.sessionId} “${clip(r.session!.title, 100)}” (now ${r.session!.agent_state ?? "no state"}${r.session!.agent_message ? `, “${clip(r.session!.agent_message, 60)}”` : ""}): ${why}`),
        [
          "src/server/compaction.ts: startCompaction, typeCompact, compacted, the give-up timer and resumeCompactions",
          "src/server/hooks.ts: the Stop hook, the Notification idle prompt, and SessionStart with source \"compact\"",
        ],
      ),
    },
  ];
}

// ------------------------------------------------------------------ schedules and shifts the clock passed by

export type ScheduleRow = { id: string; title: string; project_id: string; next_at: number };

export function lateSchedules(rows: ScheduleRow[], at: number): Finding[] {
  const late = rows.filter((s) => at - s.next_at >= SCHEDULE_LATE_MS);
  if (!late.length) return [];
  return [
    {
      key: "schedule-late",
      title: `A scheduled task didn't run on time (${late.length === 1 ? clip(late[0]!.title, 80) : `${late.length} schedules`})`,
      priority: 2,
      latest: Math.max(...late.map((s) => s.next_at)),
      details: details(
        `These schedules are enabled and their time passed more than ${SCHEDULE_LATE_MS / MIN} minutes ago, yet next_at never moved on. scheduleTick runs every few seconds and logs a failing schedule only once, so this may be the only sign.`,
        late.map((s) => `schedule ${s.id} “${clip(s.title, 100)}” in project ${s.project_id}: due ${when(s.next_at, at)}`),
        ["src/server/schedules.ts: scheduleTick, occurrence and nextAt", "src/server/autopilot.ts: startAutopilot calls scheduleTick on every tick"],
      ),
    },
  ];
}

export type ShiftRow = { session_id: string; until: number; started_at: number; title: string | null; session_status: string | null; session_ended_at: number | null };

export function overrunShifts(rows: ShiftRow[], at: number): Finding[] {
  const late = rows.flatMap((sh) => {
    if (at - sh.until >= SHIFT_LATE_MS) return [{ sh, since: sh.until, why: `its time ran out ${when(sh.until, at)}` }];
    const gone = sh.session_status !== "running" ? (sh.session_ended_at ?? sh.started_at) : null;
    if (gone !== null && at - gone >= SHIFT_LATE_MS) return [{ sh, since: gone, why: `its agent ${sh.session_status ? `is ${sh.session_status}` : "is gone"} since ${when(gone, at)}` }];
    return [];
  });
  if (!late.length) return [];
  return [
    {
      key: "shift-overrun",
      title: `A shift didn't end when it should have (${late.length === 1 ? clip(late[0]!.sh.title ?? late[0]!.sh.session_id, 80) : `${late.length} shifts`})`,
      priority: 2,
      latest: Math.max(...late.map((l) => l.since)),
      details: details(
        `These shifts are still active although they should have ended (nudgeIdle ends expired shifts and shifts of stopped agents every few seconds). An overrun shift keeps typing prompts into its agent, spending usage after the time you set.`,
        late.map(({ sh, why }) => `shift of session ${sh.session_id} “${clip(sh.title ?? "?", 100)}”: started ${stamp(sh.started_at)}, until ${stamp(sh.until)}; ${why}`),
        ["src/server/shifts.ts: nudgeIdle and endShift", "src/server/index.ts: the interval that calls nudgeIdle"],
      ),
    },
  ];
}

// ------------------------------------------------------------------ gathering

let errors: ErrorLog | null = null;
const ROOT = resolve(import.meta.dir, "../..");

/** Keep a copy of every console.error (its normal output is untouched). Once per process. */
export function watchErrors(at = Date.now()) {
  if (errors) return;
  const log = new ErrorLog(ROOT, at + ERROR_GRACE_MS);
  errors = log;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    original(...args);
    try {
      log.record(args, Date.now());
    } catch {} // the line is already out; recording it must never break logging
  };
}

export type Gathered = { errors: ErrorStat[]; doing: DoingRow[]; working: WorkingRow[]; plans: PlanRow[]; schedules: ScheduleRow[]; shifts: ShiftRow[] };

export async function gather(at: number): Promise<Gathered> {
  const doing = db.query("SELECT id, title, created_at, updated_at, attempts, last_failure FROM tasks WHERE status = 'doing'").all() as Omit<DoingRow, "runs">[];
  const runs = db
    .query(
      `SELECT s.id, s.task_id, s.tool, s.status, s.exit_code, s.auto, s.created_at, s.ended_at FROM sessions s JOIN tasks t ON t.id = s.task_id
       WHERE t.status = 'doing' AND s.title NOT LIKE 'Review · %' AND NOT EXISTS (SELECT 1 FROM task_reviews r WHERE r.session_id = s.id)`,
    )
    .all() as (DoingRun & { task_id: string })[];

  const working = (
    db
      .query(
        `SELECT id, title, tool, tmux_name, task_id, agent_state_at, agent_message FROM sessions s
         WHERE status = 'running' AND agent_state = 'working' AND tool IN ('claude', 'codex')
           AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'compact-plan:' || s.id)`,
      )
      .all() as (Omit<WorkingRow, "activity"> & { tmux_name: string })[]
  ).map(({ tmux_name, ...r }): WorkingRow => ({ ...r, activity: paneActivity(tmux_name) }));
  for (const r of working.filter((r) => isSilent(r, at))) {
    try {
      r.screen = (await captureHistory(r.id, 0)).split("\n").filter((l) => l.trim()).slice(-15).join("\n");
    } catch {} // the screen is extra evidence; the finding stands without it
  }

  const plans = (db.query("SELECT key, value FROM settings WHERE key LIKE 'compact-plan:%'").all() as { key: string; value: string }[]).flatMap((row): PlanRow[] => {
    const sessionId = row.key.slice("compact-plan:".length);
    let p: { phase?: unknown; at?: unknown; sent?: unknown };
    try {
      p = JSON.parse(row.value);
    } catch {
      return [];
    }
    const session = db.query("SELECT title, status, agent_state, agent_state_at, agent_message FROM sessions WHERE id = ?").get(sessionId) as PlanRow["session"];
    return [{ sessionId, phase: String(p.phase), at: Number(p.at) || 0, sent: !!p.sent, session }];
  });

  return {
    errors: errors?.recent(at) ?? [],
    doing: doing.map((t) => ({ ...t, runs: runs.filter((r) => r.task_id === t.id) })),
    working,
    plans,
    schedules: db.query("SELECT id, title, project_id, next_at FROM schedules WHERE enabled = 1").all() as ScheduleRow[],
    shifts: db
      .query(
        `SELECT sh.session_id, sh.until, sh.started_at, s.title, s.status AS session_status, s.ended_at AS session_ended_at
         FROM shifts sh LEFT JOIN sessions s ON s.id = sh.session_id WHERE sh.ended_at IS NULL`,
      )
      .all() as ShiftRow[],
  };
}

export function detect(g: Gathered, at: number): Finding[] {
  return [
    ...stuckDoing(g.doing, at),
    ...silentWorking(g.working, at),
    ...stuckCompactions(g.plans, at),
    ...lateSchedules(g.schedules, at),
    ...overrunShifts(g.shifts, at),
    ...errorFindings(g.errors, at),
  ];
}

// ------------------------------------------------------------------ ansai's own project

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** Where the code running from `root` comes from: a release folder is a clone whose origin is the dev checkout; a dev instance runs from the checkout itself. */
export function sourceCheckouts(root: string): string[] {
  const origin = gitSync(root, ["remote", "get-url", "origin"], { timeout: 5000 })?.replace(/^file:\/\//, "") ?? null;
  return [...new Set([origin && isAbsolute(origin) ? real(origin) : null, real(root)].filter((p): p is string => !!p))];
}
let checkouts: string[] | null = null;

export type DoctorProject = { id: string; why: string } | { id: null; why: string };

/** The project doctor tasks go to: the `doctor:project` setting, else the project at ansai's source checkout. */
export function doctorProject(): DoctorProject {
  const override = getSetting<string | null>("doctor:project", null);
  if (override) {
    const p = db.query("SELECT id FROM projects WHERE id = ?").get(override) as { id: string } | null;
    return p ? { id: p.id, why: "the doctor:project setting" } : { id: null, why: `the doctor:project setting names ${override}, which isn't a project` };
  }
  checkouts ??= sourceCheckouts(ROOT);
  for (const path of checkouts) {
    const p = db.query("SELECT id FROM projects WHERE path = ?").get(path) as { id: string } | null;
    if (p) return { id: p.id, why: `ansai's source checkout ${path}` };
  }
  return { id: null, why: `no project is at ansai's source checkout (${checkouts.join(" or ")}); set doctor:project to choose one` };
}

// ------------------------------------------------------------------ filing

type Seen = { task: string; filedAt: number };
const SEEN = "doctor:seen:";
export const perDay = () => Math.max(0, Math.floor(getSetting<number>("doctor:max_per_day", DEFAULT_PER_DAY)));

export type Outcome = { key: string; title: string; why: string; task?: string };
export type Filing = { filed: Outcome[]; held: Outcome[]; skipped: Outcome[] };

function body(f: Finding): string {
  return [
    "ansai's doctor found this by itself (src/server/doctor.ts); nobody reported it.",
    f.details,
    [
      "What to do:",
      "- Find the root cause in ansai's code and fix it, with a test that reproduces it (fails before the fix, passes after).",
      "- If it isn't an ansai bug (for example the user's own action, or an outside service failing), say so with the evidence in finish_task and change nothing.",
      "- Never weaken a test or a doctor detector to make this go away.",
    ].join("\n"),
    `Doctor finding ${f.key}: once this task is Done, it is filed again only if the problem starts again more than 24 hours later. Delete this task instead to stop the doctor filing this finding at all.`,
  ].join("\n\n");
}

/**
 * Findings become tasks in `projectId`: one open task per finding key, a Done one filed
 * again only for a problem that began more than a day after it was done, and at most
 * `doctor:max_per_day` new tasks in any 24 hours (the rest wait for a later run). A
 * deleted task dismisses its finding for good: from the phone, that is how you say "not a
 * bug, stop telling me" (a fixer that finds no ansai bug says so and leaves it to you).
 * `dry` says what would happen and writes nothing.
 */
export function fileFindings(findings: Finding[], projectId: string, at: number, dry = false): Filing {
  const out: Filing = { filed: [], held: [], skipped: [] };
  const seen = new Map(
    (db.query("SELECT key, value FROM settings WHERE key LIKE ?").all(`${SEEN}%`) as { key: string; value: string }[]).flatMap((r) => {
      try {
        return [[r.key.slice(SEEN.length), JSON.parse(r.value) as Seen] as const];
      } catch {
        return [];
      }
    }),
  );
  let budget = perDay() - [...seen.values()].filter((s) => at - s.filedAt < 24 * HOUR).length;
  for (const f of [...findings].sort((a, b) => b.priority - a.priority || a.latest - b.latest)) {
    const s = seen.get(f.key);
    if (s) {
      const task = getTask(s.task);
      if (!task) {
        out.skipped.push({ key: f.key, title: f.title, why: "dismissed: its task was deleted", task: s.task });
        continue;
      }
      if (task.status !== "done") {
        out.skipped.push({ key: f.key, title: f.title, why: `already filed, still open (${task.status})`, task: s.task });
        continue;
      }
      const doneAt = task.done_at ?? task.updated_at;
      if (f.latest <= doneAt + REFILE_AFTER_MS) {
        out.skipped.push({ key: f.key, title: f.title, why: `done at ${stamp(doneAt)}; this began before a day had passed since`, task: s.task });
        continue;
      }
    }
    if (budget <= 0) {
      out.held.push({ key: f.key, title: f.title, why: `daily limit of ${perDay()} doctor tasks reached` });
      continue;
    }
    budget--;
    if (dry) {
      out.filed.push({ key: f.key, title: f.title, why: s ? "came back after its fix" : "new" });
      continue;
    }
    const t = createTask({
      title: `Doctor: ${f.title}`,
      body: body(f),
      projectId,
      priority: f.priority,
      source: "agent",
      queued: !!projectAutopilot(projectId)?.on,
    });
    setSetting(SEEN + f.key, { task: t.id, filedAt: at } satisfies Seen);
    out.filed.push({ key: f.key, title: f.title, why: s ? "came back after its fix" : "new", task: t.id });
  }
  return out;
}

// ------------------------------------------------------------------ running

export type DoctorRun = { at: number; dry: boolean; project: DoctorProject; findings: Finding[] } & Filing;

let last: DoctorRun | null = null;
let nextAt: number | null = null;
let saidNoProject = "";

function logLine(r: DoctorRun): string {
  if (!r.findings.length) return "[ansai] doctor: all clear";
  const list = (o: Outcome[]) => o.map((x) => (x.task ? `${x.key} (${x.task})` : x.key)).join(", ");
  return [
    `[ansai] doctor: ${r.findings.length} finding${r.findings.length > 1 ? "s" : ""}`,
    r.filed.length ? `filed ${list(r.filed)}` : "",
    r.held.length ? `held back ${list(r.held)} (daily limit ${perDay()})` : "",
    r.skipped.length ? `already handled ${list(r.skipped)}` : "",
    r.project.id ? "" : `nothing filed: ${r.project.why}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** One check: detect, then file (`dry`: only say what would be filed). Off in Settings, a real run does nothing. */
export async function runDoctor(at = Date.now(), dry = false): Promise<DoctorRun | null> {
  if (!dry && !getSettings().doctor) return null;
  const findings = detect(await gather(at), at);
  const project = doctorProject();
  const filing = project.id ? fileFindings(findings, project.id, at, dry) : { filed: [], held: [], skipped: [] };
  const run: DoctorRun = { at, dry, project, findings, ...filing };
  if (dry) return run;
  last = run;
  if (!project.id && saidNoProject !== project.why) {
    saidNoProject = project.why;
    console.log(`[ansai] doctor: ${project.why}, so it files nothing`);
  }
  console.log(logLine(run));
  return run;
}

export function startDoctor() {
  watchErrors();
  const tick = () => {
    nextAt = Date.now() + EVERY_MS;
    runDoctor()
      .catch((e) => console.error("[ansai] doctor:", e))
      .finally(() => setTimeout(tick, EVERY_MS));
  };
  nextAt = Date.now() + FIRST_RUN_MS;
  setTimeout(tick, FIRST_RUN_MS);
}

/** GET /api/doctor: the last run, and with `now` what a run would find and file right now. */
export async function doctorView(now: boolean) {
  return {
    on: getSettings().doctor,
    project: doctorProject(),
    perDay: perDay(),
    nextAt,
    last,
    ...(now ? { now: await runDoctor(Date.now(), true) } : {}),
  };
}
