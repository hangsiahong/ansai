import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { getSettings } from "./autopilot";
import { config } from "./config";
import { db, getSetting, setSetting } from "./db";
import { cleanEnv } from "./env";
import { git, gitSync } from "./git";
import { notify } from "./push";

/**
 * Merging a task in ansai's own project puts it live. ansai runs the checkout's
 * scripts/release.sh on the merged commit, the same command you'd run by hand: the checks
 * on exactly that commit, a copy of the database, a restart, and back to the version
 * before if the new one doesn't come up. It runs in a systemd unit of its own, because
 * the restart ends this process halfway through; whichever ansai is running when the
 * release finishes reads its result and tells your phone.
 *
 * Only the real service does this: one running from the release folder, a clone whose
 * origin is the project's checkout. An ansai started from a checkout or a worktree (a
 * test instance, a second copy) never releases anything.
 */

const MIN = 60_000;
/** A merge that lands while a release you started by hand is running waits this long, then tries again. */
export const RETRY_MS = MIN;
/** The unit has had time to start; if it's gone with no result, it died. */
const GRACE_MS = 15_000;

type Job = { sha: string; branch: string; task: string; title: string; project: string; at: number; after?: number };
type Running = Job & { unit: string; started: number };
export type Result = { sha: string; branch: string; task: string; title: string; ok: boolean; why: string; done: number };

const PENDING = "self-release:pending";
const RUNNING = "self-release:running";
const LAST = "self-release:last";
const dir = () => join(config.dataDir, "self-release");
const logFile = () => join(dir(), "release.log");
const exitFile = () => join(dir(), "release.exit");
const drop = (key: string) => db.query("DELETE FROM settings WHERE key = ?").run(key);

