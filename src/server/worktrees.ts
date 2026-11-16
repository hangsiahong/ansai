import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname } from "node:path";
import { join, relative, resolve } from "node:path";
import { config } from "./config";
import { db } from "./db";
import { emit } from "./events";
import { conflict } from "./errors";
import { git, type GitOpts } from "./git";

type WorktreeTask = { id: string; title: string; worktree_path: string | null; worktree_branch: string | null };
type Worktree = { path: string; branch: string; cwd: string; /** What a fresh worktree was given, for the agent's first prompt. */ notes: string[] };

const pending = new Map<string, Promise<Worktree | null>>();

async function ensure(task: WorktreeTask, projectPath: string): Promise<Worktree | null> {
  if (!Bun.which("git")) return null;
  const canonicalProject = realpathSync(projectPath);
  const rootResult = await git(canonicalProject, ["rev-parse", "--show-toplevel"]);
  // Keep non-Git projects working as they did before task worktrees existed.
  if (rootResult.code !== 0) return null;
  // A repo with no commits yet has nothing to branch from; use the project folder.
  if ((await git(canonicalProject, ["rev-parse", "--verify", "-q", "HEAD"])).code !== 0) return null;

  const repoRoot = resolve(rootResult.stdout);
  const projectSubdir = relative(repoRoot, canonicalProject);
  if (projectSubdir === ".." || projectSubdir.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("project path is outside its Git worktree");
  }

  let path = task.worktree_path;
  let branch = task.worktree_branch;
  let notes: string[] = [];
  if (path && branch && !existsSync(path)) {
    // The folder was removed (git worktree remove, rm -rf). Check the task's branch out
    // again so committed work carries on, or start over if the branch is gone too.
    await git(repoRoot, ["worktree", "prune"]);
    const hasBranch = (await git(repoRoot, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`])).code === 0;
    if (hasBranch) {
      const restored = await git(repoRoot, ["worktree", "add", path, branch]);
      if (restored.code !== 0) throw conflict(`could not restore task worktree: ${restored.stderr || restored.stdout}`);
      // A checkout has committed files only: give it .env and node_modules again, as a new one gets.
      notes = await provision(repoRoot, path);
    } else {
      path = null;
    }
  }
  if (path) {
    if (!branch) throw new Error("task worktree metadata is incomplete");
    // The agent would start in a folder where every git command fails.
    if (!(await connected(path))) throw conflict(`${CUT_OFF} Discard the task's worktree to start it afresh (its files are in ${path} until then).`);
  } else {
    const base = resolve(config.dataDir, "worktrees");
    mkdirSync(base, { recursive: true });
    path = join(base, task.id);
    branch = `ansai/${task.id}`;
    if (existsSync(path)) throw conflict(`worktree path already exists: ${path}`);

    const created = await git(repoRoot, ["worktree", "add", "-b", branch, path, "HEAD"]);
    if (created.code !== 0) throw new Error(`could not create task worktree: ${created.stderr || created.stdout}`);

    db.query("UPDATE tasks SET worktree_path = ?, worktree_branch = ? WHERE id = ?").run(path, branch, task.id);
    emit("tasks");
    notes = await provision(repoRoot, path);
  }

  return { path, branch, cwd: projectSubdir ? join(path, projectSubdir) : path, notes };
}

const ENV_FILE = /(^|\/)(\.env(\.[\w.-]+)?|\.dev\.vars)$/;
const MAX_ENV_FILES = 40;
const MAX_LINKS = 20;

/**
 * What a worktree is given must stay invisible to Git there, or a merge commits it.
 * A `node_modules/` rule (trailing slash) ignores folders only, not a symlink with
 * that name; and an env file is only ignored in the worktree if the rule for it was
 * committed (an unsaved .gitignore edit in the project folder isn't in the checkout),
 * so a copied secret would show up as a new file. Exclude whichever of these files
 * and links the worktree doesn't already ignore in the repo's info/exclude; each rule
 * is anchored to one path the main checkout already ignores, so nothing changes there.
 */
async function keepIgnored(path: string, rels: string[]) {
  const visible = [];
  for (const rel of rels) if ((await git(path, ["check-ignore", "-q", "--no-index", rel])).code !== 0) visible.push(rel);
  if (!visible.length) return;
  const common = await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.code !== 0) return;
  const file = join(common.stdout, "info", "exclude");
  try {
    mkdirSync(dirname(file), { recursive: true });
    const have = existsSync(file) ? readFileSync(file, "utf8") : "";
    // A rule is a pattern: escape what would otherwise be read as a wildcard (a folder named "[id]").
    const add = visible.map((r) => `/${r.replace(/[\\*?[\]]/g, "\\$&")}`).filter((l) => !have.split("\n").includes(l));
    if (add.length) appendFileSync(file, `${have && !have.endsWith("\n") ? "\n" : ""}# ansai: task worktrees are given these (copied or linked)\n${add.join("\n")}\n`);
  } catch {}
}

/**
 * A new worktree only has committed files. Give it what the project folder has
 * that Git ignores but the code needs to run: local env files are copied, and
 * installed dependencies (node_modules) are linked rather than reinstalled.
 * Returns notes for the agent (what was set up, and uncommitted work it lacks).
 */
async function provision(repoRoot: string, path: string): Promise<string[]> {
  const notes: string[] = [];
  // --directory lists an ignored folder once ("node_modules/") instead of every file inside it.
  const ls = await git(repoRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
  if (ls.code === 0) {
    const entries = ls.stdout.split("\0").filter(Boolean);
    const envs = entries.filter((e) => !e.endsWith("/") && ENV_FILE.test(e)).slice(0, MAX_ENV_FILES);
    const mods = entries.filter((e) => e.endsWith("/") && /(^|\/)node_modules\/$/.test(e)).slice(0, MAX_LINKS);
    const copied: string[] = [];
    for (const e of envs) {
      try {
        mkdirSync(dirname(join(path, e)), { recursive: true });
        copyFileSync(join(repoRoot, e), join(path, e));
        copied.push(e);
      } catch {}
    }
    const linked: string[] = [];
    for (const e of mods) {
      const rel = e.slice(0, -1);
      const target = join(path, rel);
      if (existsSync(target)) continue;
      try {
        mkdirSync(dirname(target), { recursive: true });
        symlinkSync(join(repoRoot, rel), target, "dir");
        linked.push(rel);
      } catch {}
    }
    await keepIgnored(path, [...copied, ...linked]);
    if (copied.length) notes.push(`Copied from the project folder (Git ignores them): ${copied.join(", ")}.`);
    if (linked.length)
      notes.push(
        `${linked.join(", ")} ${linked.length === 1 ? "is a link" : "are links"} to the project folder's installed dependencies, so you can build and test right away. They are shared: don't reinstall or upgrade packages there unless the task needs it.`,
      );
  }
  const dirty = await git(repoRoot, ["status", "--porcelain", "--untracked-files=normal"]);
  const n = dirty.code === 0 && dirty.stdout ? dirty.stdout.split("\n").length : 0;
  if (n)
    notes.push(
      `The project folder had ${n} uncommitted change${n === 1 ? "" : "s"} when this worktree was made; ${n === 1 ? "it isn't" : "they aren't"} in your worktree, which starts from the last commit.`,
    );
  return notes;
}

const worktreeProjects = new Map<string, { at: number; yes: boolean }>();

/**
 * Whether tasks in this project get their own worktree: a Git repo with at least one
 * commit (the same test ensure() makes). Cached for a minute; autopilot asks every tick.
 */
export async function usesWorktrees(projectPath: string): Promise<boolean> {
  const hit = worktreeProjects.get(projectPath);
  if (hit && Date.now() - hit.at < 60_000) return hit.yes;
  let yes = false;
  if (Bun.which("git")) {
    try {
      const dir = realpathSync(projectPath);
      yes = (await git(dir, ["rev-parse", "--show-toplevel"])).code === 0 && (await git(dir, ["rev-parse", "--verify", "-q", "HEAD"])).code === 0;
    } catch {}
  }
  worktreeProjects.set(projectPath, { at: Date.now(), yes });
  return yes;
}

/** Create or reuse the task's dedicated Git worktree. Non-Git projects return null. */
export function ensureTaskWorktree(task: WorktreeTask, projectPath: string): Promise<Worktree | null> {
  const active = pending.get(task.id);
  if (active) return active;
  const work = ensure(task, projectPath).finally(() => pending.delete(task.id));
  pending.set(task.id, work);
  return work;
}

// ------------------------------------------------------------ merge & clean up

const MINUTE: GitOpts = { timeout: 60_000 };

type TaskRef = { id: string; title: string; summary: string | null; worktree_path: string | null; worktree_branch: string | null };

/** Any folder of the worktree's repository to run `git worktree`/`git branch` from: the first entry of `git worktree list` (it may be bare). */
async function mainCheckout(worktree: string): Promise<{ path: string; branch: string | null }> {
  const list = await git(worktree, ["worktree", "list", "--porcelain"], MINUTE);
  if (list.code !== 0) throw conflict(`git: ${list.stderr}`);
  const first = list.stdout.split("\n\n")[0] ?? "";
  const path = first.match(/^worktree (.+)$/m)?.[1];
  if (!path) throw conflict("couldn't find the project's main checkout");
  return { path, branch: first.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null };
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

export type Checkout = { path: string; branch: string | null; head: string | null };

/**
 * The checkout a task's worktree was made from and goes back into: its project's own
 * folder, with whatever branch that has checked out now. Null when `dir` isn't in a task
 * worktree of a project ansai still has, or the project's folder is gone or is another
 * repository.
 *
 * This used to be "the first entry of `git worktree list`", the repository's main
 * checkout. That is a different folder when the project is itself a linked worktree
 * (ansai's scan adds those as projects): the task branched from the project's `feature`,
 * but Merge put it on `main` in the other folder, taking feature's unreleased commits
 * along. And a bare repository with worktrees beside it has no main checkout at all, so
 * Merge always answered "detached HEAD" and Code changes hid the agent's commits.
 */
export async function projectCheckout(dir: string): Promise<Checkout | null> {
  const row = db
    .query(
      `SELECT p.path FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.worktree_path IS NOT NULL AND (t.worktree_path = ? OR substr(?, 1, length(t.worktree_path) + 1) = t.worktree_path || '/')`,
    )
    .get(dir, dir) as { path: string } | null;
  if (!row || !existsSync(row.path)) return null;
  const top = await git(row.path, ["rev-parse", "--show-toplevel"], MINUTE);
  if (top.code !== 0) return null;
  // The same repository, and not the task's worktree itself.
  const [mine, theirs, here] = await Promise.all([
    git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], MINUTE),
    git(top.stdout, ["rev-parse", "--path-format=absolute", "--git-common-dir"], MINUTE),
    git(dir, ["rev-parse", "--show-toplevel"], MINUTE),
  ]);
  if (mine.code !== 0 || theirs.code !== 0 || here.code !== 0 || real(mine.stdout) !== real(theirs.stdout) || real(here.stdout) === real(top.stdout)) return null;
  return checkoutAt(top.stdout);
}

async function checkoutAt(path: string): Promise<Checkout> {
  const [ref, head] = await Promise.all([git(path, ["symbolic-ref", "-q", "HEAD"], MINUTE), git(path, ["rev-parse", "--verify", "-q", "HEAD"], MINUTE)]);
  return { path, branch: ref.code === 0 && ref.stdout.startsWith("refs/heads/") ? ref.stdout.slice("refs/heads/".length) : null, head: head.code === 0 ? head.stdout : null };
}

/**
 * Where Merge puts a task's work: the project's own folder. For a task with no project
 * left to ask, the repository's main checkout; a bare repository has none, and picking
 * one of the worktrees beside it would be a guess.
 */
async function mergeTarget(wt: string): Promise<Checkout> {
  const own = await projectCheckout(wt);
  if (own) return own;
  const list = await git(wt, ["worktree", "list", "--porcelain"], MINUTE);
  if (list.code !== 0) throw conflict(`git: ${list.stderr}`);
  const first = list.stdout.split("\n\n")[0] ?? "";
  const path = first.match(/^worktree (.+)$/m)?.[1];
  if (!path) throw conflict("couldn't find the project's main checkout");
  if (/^bare$/m.test(first))
    throw conflict("can't tell which folder to merge into: this task's project folder is no longer in ansai (or is gone), and its repository is a bare one with several checkouts. Add the folder back as a project, then merge again.");
  return checkoutAt(path);
}

const CUT_OFF = "This task's worktree is cut off from its project: the project folder was moved, renamed or deleted.";

/**
 * Whether the task's worktree still belongs to a repository. Its `.git` file names the
 * project's repository by path, so moving, renaming or deleting the project folder cuts it
 * off: every git command in it fails, and Merge, Discard and deleting the task answered
 * "gitfile does not point to a valid repository" for ever. If the repository is at one of
 * ansai's projects now (the folder is back, or was added again where it moved to), git
 * repairs the link from that side; it refuses a repository the worktree isn't from.
 */
async function connected(wt: string): Promise<boolean> {
  const probe = () => git(wt, ["rev-parse", "--git-dir"], MINUTE);
  const first = await probe();
  if (first.code === 0) return true;
  // Anything else (git timed out, a permissions complaint) says nothing about the link: carry
  // on as before and let the command that needs git report it.
  if (!/not a git repository|gitfile does not point/i.test(first.stderr)) return true;
  for (const p of db.query("SELECT path FROM projects").all() as { path: string }[]) {
    if (!existsSync(p.path)) continue;
    if ((await git(p.path, ["worktree", "repair", wt], MINUTE)).code === 0 && (await probe()).code === 0) return true;
  }
  return false;
}

function forget(taskId: string) {
  db.query("UPDATE tasks SET worktree_path = NULL, worktree_branch = NULL WHERE id = ?").run(taskId);
  emit("tasks");
}

type OpenSession = { id: string; agent_state: string | null };

/** Running sessions on the task, which may be in its worktree (a finished review's doesn't count). */
function openSessions(taskId: string) {
  return db.query(`SELECT s.id, s.agent_state FROM sessions s WHERE s.task_id = ? AND s.status = 'running'
    AND NOT EXISTS (SELECT 1 FROM task_reviews r WHERE r.session_id = s.id AND r.status = 'complete')`).all(taskId) as OpenSession[];
}

/** Mid-turn: working, or paused on an approval. Closing it would cut its work off. */
const midTurn = (s: OpenSession) => s.agent_state === "working" || s.agent_state === "needs-input";
/**
 * Idle for sure: it finished a turn and waits for you. A session with no state yet is not
 * known to be idle: a Codex on its first turn has none while it works (it only says when a
 * turn ends), and agy never has one. Those are never closed for you.
 */
const idle = (s: OpenSession) => s.agent_state === "waiting";
const STILL_WORKING = "the agent is still working on this task; wait for it to finish (or stop it) first";

/** Close these sessions; one that won't close is logged and the rest still are. Returns how many closed. */
async function closeAll(sessions: OpenSession[], close: (sessionId: string) => Promise<void>) {
  let closed = 0;
  for (const s of sessions) {
    try {
      await close(s.id);
      closed++;
    } catch (e) {
      console.error(`[ansai] couldn't close session ${s.id}:`, e);
    }
  }
  return closed;
}

/**
 * What removing the task's worktree would lose, in words (null: nothing): uncommitted or
 * untracked files in the folder, or commits that no other branch or remote has (on the
 * task's branch or at the worktree's HEAD). Git failing to answer throws. The folder must
 * exist and be connected to its repository.
 */
async function unsavedWork(wt: string, branch: string): Promise<string | null> {
  const status = await git(wt, ["status", "--porcelain"], MINUTE);
  if (status.code !== 0) throw conflict(`git: ${status.stderr}`);
  if (status.stdout) return "this task's worktree has uncommitted changes; merge or discard it first";
  const tips = ["HEAD"];
  if ((await git(wt, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], MINUTE)).code === 0) tips.push(`refs/heads/${branch}`);
  const unmerged = await git(wt, ["rev-list", "--count", ...tips, "--not", `--exclude=${branch}`, "--branches", "--remotes"], MINUTE);
  if (unmerged.code !== 0) throw conflict(`git: ${unmerged.stderr}`);
  if (unmerged.stdout !== "0") return "this task's branch has unmerged commits; merge or discard it first";
  return null;
}

