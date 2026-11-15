import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { dirname } from "node:path";
import { join, relative, resolve } from "node:path";
import { config, cleanEnv } from "./config";
import { db } from "./db";
import { emit } from "./events";
import { conflict } from "./errors";

type WorktreeTask = { id: string; title: string; worktree_path: string | null; worktree_branch: string | null };
type Worktree = { path: string; branch: string; cwd: string; /** What a fresh worktree was given, for the agent's first prompt. */ notes: string[] };

const pending = new Map<string, Promise<Worktree | null>>();

async function git(args: string[]) {
  const proc = Bun.spawn(["git", ...args], {
    env: cleanEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function ensure(task: WorktreeTask, projectPath: string): Promise<Worktree | null> {
  if (!Bun.which("git")) return null;
  const canonicalProject = realpathSync(projectPath);
  const rootResult = await git(["-C", canonicalProject, "rev-parse", "--show-toplevel"]);
  // Keep non-Git projects working as they did before task worktrees existed.
  if (rootResult.code !== 0) return null;
  // A repo with no commits yet has nothing to branch from; use the project folder.
  if ((await git(["-C", canonicalProject, "rev-parse", "--verify", "-q", "HEAD"])).code !== 0) return null;

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
    await git(["-C", repoRoot, "worktree", "prune"]);
    const hasBranch = (await git(["-C", repoRoot, "rev-parse", "--verify", "-q", `refs/heads/${branch}`])).code === 0;
    if (hasBranch) {
      const restored = await git(["-C", repoRoot, "worktree", "add", path, branch]);
      if (restored.code !== 0) throw conflict(`could not restore task worktree: ${restored.stderr || restored.stdout}`);
    } else {
      path = null;
    }
  }
  if (path) {
    if (!branch) throw new Error("task worktree metadata is incomplete");
  } else {
    const base = resolve(config.dataDir, "worktrees");
    mkdirSync(base, { recursive: true });
    path = join(base, task.id);
    branch = `ansai/${task.id}`;
    if (existsSync(path)) throw conflict(`worktree path already exists: ${path}`);

    const created = await git(["-C", repoRoot, "worktree", "add", "-b", branch, path, "HEAD"]);
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
 * A `node_modules/` rule (trailing slash) ignores folders only, not a symlink with
 * that name, which would then show up as a new file (and get committed on merge).
 * Exclude such links in the repo's info/exclude; the anchored rule matches what the
 * main checkout already ignores, so nothing changes there.
 */
async function keepIgnored(path: string, rels: string[]) {
  const visible = [];
  for (const rel of rels) if ((await git(["-C", path, "check-ignore", "-q", "--no-index", rel])).code !== 0) visible.push(rel);
  if (!visible.length) return;
  const common = await git(["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.code !== 0) return;
  const file = join(common.stdout, "info", "exclude");
  try {
    mkdirSync(dirname(file), { recursive: true });
    const have = existsSync(file) ? readFileSync(file, "utf8") : "";
    const add = visible.map((r) => `/${r}`).filter((l) => !have.split("\n").includes(l));
    if (add.length) appendFileSync(file, `${have && !have.endsWith("\n") ? "\n" : ""}# ansai: task worktrees link these\n${add.join("\n")}\n`);
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
  const ls = await git(["-C", repoRoot, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
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
    await keepIgnored(path, linked);
    if (copied.length) notes.push(`Copied from the project folder (Git ignores them): ${copied.join(", ")}.`);
    if (linked.length)
      notes.push(
        `${linked.join(", ")} ${linked.length === 1 ? "is a link" : "are links"} to the project folder's installed dependencies, so you can build and test right away. They are shared: don't reinstall or upgrade packages there unless the task needs it.`,
      );
  }
  const dirty = await git(["-C", repoRoot, "status", "--porcelain", "--untracked-files=normal"]);
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
      yes = (await git(["-C", dir, "rev-parse", "--show-toplevel"])).code === 0 && (await git(["-C", dir, "rev-parse", "--verify", "-q", "HEAD"])).code === 0;
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

type TaskRef = { id: string; title: string; summary: string | null; worktree_path: string | null; worktree_branch: string | null };

async function gitIn(dir: string, args: string[], timeout = 60_000) {
  const proc = Bun.spawn(["git", "-C", dir, ...args], { env: cleanEnv(), stdout: "pipe", stderr: "pipe", timeout });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** The main checkout (first entry of `git worktree list`) and the branch it has checked out. */
async function mainCheckout(worktree: string): Promise<{ path: string; branch: string | null }> {
  const list = await gitIn(worktree, ["worktree", "list", "--porcelain"]);
  if (list.code !== 0) throw conflict(`git: ${list.stderr}`);
  const first = list.stdout.split("\n\n")[0] ?? "";
  const path = first.match(/^worktree (.+)$/m)?.[1];
  if (!path) throw conflict("couldn't find the project's main checkout");
  return { path, branch: first.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null };
}

function forget(taskId: string) {
  db.query("UPDATE tasks SET worktree_path = NULL, worktree_branch = NULL WHERE id = ?").run(taskId);
  emit("tasks");
}

/** Remove the task's worktree folder and its branch (whatever is in them is gone). */
export async function discardTaskWorktree(task: TaskRef) {
  if (!task.worktree_path || !task.worktree_branch) throw conflict("this task has no worktree");
  if (!existsSync(task.worktree_path)) return forget(task.id);
  const { path: main } = await mainCheckout(task.worktree_path);
  const rm = await gitIn(main, ["worktree", "remove", "--force", task.worktree_path]);
  if (rm.code !== 0) throw conflict(`couldn't remove the worktree: ${rm.stderr}`);
  await gitIn(main, ["branch", "-D", task.worktree_branch]);
  forget(task.id);
}

/**
 * Bring a task's work into the project: commit what the agent left uncommitted
 * on its branch, squash-merge the branch into the main checkout's branch as one
 * commit (titled after the task), then remove the worktree and branch.
 * Refuses rather than guessing: the main checkout must be on a branch with no
 * uncommitted changes to tracked files, and conflicts are rolled back.
 */
export async function mergeTaskWorktree(task: TaskRef): Promise<{ sha: string; into: string; files: number }> {
  const wt = task.worktree_path;
  const branch = task.worktree_branch;
  if (!wt || !branch || !existsSync(wt)) throw conflict("this task has no worktree to merge");
  // Merging removes the worktree folder, so no agent may still be in it: not one
  // mid-turn (working, or paused on an approval), and not an idle one either,
  // whose next reply would run in a deleted folder.
  const open = db.query("SELECT agent_state FROM sessions WHERE task_id = ? AND status = 'running'").all(task.id) as { agent_state: string | null }[];
  if (open.some((s) => s.agent_state === "working" || s.agent_state === "needs-input"))
    throw conflict("the agent is still working on this task; wait for it to finish (or stop it) first");
  if (open.length) throw conflict("close the agent's session first: merging removes its worktree folder");
  const main = await mainCheckout(wt);
  if (!main.branch) throw conflict("the project folder isn't on a branch (detached HEAD), so there's nothing to merge into");
  const dirty = await gitIn(main.path, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty.stdout) {
    const n = dirty.stdout.split("\n").length;
    throw conflict(`the project folder has uncommitted changes in ${n} file${n === 1 ? "" : "s"}; commit or stash them first, then merge`);
  }

  // 1. Whatever the agent didn't commit becomes one commit on its branch.
  const pending = await gitIn(wt, ["status", "--porcelain"]);
  let wip = false;
  if (pending.stdout) {
    await gitIn(wt, ["add", "-A"]);
    const c = await gitIn(wt, ["commit", "-q", "-m", `WIP: ${task.title}`, "-m", "Uncommitted work, committed by ansai before merging."]);
    if (c.code !== 0) {
      await gitIn(wt, ["reset", "-q"]);
      throw conflict(`couldn't commit the task's work: ${c.stderr || c.stdout}`);
    }
    wip = true;
  }

  // 2. Squash it onto the main branch. If that's refused, take the WIP commit back
  // off, so the worktree is left exactly as the agent had it.
  let sha: string;
  let staged: string[];
  try {
    ({ sha, staged } = await squash(main.path, main.branch, branch, task));
  } catch (e) {
    if (wip) await gitIn(wt, ["reset", "-q", "HEAD~1"]);
    throw e;
  }

  // 3. The branch is merged (as one commit): drop the worktree and branch.
  await discardTaskWorktree(task).catch((e) => console.error("[ansai] worktree cleanup after merge:", e));
  return { sha, into: main.branch, files: staged.length };
}

async function squash(mainPath: string, mainBranch: string, branch: string, task: TaskRef): Promise<{ sha: string; staged: string[] }> {
  const ahead = await gitIn(mainPath, ["rev-list", "--count", `${mainBranch}..${branch}`]);
  if (ahead.code === 0 && ahead.stdout === "0") throw conflict(`nothing to merge: ${branch} has no commits that ${mainBranch} doesn't have`);
  const sq = await gitIn(mainPath, ["merge", "--squash", branch]);
  if (sq.code !== 0) {
    const conflicted = (await gitIn(mainPath, ["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").filter(Boolean);
    await gitIn(mainPath, ["reset", "--merge"]);
    throw conflict(
      conflicted.length
        ? `merging would conflict in ${conflicted.slice(0, 5).join(", ")}${conflicted.length > 5 ? "…" : ""}. Ask the agent to rebase ${branch} on ${mainBranch}, then merge again.`
        : `git merge failed: ${sq.stderr || sq.stdout}`,
    );
  }
  const staged = (await gitIn(mainPath, ["diff", "--cached", "--name-only"])).stdout.split("\n").filter(Boolean);
  if (!staged.length) throw conflict(`nothing to merge: ${mainBranch} already has these changes`);
  const msg = [task.title, task.summary?.trim() ?? "", `ansai task ${task.id} (branch ${branch})`].filter(Boolean);
  const commit = await gitIn(mainPath, ["commit", "-q", ...msg.flatMap((m) => ["-m", m])]);
  if (commit.code !== 0) {
    await gitIn(mainPath, ["reset", "--merge"]);
    throw conflict(`couldn't commit the merge: ${commit.stderr || commit.stdout}`);
  }
  return { sha: (await gitIn(mainPath, ["rev-parse", "HEAD"])).stdout, staged };
}
