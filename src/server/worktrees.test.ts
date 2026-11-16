// Task worktrees: a restored worktree gets .env and node_modules like a new one,
// and deleting a task removes its worktree and branch, but never unmerged work.
// Runs against a throwaway Git repo under the test ANSAI_HOME.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { db, now } = await import("./db");
const { deleteTask, getTask } = await import("./tasks");
const { discardTaskWorktree, ensureTaskWorktree, mergeTaskWorktree } = await import("./worktrees");

const repo = join(process.env.ANSAI_HOME!, "wt-repo");

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}
const hasBranch = (branch: string) => Bun.spawnSync(["git", "rev-parse", "--verify", "-q", `refs/heads/${branch}`], { cwd: repo }).exitCode === 0;

let n = 0;
/** A task with a fresh worktree of the test repo. */
async function taskWithWorktree() {
  const id = `wt${++n}`;
  db.query("INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, `Task ${id}`, now(), now());
  const wt = await ensureTaskWorktree(getTask(id)!, repo);
  if (!wt) throw new Error("expected a worktree");
  return { id, wt };
}

async function rejection(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as { status?: number; message: string };
  }
  throw new Error("expected a rejection");
}

beforeAll(() => {
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), ".env\nnode_modules/\n");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  writeFileSync(join(repo, ".env"), "SECRET=1\n");
  writeFileSync(join(repo, "node_modules", "dep", "index.js"), "export {};\n");
});