/**
 * Before a task is deleted: remove its worktree and branch, but only when that loses
 * nothing. Unlike Discard (an explicit "throw this away"), this refuses while an agent
 * session is open on the task, while the folder has uncommitted changes, or while the
 * branch (or the worktree's HEAD) has commits that no other branch or remote has.
 */
export async function removeTaskWorktreeSafely(task: TaskRef) {
  const wt = task.worktree_path;
  const branch = task.worktree_branch;
  if (!wt || !branch) return;
  if (openSessions(task.id).length) throw conflict("an agent session is still open on this task; close it first (deleting the task removes its worktree)");
  // The folder is already gone: Discard then only forgets it and leaves the branch alone.
  if (!existsSync(wt)) return discardTaskWorktree(task);
  // Cut off from its project: git can't say what is unmerged, and the branch (in the project's
  // repository, wherever that is now) isn't ours to reach. Forget it and leave the files be.
  if (!(await connected(wt))) {
    console.warn(`[ansai] deleted task "${task.title}" left its worktree folder behind (its project folder moved or is gone): ${wt}`);
    return forget(task.id);
  }
  const lost = await unsavedWork(wt, branch);
  if (lost) throw conflict(lost);
  await discardTaskWorktree(task);
}

/** What `cleanUpDoneTask` cleared: how many agents it closed, and whether the worktree (and its branch) went too. */
export type DoneCleanup = { agents: number; worktree: boolean };