const ROOT = resolve(import.meta.dir, "../..");
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** The checkout this service is released from, or null when this ansai isn't the released service. */
function releasedFrom(): string | null {
  const folder = real(process.env.ANSAI_RELEASE_DIR || join(homedir(), ".ansai", "release"));
  if (real(ROOT) !== folder) return null;
  const origin = gitSync(ROOT, ["remote", "get-url", "origin"], { timeout: 5000 })?.replace(/^file:\/\//, "");
  if (!origin || !isAbsolute(origin) || !existsSync(join(origin, "scripts", "release.sh"))) return null;
  return real(origin);
}

export type ReleaseDeps = {
  /** The checkout this service is released from (null: not the released service, so never release). */
  source: () => string | null;
  /** The commit live now. */
  live: () => Promise<string | null>;
  /** Is `a` an ancestor of (or the same as) `b`, in the source checkout? null when git can't tell. */
  contains: (src: string, a: string, b: string) => Promise<boolean | null>;
  /** Start release.sh on `sha` in a unit of its own; its output goes to `log`, its exit code to `exit`. */
  start: (src: string, sha: string, unit: string, log: string, exit: string) => Promise<void>;
  /** Is that unit still running? */
  active: (unit: string) => Promise<boolean>;
  notify: typeof notify;
};

let source: string | null | undefined;
const real_deps: ReleaseDeps = {
  source: () => (source === undefined ? (source = releasedFrom()) : source),
  live: async () => {
    const r = await git(ROOT, ["rev-parse", "HEAD"], { timeout: 10_000, readOnly: true });
    return r.code === 0 ? r.stdout : null;
  },
  contains: async (src, a, b) => {
    const r = await git(src, ["merge-base", "--is-ancestor", a, b], { timeout: 30_000, readOnly: true });
    return r.code === 0 ? true : r.code === 1 ? false : null;
  },
  start: async (src, sha, unit, log, exit) => {
    const keep = (k: string) => (process.env[k] ? [`--setenv=${k}=${process.env[k]}`] : []);
    const p = Bun.spawn(
      [
        "systemd-run",
        "--user",
        "--quiet",
        "--collect",
        `--unit=${unit}`,
        `--working-directory=${src}`,
        ...keep("PATH"),
        ...keep("HOME"),
        ...keep("XDG_RUNTIME_DIR"),
        `--setenv=ANSAI_HOME=${config.dataDir}`,
        Bun.which("bash") ?? "/bin/bash",
        "-c",
        // The exit code lands in one step, so a half-written file is never read as the result.
        `scripts/release.sh "$1" >"$2" 2>&1; echo $? >"$3.tmp" && mv "$3.tmp" "$3"`,
        "ansai-release",
        sha,
        log,
        exit,
      ],
      { env: cleanEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    if (code !== 0) throw new Error(err.trim() || `systemd-run exited with code ${code}`);
  },
  active: async (unit) => {
    const p = Bun.spawn(["systemctl", "--user", "is-active", "--quiet", unit], { env: cleanEnv(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  },
  notify,
};
let deps = real_deps;
/** Tests: fakes for git, systemd and push (null puts the real ones back). */
export function setReleaseDeps(d: Partial<ReleaseDeps> | null) {
  deps = d ? { ...real_deps, ...d } : real_deps;
  source = undefined;
}

/** Whether merging into this project releases ansai: it's ansai's own checkout, and the setting is on. */
export function releasesOnMerge(projectId: string): boolean {
  if (!getSettings().releaseOnMerge) return false;
  const src = deps.source();
  const p = db.query("SELECT path FROM projects WHERE id = ?").get(projectId) as { path: string } | null;
  return !!src && !!p && real(p.path) === src;
}

/**
 * A task of ansai's own project was merged as `sha` onto `branch`: release it. A merge that
 * lands while a release runs waits for it, and the newest merge wins (it contains the
 * earlier ones). Returns whether a release is coming.
 */
export function releaseAfterMerge(task: { id: string; title: string; project_id: string | null }, sha: string, branch: string): boolean {
  if (!task.project_id || !releasesOnMerge(task.project_id)) return false;
  // releaseTick, every few seconds, starts it.
  setSetting(PENDING, { sha, branch, task: task.id, title: task.title, project: task.project_id, at: Date.now() } satisfies Job);
  return true;
}

const short = (sha: string) => sha.slice(0, 7);

/** The line of release.sh's output that says why it stopped. */
export function whyFailed(out: string, code: number | null): string {
  if (code === null) return "The release stopped before it finished (its process ended without a result).";
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const step = lines.find((l) => /^(?:packages|typecheck|tests|smoke test)\s+FAILED$/.test(l));
  const died = [...lines].reverse().find((l) => l.startsWith("release: "));
  const back = lines.find((l) => l.startsWith("The new version didn't come up:"));
  if (back) return `${back} ansai went back to the version from before.`;
  if (died) {
    const msg = died.slice("release: ".length).replace(/\.$/, "");
    return step ? `The ${step.replace(/\s+FAILED$/, "")} check failed, so nothing changed.` : `${msg[0]!.toUpperCase()}${msg.slice(1)}.`;
  }
  return lines.at(-1) ?? `release.sh exited with code ${code}.`;
}

function finish(job: Job, ok: boolean, why: string) {
  const r: Result = { sha: job.sha, branch: job.branch, task: job.task, title: job.title, ok, why, done: Date.now() };
  setSetting(LAST, r);
  console.log(`[ansai] self-release of ${short(job.sha)} (“${job.title}”): ${ok ? "live" : `not released: ${why}`}`);
  void deps
    .notify("system", ok
      ? { title: "ansai is updated", body: `Now running your merge of “${job.title}” (${short(job.sha)}). Pull to refresh.`, url: `/p/${job.project}`, tag: "self-release" }
      : { title: "ansai didn't update", body: `${why} Your merge of “${job.title}” is kept on ${job.branch}.`, url: `/p/${job.project}`, tag: "self-release" })
    .catch(() => {}); // push logs a device it couldn't reach; the result is kept in settings either way
}

let ticking = false;

/** Picks up a finished release, or starts the waiting one. Called every few seconds and right after a merge. */
export async function releaseTick(at = Date.now()) {
  if (ticking) return;
  ticking = true;
  try {
    const run = getSetting<Running | null>(RUNNING, null);
    if (run) {
      if (existsSync(exitFile())) {
        const code = Number(readFileSync(exitFile(), "utf8").trim());
        const out = existsSync(logFile()) ? readFileSync(logFile(), "utf8") : "";
        drop(RUNNING);
        rmSync(exitFile(), { force: true });
        if (code !== 0 && /another release is running/.test(out)) {
          // You (or an agent) started one by hand: try again after it, unless a newer merge is waiting already.
          if (!getSetting<Job | null>(PENDING, null)) setSetting(PENDING, { ...run, after: at + RETRY_MS } satisfies Job);
          return;
        }
        finish(run, code === 0, code === 0 ? "" : whyFailed(out, code));
      } else if (at - run.started > GRACE_MS && !(await deps.active(run.unit)) && !existsSync(exitFile())) {
        drop(RUNNING);
        finish(run, false, whyFailed("", null));
      }
      return;
    }

    const job = getSetting<Job | null>(PENDING, null);
    if (!job || (job.after && at < job.after)) return;
    const src = deps.source();
    if (!src) return drop(PENDING);
    const live = await deps.live();
    if (live && (await deps.contains(src, job.sha, live))) return drop(PENDING); // released by hand meanwhile
    if (live && (await deps.contains(src, live, job.sha)) !== true) {
      drop(PENDING);
      return finish(job, false, `The live version (${short(live)}) has commits your merge doesn't, so releasing it would take them out; release by hand to choose.`);
    }
    mkdirSync(dir(), { recursive: true });
    rmSync(exitFile(), { force: true });
    rmSync(logFile(), { force: true });
    const unit = `ansai-self-release-${at}`;
    drop(PENDING);
    try {
      await deps.start(src, job.sha, unit, logFile(), exitFile());
    } catch (e) {
      return finish(job, false, `Couldn't start the release: ${e instanceof Error ? e.message : String(e)}.`);
    }
    setSetting(RUNNING, { ...job, unit, started: at } satisfies Running);
    console.log(`[ansai] self-release: releasing ${short(job.sha)} (“${job.title}”) in ${unit}; output in ${logFile()}`);
  } finally {
    ticking = false;
  }
}

/** For the Settings sheet: whether this ansai releases on merge at all, and how the last one went. */
export function releaseStatus() {
  return {
    available: !!deps.source(),
    pending: getSetting<Job | null>(PENDING, null),
    running: getSetting<Running | null>(RUNNING, null),
    last: getSetting<Result | null>(LAST, null),
  };
}

export function startSelfRelease() {
  const tick = () => releaseTick().catch((e) => console.error("[ansai] self-release:", e));
  tick();
  setInterval(tick, 5000);
}
