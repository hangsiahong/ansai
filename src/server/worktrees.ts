import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { config, cleanEnv } from "./config";
import { db } from "./db";
import { emit } from "./events";
import { conflict } from "./errors";

type WorktreeTask = { id: string; title: string; worktree_path: string | null; worktree_branch: string | null };
type Worktree = { path: string; branch: string; cwd: string };

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
  }

  return { path, branch, cwd: projectSubdir ? join(path, projectSubdir) : path };
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
  const main = await mainCheckout(wt);
  if (!main.branch) throw conflict("the project folder isn't on a branch (detached HEAD), so there's nothing to merge into");
  const dirty = await gitIn(main.path, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty.stdout) {
    const n = dirty.stdout.split("\n").length;
    throw conflict(`the project folder has uncommitted changes in ${n} file${n === 1 ? "" : "s"}; commit or stash them first, then merge`);
  }

  // 1. Whatever the agent didn't commit becomes one commit on its branch.
  const pending = await gitIn(wt, ["status", "--porcelain"]);
  if (pending.stdout) {
    await gitIn(wt, ["add", "-A"]);
    const c = await gitIn(wt, ["commit", "-q", "-m", `WIP: ${task.title}`, "-m", "Uncommitted work, committed by ansai before merging."]);
    if (c.code !== 0) throw conflict(`couldn't commit the task's work: ${c.stderr || c.stdout}`);
  }

  // 2. Squash it onto the main branch.
  const ahead = await gitIn(main.path, ["rev-list", "--count", `${main.branch}..${branch}`]);
  if (ahead.code === 0 && ahead.stdout === "0") throw conflict(`nothing to merge: ${branch} has no commits that ${main.branch} doesn't have`);
  const sq = await gitIn(main.path, ["merge", "--squash", branch]);
  if (sq.code !== 0) {
    const conflicted = (await gitIn(main.path, ["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").filter(Boolean);
    await gitIn(main.path, ["reset", "--merge"]);
    throw conflict(
      conflicted.length
        ? `merging would conflict in ${conflicted.slice(0, 5).join(", ")}${conflicted.length > 5 ? "…" : ""}. Ask the agent to rebase ${branch} on ${main.branch}, then merge again.`
        : `git merge failed: ${sq.stderr || sq.stdout}`,
    );
  }
  const staged = (await gitIn(main.path, ["diff", "--cached", "--name-only"])).stdout.split("\n").filter(Boolean);
  if (!staged.length) throw conflict(`nothing to merge: ${main.branch} already has these changes`);
  const msg = [task.title, task.summary?.trim() ?? "", `ansai task ${task.id} (branch ${branch})`].filter(Boolean);
  const commit = await gitIn(main.path, ["commit", "-q", ...msg.flatMap((m) => ["-m", m])]);
  if (commit.code !== 0) {
    await gitIn(main.path, ["reset", "--merge"]);
    throw conflict(`couldn't commit the merge: ${commit.stderr || commit.stdout}`);
  }
  const sha = (await gitIn(main.path, ["rev-parse", "HEAD"])).stdout;

  // 3. The branch is merged (as one commit): drop the worktree and branch.
  await discardTaskWorktree(task).catch((e) => console.error("[ansai] worktree cleanup after merge:", e));
  return { sha, into: main.branch, files: staged.length };
}