/**
 * A task was marked Done. Its worktree and branch are no longer needed, and neither are its
 * idle agents (each holds around 500 MB), but only when nothing can be lost:
 * - every agent session open on the task is known to be idle (a finished turn, waiting). One
 *   that is mid-turn, or whose state ansai doesn't know, may still be working: everything stays;
 * - the folder holds nothing unsaved (see `unsavedWork`), so a worktree with work in it stays;
 * - a folder that is gone or cut off from its repository stays as it is: git can't say what
 *   is in it, and a rerun of the task needs the branch it names.
 * All of that is decided before anything is closed, so an agent is never closed for a
 * worktree that then stays. An agent that won't close keeps the worktree too (it is in there).
 *
 * Returns what it cleared (null: nothing). It never throws: marking a task Done has to
 * succeed whatever happens here, so trouble is logged.
 */
export async function cleanUpDoneTask(task: TaskRef, close: (sessionId: string) => Promise<void>): Promise<DoneCleanup | null> {
  const wt = task.worktree_path;
  const branch = task.worktree_branch;
  if (!wt || !branch) return null;
  let closed = 0;
  try {
    const open = openSessions(task.id);
    if (!open.every(idle)) return null;
    if (!existsSync(wt) || !(await connected(wt))) return null;
    if (await unsavedWork(wt, branch)) return null;
    closed = await closeAll(open, close);
    if (closed === open.length) {
      await discardTaskWorktree(task);
      return { agents: closed, worktree: true };
    }
  } catch (e) {
    console.error(`[ansai] couldn't clear the worktree of "${task.title}" after it was marked done:`, e);
  }
  return closed ? { agents: closed, worktree: false } : null;
}