describe("restoring a removed worktree", () => {
  test("checks the branch out again with .env and node_modules", async () => {
    const { id, wt } = await taskWithWorktree();
    expect(readFileSync(join(wt.path, ".env"), "utf8")).toBe("SECRET=1\n");
    writeFileSync(join(wt.path, "b.txt"), "b\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-qm", "Add b");
    rmSync(wt.path, { recursive: true, force: true });

    const again = await ensureTaskWorktree(getTask(id)!, repo);
    expect(again?.path).toBe(wt.path);
    expect(readFileSync(join(wt.path, "b.txt"), "utf8")).toBe("b\n");
    expect(readFileSync(join(wt.path, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(lstatSync(join(wt.path, "node_modules")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(wt.path, "node_modules", "dep", "index.js"))).toBe(true);
    expect(again?.notes.join("\n")).toContain(".env");
    // The linked node_modules stays ignored, so it can't be committed by a merge.
    expect(git(wt.path, "status", "--porcelain")).toBe("");
  });
});

describe("deleting a task", () => {
  test("removes its worktree and branch when nothing on them is unmerged", async () => {
    const { id, wt } = await taskWithWorktree();
    await deleteTask(id);
    expect(getTask(id)).toBeNull();
    expect(existsSync(wt.path)).toBe(false);
    expect(hasBranch(wt.branch)).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain(wt.path);
  });

  test("removes them once the branch is merged into main", async () => {
    const { id, wt } = await taskWithWorktree();
    writeFileSync(join(wt.path, `${id}.txt`), "done\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-qm", "Work");
    git(repo, "merge", "-q", "--ff-only", wt.branch);
    await deleteTask(id);
    expect(getTask(id)).toBeNull();
    expect(existsSync(wt.path)).toBe(false);
    expect(hasBranch(wt.branch)).toBe(false);
  });

  test("refuses (409) while the branch has unmerged commits, and keeps everything", async () => {
    const { id, wt } = await taskWithWorktree();
    writeFileSync(join(wt.path, "c.txt"), "c\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-qm", "Unmerged work");
    const e = await rejection(deleteTask(id));
    expect(e.status).toBe(409);
    expect(e.message).toBe("this task's branch has unmerged commits; merge or discard it first");
    expect(getTask(id)).not.toBeNull();
    expect(existsSync(join(wt.path, "c.txt"))).toBe(true);
    expect(hasBranch(wt.branch)).toBe(true);

    // Discarding is the explicit way to throw it away; then the task deletes.
    await discardTaskWorktree(getTask(id)!);
    await deleteTask(id);
    expect(getTask(id)).toBeNull();
    expect(hasBranch(wt.branch)).toBe(false);
  });

  test("refuses (409) while the worktree has uncommitted changes", async () => {
    const { id, wt } = await taskWithWorktree();
    writeFileSync(join(wt.path, "draft.txt"), "wip\n");
    const e = await rejection(deleteTask(id));
    expect(e.status).toBe(409);
    expect(e.message).toContain("uncommitted changes");
    expect(getTask(id)).not.toBeNull();
    expect(existsSync(join(wt.path, "draft.txt"))).toBe(true);
  });

  test("refuses (409) while an agent session is open on the task", async () => {
    const { id, wt } = await taskWithWorktree();
    db.query(
      `INSERT INTO sessions (id, task_id, tool, title, cwd, argv, tmux_name, status, agent_state, created_at)
       VALUES (?, ?, 'claude', 'Agent', ?, '[]', ?, 'running', 'waiting', ?)`,
    ).run(`s-${id}`, id, wt.path, `ansai-s-${id}`, now());
    const e = await rejection(deleteTask(id));
    expect(e.status).toBe(409);
    expect(e.message).toContain("session is still open");
    expect(getTask(id)).not.toBeNull();
    expect(existsSync(wt.path)).toBe(true);

    db.query("UPDATE sessions SET status = 'exited' WHERE id = ?").run(`s-${id}`);
    await deleteTask(id);
    expect(getTask(id)).toBeNull();
    expect(existsSync(wt.path)).toBe(false);
  });

  test("a task whose worktree folder is already gone still deletes", async () => {
    const { id, wt } = await taskWithWorktree();
    rmSync(wt.path, { recursive: true, force: true });
    await deleteTask(id);
    expect(getTask(id)).toBeNull();
  });
});

// A worktree names its project's repository by path. Before, once the project folder moved
// or was deleted, Merge, Discard and deleting the task all failed for ever with
// "gitfile does not point to a valid repository".
describe("a project folder that moved or was deleted", () => {
  const home = process.env.ANSAI_HOME!;
  let m = 0;
  /** A project of its own (so moving it disturbs nothing else) with one task in a worktree. */
  async function movable() {
    const name = `mv${++m}`;
    const at = join(home, name);
    mkdirSync(at);
    git(at, "init", "-q", "-b", "main");
    writeFileSync(join(at, "a.txt"), "a\n");
    git(at, "add", "-A");
    git(at, "commit", "-q", "-m", "init");
    db.query("INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, 0)").run(name, name, at);
    const id = `task-${name}`;
    db.query("INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, name, `Task ${id}`, now(), now());
    const wt = (await ensureTaskWorktree(getTask(id)!, at))!;
    writeFileSync(join(wt.path, "work.txt"), "the agent's work\n");
    const moved = join(home, `${name}-moved`);
    renameSync(at, moved);
    return { name, id, wt, at, moved };
  }

  test("the task can still be deleted; its files are left where they are", async () => {
    const { id, wt } = await movable();
    await deleteTask(id);
    expect(getTask(id)).toBeNull();
    expect(readFileSync(join(wt.path, "work.txt"), "utf8")).toBe("the agent's work\n");
  });

  test("Discard throws the folder away and frees the task", async () => {
    const { id, wt } = await movable();
    await discardTaskWorktree(getTask(id)!);
    expect(existsSync(wt.path)).toBe(false);
    expect(getTask(id)!.worktree_path).toBeNull();
  });

  test("Merge says what happened instead of a git error, and keeps the files", async () => {
    const { id, wt } = await movable();
    const e = await rejection(mergeTaskWorktree(getTask(id)!));
    expect(e.status).toBe(409);
    expect(e.message).toContain("moved, renamed or deleted");
    expect(e.message).not.toContain("gitfile");
    expect(existsSync(join(wt.path, "work.txt"))).toBe(true);
    // a rerun doesn't put an agent in the broken folder either
    expect((await rejection(ensureTaskWorktree(getTask(id)!, repo))).message).toContain("Discard the task's worktree");
  });

  test("once the folder is back, or added to ansai where it is now, Merge works again", async () => {
    const { name, id, wt, moved } = await movable();
    db.query("INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, 0)").run(`${name}-again`, name, moved);
    const r = await mergeTaskWorktree(getTask(id)!);
    expect(r.into).toBe("main");
    expect(readFileSync(join(moved, "work.txt"), "utf8")).toBe("the agent's work\n");
    expect(existsSync(wt.path)).toBe(false);
  });

  test("a repository the worktree isn't from is never taken for its project", async () => {
    const { id } = await movable();
    db.query("DELETE FROM projects WHERE id LIKE 'mv%-again'").run();
    // `repo` (the other tests' project) is a real repository among ansai's projects, but not this worktree's
    db.query("INSERT OR IGNORE INTO projects (id, name, path, created_at) VALUES ('wt-repo', 'wt-repo', ?, 0)").run(repo);
    expect((await rejection(mergeTaskWorktree(getTask(id)!))).message).toContain("moved, renamed or deleted");
  });
});
