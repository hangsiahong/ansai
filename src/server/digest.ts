import { db, getSetting, now, setSetting } from "./db";
import { shiftView, type ShiftView } from "./shifts";

/**
 * "While you were away": what the agents got done since you last looked.
 * Tasks that reached Review or Done, follow-ups the agents filed, shifts that
 * ended, team messages, and the commits made in each project they worked in.
 * "Last looked" is shared across your devices (a setting), so clearing it on
 * the phone clears it on the laptop too.
 */

const SEEN_KEY = "digestSeenAt";
/** Without a "seen" mark yet, look back this far. */
const DEFAULT_LOOKBACK = 12 * 3600_000;
const MAX_PROJECTS = 12;
const COMMITS_SHOWN = 8;

export type DigestCommit = { sha: string; subject: string; at: number };
export type DigestProject = {
  projectId: string;
  name: string;
  /** The branch checked out in the project folder, and the commits on it since then. */
  branch: string | null;
  count: number;
  commits: DigestCommit[];
  /** Commits on other local branches (task worktrees) that aren't on that branch yet. */
  unmerged: number;
};
export type Digest = {
  since: number;
  /** Tasks that moved to Review or Done since then (newest first). */
  finished: string[];
  /** Tasks agents added to the backlog since then. */
  filed: string[];
  shifts: (ShiftView & { title: string })[];
  messages: number;
  projects: DigestProject[];
};

export function seenAt(): number {
  const v = getSetting<number | null>(SEEN_KEY, null);
  return typeof v === "number" && v > 0 ? v : now() - DEFAULT_LOOKBACK;
}

export function markSeen(at = now()) {
  setSetting(SEEN_KEY, at);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  const timer = setTimeout(() => p.kill(), 4000);
  const out = await new Response(p.stdout).text();
  clearTimeout(timer);
  return (await p.exited) === 0 ? out : "";
}

const parseLog = (out: string): DigestCommit[] =>
  out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, ct, ...rest] = line.split("\t");
      return { sha: sha!, at: Number(ct) * 1000, subject: rest.join("\t") };
    });

/** Commits on the checked-out branch since `since`, plus ones on task branches that haven't landed there. */
async function projectCommits(path: string, since: number) {
  const after = `--since=@${Math.floor(since / 1000)}`;
  const [branch, onHead, elsewhere] = await Promise.all([
    git(path, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(path, ["log", "HEAD", after, "--no-merges", "--format=%h%x09%ct%x09%s", "-n", "500"]),
    git(path, ["log", "--branches", "--not", "HEAD", after, "--no-merges", "--format=%h", "-n", "500"]),
  ]);
  const commits = parseLog(onHead);
  const b = branch.trim();
  return {
    branch: b && b !== "HEAD" ? b : null,
    count: commits.length,
    commits: commits.slice(0, COMMITS_SHOWN),
    unmerged: elsewhere.split("\n").filter(Boolean).length,
  };
}

export async function digest(since = seenAt()): Promise<Digest> {
  const finished = (
    db
      .query(`SELECT id FROM tasks WHERE status IN ('review', 'done') AND COALESCE(done_at, updated_at) >= ? ORDER BY COALESCE(done_at, updated_at) DESC LIMIT 50`)
      .all(since) as { id: string }[]
  ).map((r) => r.id);
  const filed = (
    db.query(`SELECT id FROM tasks WHERE source = 'agent' AND created_at >= ? ORDER BY created_at DESC LIMIT 50`).all(since) as { id: string }[]
  ).map((r) => r.id);
  const shifts = (
    db
      .query(`SELECT sh.session_id, s.title FROM shifts sh JOIN sessions s ON s.id = sh.session_id WHERE sh.ended_at >= ? ORDER BY sh.ended_at DESC LIMIT 20`)
      .all(since) as { session_id: string; title: string }[]
  ).flatMap((r) => {
    const v = shiftView(r.session_id);
    return v ? [{ ...v, title: r.title }] : [];
  });
  const messages = (db.query("SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?").get(since) as { n: number }).n;

  // Projects where an agent was around since then.
  const active = db
    .query(
      `SELECT DISTINCT p.id, p.name, p.path FROM projects p JOIN sessions s ON s.project_id = p.id
       WHERE s.tool != 'shell' AND (s.created_at >= ? OR s.status = 'running' OR COALESCE(s.ended_at, 0) >= ? OR COALESCE(s.agent_state_at, 0) >= ?)
       LIMIT ?`,
    )
    .all(since, since, since, MAX_PROJECTS) as { id: string; name: string; path: string }[];
  const projects = (
    await Promise.all(
      active.map(async (p) => {
        const c = await projectCommits(p.path, since).catch(() => ({ branch: null, count: 0, commits: [], unmerged: 0 }));
        return { projectId: p.id, name: p.name, ...c };
      }),
    )
  )
    .filter((p) => p.count > 0 || p.unmerged > 0)
    .sort((a, b) => b.count - a.count);

  return { since, finished, filed, shifts, messages, projects };
}