/** Remove the task's worktree folder and its branch (whatever is in them is gone). */
export async function discardTaskWorktree(task: TaskRef) {
  if (!task.worktree_path || !task.worktree_branch) throw conflict("this task has no worktree");
  if (!existsSync(task.worktree_path)) return forget(task.id);
  if (!(await connected(task.worktree_path))) {
    // No repository to remove it from: throw the folder away ourselves (only one ansai made).
    const mine = resolve(config.dataDir, "worktrees");
    if (resolve(task.worktree_path).startsWith(`${mine}/`)) rmSync(task.worktree_path, { recursive: true, force: true });
    return forget(task.id);
  }
  const { path: main } = await mainCheckout(task.worktree_path);
  const rm = await git(main, ["worktree", "remove", "--force", task.worktree_path], MINUTE);
  if (rm.code !== 0) throw conflict(`couldn't remove the worktree: ${rm.stderr}`);
  await git(main, ["branch", "-D", task.worktree_branch], MINUTE);
  forget(task.id);
}

/**
 * Discard, as the web UI asks for it: throw the task's worktree and branch away. An agent
 * mid-turn refuses; an idle one is closed first, since its next reply would run in a
 * deleted folder.
 */
export async function discardTaskWorktreeClosingAgents(task: TaskRef, close: (sessionId: string) => Promise<void>) {
  if (!task.worktree_path || !task.worktree_branch) throw conflict("this task has no worktree");
  const open = openSessions(task.id);
  if (open.some(midTurn)) throw conflict(STILL_WORKING);
  if (!open.every(idle)) throw conflict("an agent session is still open on this task, and ansai can't tell whether it is idle; close it first");
  await closeAll(open, close);
  await discardTaskWorktree(task);
}

