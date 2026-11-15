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