/**
 * Bring a task's work into the project: commit what the agent left uncommitted
 * on its branch, squash-merge the branch into the branch the project's folder has
 * checked out, as one commit (titled after the task), then remove the worktree and
 * branch. Refuses rather than guessing: the project folder must be on a branch with no
 * uncommitted changes to tracked files, and conflicts are rolled back. It also
 * refuses when removing the worktree would delete work the merge didn't bring:
 * the worktree isn't on the task's branch, or it holds a nested Git repository.
 *
 * An agent mid-turn always refuses, and so does one whose state ansai doesn't know. An idle
 * agent (it finished its turn and waits) refuses unless `close` is given: then it is closed,
 * but only once the squash commit has landed, so a refusal or a conflict leaves it open (and
 * the worktree as it was) to be asked for a fix.
 */
export async function mergeTaskWorktree(task: TaskRef, o: { close?: (sessionId: string) => Promise<void> } = {}): Promise<{ sha: string; into: string; files: number }> {
  const wt = task.worktree_path;
  const branch = task.worktree_branch;
  if (!wt || !branch || !existsSync(wt)) throw conflict("this task has no worktree to merge");
  // Merging removes the worktree folder, so no agent may still be in it: not one
  // mid-turn (working, or paused on an approval), and not an idle one either, whose
  // next reply would run in a deleted folder. An idle one is closed after the merge when we may.
  const open = openSessions(task.id);
  if (open.some(midTurn)) throw conflict(STILL_WORKING);
  if (open.length && (!o.close || !open.every(idle))) throw conflict("close the agent's session first: merging removes its worktree folder");
  if (!(await connected(wt)))
    throw conflict(`${CUT_OFF} There is nothing to merge into until the folder is back where it was, or added to ansai where it is now. The task's files are still in ${wt}.`);
  const main = await mergeTarget(wt);
  if (!main.branch) throw conflict(`the project folder (${main.path}) isn't on a branch (detached HEAD), so there's nothing to merge into`);
  const dirty = await git(main.path, ["status", "--porcelain", "--untracked-files=no"], MINUTE);
  if (dirty.stdout) {
    const n = dirty.stdout.split("\n").length;
    throw conflict(`the project folder has uncommitted changes in ${n} file${n === 1 ? "" : "s"}; commit or stash them first, then merge`);
  }

  // Only the task's branch is merged, and the worktree is removed afterwards. If the
  // agent left the worktree on anything else (a detached HEAD, a branch of its own),
  // its newest commits and the WIP commit below would be on that instead: left out of
  // the merge and then deleted.
  const head = await git(wt, ["symbolic-ref", "-q", "HEAD"], MINUTE);
  if (head.code !== 0 || head.stdout !== `refs/heads/${branch}`) {
    if (head.code > 1) throw conflict(`git: ${head.stderr}`);
    const at = (await git(wt, ["rev-parse", "--short", "HEAD"], MINUTE)).stdout;
    const where = head.code === 0 ? `is on branch ${head.stdout.replace(/^refs\/heads\//, "")}, not ${branch},` : `isn't on a branch (detached HEAD${at ? ` at ${at}` : ""}),`;
    throw conflict(`the task's worktree ${where} so merging would leave its latest work behind. Ask the agent to put its work on ${branch} and switch back to that branch, then merge again.`);
  }
  // Same for a repository nested in the worktree that the agent already committed as a pointer.
  const base = await git(wt, ["merge-base", `refs/heads/${main.branch}`, `refs/heads/${branch}`], MINUTE);
  const committed = await git(wt, ["diff-tree", "-r", "--raw", "-z", "--no-renames", base.code === 0 ? base.stdout : `refs/heads/${main.branch}`, `refs/heads/${branch}`], MINUTE);
  if (committed.code !== 0) throw conflict(`git: ${committed.stderr}`);
  const pointers = newGitlinks(committed.stdout);
  if (pointers.length) throw nestedRepository(pointers);

  // 1. Whatever the agent didn't commit becomes one commit on its branch.
  const pending = await git(wt, ["status", "--porcelain"], MINUTE);
  let wip = false;
  if (pending.stdout) {
    const add = await git(wt, ["add", "-A"], MINUTE);
    if (add.code !== 0) {
      // Nothing was staged (git add is all or nothing). The usual cause is a nested
      // repository with no commits yet (`git init`), which Git lists as a folder.
      const others = await git(wt, ["ls-files", "--others", "--exclude-standard", "-z"], MINUTE);
      const repos = others.stdout.split("\0").filter((p) => p.endsWith("/")).map((p) => p.slice(0, -1));
      throw repos.length ? nestedRepository(repos) : conflict(`couldn't stage the task's work: ${add.stderr || add.stdout}`);
    }
    const index = await git(wt, ["diff-index", "--cached", "--raw", "-z", "--no-renames", "HEAD"], MINUTE);
    const repos = newGitlinks(index.stdout);
    if (index.code !== 0 || repos.length) {
      await git(wt, ["reset", "-q"], MINUTE);
      throw repos.length ? nestedRepository(repos) : conflict(`git: ${index.stderr}`);
    }
    const c = await git(wt, ["commit", "-q", "-m", `WIP: ${task.title}`, "-m", "Uncommitted work, committed by ansai before merging."], MINUTE);
    if (c.code !== 0) {
      await git(wt, ["reset", "-q"], MINUTE);
      throw conflict(`couldn't commit the task's work: ${c.stderr || c.stdout}`);
    }
    wip = true;
  }

  // 2. Squash it onto the main branch. If that's refused, take the WIP commit back
  // off, so the worktree is left exactly as the agent had it.
  let sha: string;
  let staged: string[];
  try {
    ({ sha, staged } = await squash(main.path, main.branch, branch, task, open.length > 0));
  } catch (e) {
    if (wip) await git(wt, ["reset", "-q", "HEAD~1"], MINUTE);
    throw e;
  }

  // 3. The branch is merged (as one commit): close the idle agents that were in the worktree, then drop it and the branch.
  if (o.close) await closeAll(open, o.close);
  await discardTaskWorktree(task).catch((e) => console.error("[ansai] worktree cleanup after merge:", e));
  return { sha, into: main.branch, files: staged.length };
}

/**
 * Paths that a raw diff (`diff-index`/`diff-tree --raw -z --no-renames`) shows becoming
 * a gitlink (mode 160000): a folder with its own Git repository, which Git records as
 * a pointer to a commit, with none of its files. A submodule that was already tracked
 * is 160000 on both sides and isn't listed.
 */
function newGitlinks(raw: string): string[] {
  const parts = raw.split("\0");
  const found: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const mode = /^:(\d+) (\d+) /.exec(parts[i]!);
    if (mode && mode[2] === "160000" && mode[1] !== "160000") found.push(parts[i + 1]!);
  }
  return found;
}

/** Merging these would keep a pointer and then delete the only copy of the files with the worktree. */
function nestedRepository(paths: string[]) {
  const one = paths.length === 1;
  return conflict(
    `${paths.slice(0, 5).join(", ")}${paths.length > 5 ? "…" : ""} ${one ? "has its" : "have their"} own Git repository inside the task's worktree, and a merge would not carry ${one ? "its" : "their"} files over (only a pointer to ${one ? "it" : "them"}). ` +
      `Ask the agent to make ${one ? "it an ordinary folder" : "them ordinary folders"} of the project (remove the .git inside) or move ${one ? "it" : "them"} out of the worktree, then merge again.`,
  );
}

/** `agentOpen`: a session is still open on the task, so a conflict can be handed back to it. */
async function squash(mainPath: string, mainBranch: string, branch: string, task: TaskRef, agentOpen: boolean): Promise<{ sha: string; staged: string[] }> {
  const ahead = await git(mainPath, ["rev-list", "--count", `${mainBranch}..${branch}`], MINUTE);
  if (ahead.code === 0 && ahead.stdout === "0") throw conflict(`nothing to merge: ${branch} has no commits that ${mainBranch} doesn't have`);
  const sq = await git(mainPath, ["merge", "--squash", branch], MINUTE);
  if (sq.code !== 0) {
    const conflicted = (await git(mainPath, ["diff", "--name-only", "--diff-filter=U"], MINUTE)).stdout.split("\n").filter(Boolean);
    await git(mainPath, ["reset", "--merge"], MINUTE);
    const fix = agentOpen
      ? `Ask the agent to rebase ${branch} on ${mainBranch}, then merge again.`
      : `No agent is open on this task: pick its last session back up (or run the task again), ask it to rebase ${branch} on ${mainBranch}, then merge again.`;
    throw conflict(
      conflicted.length
        ? `merging would conflict in ${conflicted.slice(0, 5).join(", ")}${conflicted.length > 5 ? "…" : ""}. ${fix}`
        : `git merge failed: ${sq.stderr || sq.stdout}`,
    );
  }
  const staged = (await git(mainPath, ["diff", "--cached", "--name-only"], MINUTE)).stdout.split("\n").filter(Boolean);
  if (!staged.length) throw conflict(`nothing to merge: ${mainBranch} already has these changes`);
  const msg = [task.title, task.summary?.trim() ?? "", `ansai task ${task.id} (branch ${branch})`].filter(Boolean);
  const commit = await git(mainPath, ["commit", "-q", ...msg.flatMap((m) => ["-m", m])], MINUTE);
  if (commit.code !== 0) {
    await git(mainPath, ["reset", "--merge"], MINUTE);
    throw conflict(`couldn't commit the merge: ${commit.stderr || commit.stdout}`);
  }
  return { sha: (await git(mainPath, ["rev-parse", "HEAD"], MINUTE)).stdout, staged };
}
