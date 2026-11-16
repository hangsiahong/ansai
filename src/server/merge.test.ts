// Merging a task: the agent's work lands on the project's branch as one commit and the
// worktree goes away, or the merge is refused and nothing at all changes. It must never
// say "merged" while work is left behind in a folder it then deletes, and never commit
// a copied secret. Runs against throwaway Git repos under the test ANSAI_HOME.
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { db, now } = await import("./db");
const { getTask } = await import("./tasks");
const { discardTaskWorktreeClosingAgents, ensureTaskWorktree, mergeTaskWorktree } = await import("./worktrees");

const root = join(process.env.ANSAI_HOME!, "merge-repos");

function run(cwd: string, args: string[]) {
  return Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "protocol.file.allow=always", ...args], { cwd });
}
function git(cwd: string, ...args: string[]) {
  const r = run(cwd, args);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
const write = (dir: string, rel: string, text: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), "utf8");

/** A project: a new repo on `main` with one commit. */
function project(name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  // The merge commits as whoever Git says the user is; don't depend on the machine's config.
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  write(dir, "a.txt", "a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

let n = 0;
/** A task with a fresh worktree of that project. */
async function taskIn(repo: string, title = "Add the thing") {
  const id = `mg${++n}`;
  db.query("INSERT INTO tasks (id, title, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, title, "What the agent did.", now(), now());
  const wt = await ensureTaskWorktree(getTask(id)!, repo);
  if (!wt) throw new Error("expected a worktree");
  return { id, wt };
}

/** Everything Git knows about a checkout: where it is, every branch tip, and what's uncommitted or staged. */
const state = (dir: string) => ({
  on: run(dir, ["symbolic-ref", "-q", "HEAD"]).stdout.toString().trim() || "(detached)",
  head: git(dir, "rev-parse", "HEAD"),
  refs: git(dir, "for-each-ref", "--format=%(refname) %(objectname)"),
  status: git(dir, "status", "--porcelain"),
  staged: git(dir, "diff", "--cached", "--name-only"),
});

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as { status?: number; message: string };
  }
  throw new Error("expected the merge to be refused");
}

/** Run a merge that must be refused, and check that neither the project folder nor the worktree changed. */
async function refusedUnchanged(id: string, repo: string, wtPath: string, o?: Parameters<typeof mergeTaskWorktree>[1]) {
  const before = { repo: state(repo), wt: state(wtPath) };
  const e = await refusal(mergeTaskWorktree(getTask(id)!, o));
  expect(e.status).toBe(409);
  expect({ repo: state(repo), wt: state(wtPath) }).toEqual(before);
  expect(getTask(id)!.worktree_path).toBe(wtPath);
  return e;
}

describe("merging a task", () => {
  test("lands committed and uncommitted work as one commit, and removes the worktree and branch", async () => {
    const repo = project("clean");
    const { id, wt } = await taskIn(repo, "Add the thing");
    write(wt.path, "one.txt", "committed\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-qm", "step 1");
    write(wt.path, "one.txt", "committed, then edited\n");
    write(wt.path, "sub/two.txt", "never committed\n");
    const before = git(repo, "rev-parse", "HEAD");

    const r = await mergeTaskWorktree(getTask(id)!);

    expect(r.into).toBe("main");
    expect(r.files).toBe(2);
    expect(git(repo, "rev-parse", "HEAD")).toBe(r.sha);
    // Exactly one new commit, on top of what was there, titled after the task.
    expect(git(repo, "rev-parse", "HEAD~1")).toBe(before);
    expect(git(repo, "log", "-1", "--format=%s")).toBe("Add the thing");
    expect(git(repo, "log", "-1", "--format=%b")).toContain("What the agent did.");
    expect(git(repo, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["one.txt", "sub/two.txt"]);
    expect(read(repo, "one.txt")).toBe("committed, then edited\n");
    expect(read(repo, "sub/two.txt")).toBe("never committed\n");
    expect(git(repo, "status", "--porcelain")).toBe("");
    // The worktree and its branch are gone, and the task no longer points at them.
    expect(existsSync(wt.path)).toBe(false);
    expect(git(repo, "branch", "--format=%(refname:short)")).toBe("main");
    expect(git(repo, "worktree", "list")).not.toContain(wt.path);
    expect(getTask(id)!.worktree_path).toBeNull();
    expect(getTask(id)!.worktree_branch).toBeNull();
  });

  test("a conflict is refused: the project is untouched and the agent's uncommitted work is uncommitted again", async () => {
    const repo = project("conflict");
    const { id, wt } = await taskIn(repo);
    write(wt.path, "a.txt", "task version\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-qm", "task edit");
    write(wt.path, "a.txt", "task version, edited again\n");
    write(wt.path, "untracked.txt", "u\n");
    write(repo, "a.txt", "main version\n");
    git(repo, "commit", "-qam", "main edit");
    write(repo, "scratch.txt", "the user's own untracked file\n");

    const e = await refusedUnchanged(id, repo, wt.path);

    expect(e.message).toContain("conflict in a.txt");
    expect(e.message).toContain(wt.branch);
    expect(read(repo, "a.txt")).toBe("main version\n");
    expect(read(repo, "scratch.txt")).toBe("the user's own untracked file\n");
    // No WIP commit is left on the task's branch, and its files are as the agent left them.
    expect(git(wt.path, "log", "-1", "--format=%s")).toBe("task edit");
    expect(read(wt.path, "a.txt")).toBe("task version, edited again\n");
    expect(read(wt.path, "untracked.txt")).toBe("u\n");
  });
});

/** A session on the task, as the hooks leave it: "waiting" is idle at its prompt, "working" is mid-turn. */
function openAgent(taskId: string, agentState: string | null = "waiting") {
  const sid = `ag${++n}`;
  db.query(
    `INSERT INTO sessions (id, task_id, tool, title, cwd, argv, tmux_name, status, agent_state, created_at)
     VALUES (?, ?, 'claude', 'Agent', '/tmp', '[]', ?, 'running', ?, ?)`,
  ).run(sid, taskId, `ansai-${sid}`, agentState, now());
  return sid;
}

/** A stand-in for closing a session that notes what the project and worktree looked like at that moment. */
function closer(repo: string, wtPath: string, failFor: string[] = []) {
  const calls: { id: string; head: string; worktreeThere: boolean }[] = [];
  const close = async (id: string) => {
    calls.push({ id, head: git(repo, "rev-parse", "HEAD"), worktreeThere: existsSync(wtPath) });
    if (failFor.includes(id)) throw new Error("tmux said no");
  };
  return { calls, close };
}

/** A task whose branch edits a.txt, after main edited it too: merging it conflicts. */
async function conflictingTask(name: string) {
  const repo = project(name);
  const { id, wt } = await taskIn(repo);
  write(wt.path, "a.txt", "task version\n");
  git(wt.path, "add", "-A");
  git(wt.path, "commit", "-qm", "task edit");
  write(repo, "a.txt", "main version\n");
  git(repo, "commit", "-qam", "main edit");
  return { repo, id, wt };
}

describe("merging a task whose agent session is still open", () => {
  test("an idle agent is closed once its work has landed, and before the worktree goes", async () => {
    const repo = project("idle-closed");
    const { id, wt } = await taskIn(repo);
    write(wt.path, "one.txt", "1\n");
    const sid = openAgent(id);
    const before = git(repo, "rev-parse", "HEAD");
    const { calls, close } = closer(repo, wt.path);

    const r = await mergeTaskWorktree(getTask(id)!, { close });

    expect(r.sha).not.toBe(before);
    // Closed once, after the commit was on main (HEAD was already the merge) and with the worktree still there.
    expect(calls).toEqual([{ id: sid, head: r.sha, worktreeThere: true }]);
    expect(read(repo, "one.txt")).toBe("1\n");
    expect(existsSync(wt.path)).toBe(false);
    expect(getTask(id)!.worktree_path).toBeNull();
  });

  test("a session that won't close is logged: the others still close and the merge completes", async () => {
    const repo = project("close-fails");
    const { id, wt } = await taskIn(repo);
    write(wt.path, "one.txt", "1\n");
    const a = openAgent(id);
    const b = openAgent(id);
    const { calls, close } = closer(repo, wt.path, [a]);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await mergeTaskWorktree(getTask(id)!, { close });
      expect(calls.map((c) => c.id).sort()).toEqual([a, b].sort());
      expect(errors.mock.calls.some((c) => String(c[0]).includes(a))).toBe(true);
      expect(git(repo, "rev-parse", "HEAD")).toBe(r.sha);
      expect(existsSync(wt.path)).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  test("a conflict with the agent open: it stays open, the worktree stays, and the message says to ask it", async () => {
    const { repo, id, wt } = await conflictingTask("conflict-open");
    openAgent(id);
    const { calls, close } = closer(repo, wt.path);

    const e = await refusedUnchanged(id, repo, wt.path, { close });

    expect(e.message).toContain("conflict in a.txt");
    expect(e.message).toContain(`Ask the agent to rebase ${wt.branch} on main, then merge again.`);
    expect(e.message).not.toContain("No agent is open");
    expect(calls).toEqual([]);
    expect(existsSync(wt.path)).toBe(true);
  });

  test("a conflict with no session open says there is no agent, and how to get one back", async () => {
    const { repo, id, wt } = await conflictingTask("conflict-none");

    const e = await refusedUnchanged(id, repo, wt.path);

    expect(e.message).toContain("conflict in a.txt");
    expect(e.message).toContain("No agent is open on this task: pick its last session back up (or run the task again)");
    expect(e.message).toContain(`rebase ${wt.branch} on main, then merge again.`);
    expect(e.message).not.toContain("Ask the agent");
  });

  for (const state of ["working", "needs-input"]) {
    test(`an agent that is ${state} is still refused when closing is allowed, and nothing is closed`, async () => {
      const repo = project(`midturn-${state}`);
      const { id, wt } = await taskIn(repo);
      write(wt.path, "one.txt", "1\n");
      openAgent(id, state);
      openAgent(id); // an idle one beside it doesn't change that
      const { calls, close } = closer(repo, wt.path);

      const e = await refusedUnchanged(id, repo, wt.path, { close });

      expect(e.message).toContain("the agent is still working on this task");
      expect(calls).toEqual([]);
      expect(existsSync(wt.path)).toBe(true);
    });
  }

  test("an agent with no state yet (a Codex on its first turn, agy) may be working: refused, and nothing is closed", async () => {
    const repo = project("state-unknown");
    const { id, wt } = await taskIn(repo);
    write(wt.path, "one.txt", "1\n");
    openAgent(id, null);
    openAgent(id); // an idle one beside it doesn't change that
    const { calls, close } = closer(repo, wt.path);

    const e = await refusedUnchanged(id, repo, wt.path, { close });

    expect(e.message).toContain("close the agent's session first");
    expect(calls).toEqual([]);
    expect(existsSync(wt.path)).toBe(true);
  });

  test("an idle agent and no way to close it: refused as before, nothing changes", async () => {
    const repo = project("idle-no-close");
    const { id, wt } = await taskIn(repo);
    write(wt.path, "one.txt", "1\n");
    openAgent(id);

    const e = await refusedUnchanged(id, repo, wt.path);

    expect(e.message).toContain("close the agent's session first");
    expect(read(wt.path, "one.txt")).toBe("1\n");
  });

  /** A session that is the task's finished reviewer. */
  function finishedReviewer(taskId: string) {
    const sid = openAgent(taskId);
    db.query("INSERT INTO task_reviews (task_id, session_id, reviewer_tool, status, updated_at) VALUES (?, ?, 'claude', 'complete', ?)").run(taskId, sid, now());
    return sid;
  }

  test("a finished reviewer's session isn't closed by the merge, only the agent's", async () => {
    const repo = project("reviewer-kept");
    const { id, wt } = await taskIn(repo);
    write(wt.path, "one.txt", "1\n");
    finishedReviewer(id);
    const agent = openAgent(id);
    const { calls, close } = closer(repo, wt.path);

    await mergeTaskWorktree(getTask(id)!, { close });

    expect(calls.map((c) => c.id)).toEqual([agent]);
  });

  test("a finished reviewer's session alone doesn't stop a merge that has no way to close sessions", async () => {
    const repo = project("reviewer-only");
    const { id, wt } = await taskIn(repo);
    write(wt.path, "one.txt", "1\n");
    finishedReviewer(id);

    expect((await mergeTaskWorktree(getTask(id)!)).files).toBe(1);
    expect(existsSync(wt.path)).toBe(false);
  });
});

describe("discarding a task whose agent session is still open", () => {
  test("an idle agent is closed and the worktree and branch are thrown away", async () => {
    const repo = project("discard-idle");
    const { id, wt } = await taskIn(repo);
    write(wt.path, "one.txt", "never merged\n");
    const sid = openAgent(id);
    const { calls, close } = closer(repo, wt.path);

    await discardTaskWorktreeClosingAgents(getTask(id)!, close);

    expect(calls).toEqual([{ id: sid, head: git(repo, "rev-parse", "HEAD"), worktreeThere: true }]);
    expect(existsSync(wt.path)).toBe(false);
    expect(git(repo, "branch", "--format=%(refname:short)")).toBe("main");
    expect(getTask(id)!.worktree_path).toBeNull();
  });

  for (const state of ["working", "needs-input"]) {
    test(`an agent that is ${state} refuses it, and nothing is closed or deleted`, async () => {
      const repo = project(`discard-${state}`);
      const { id, wt } = await taskIn(repo);
      openAgent(id, state);
      openAgent(id);
      const { calls, close } = closer(repo, wt.path);

      const e = await refusal(discardTaskWorktreeClosingAgents(getTask(id)!, close));

      expect(e.status).toBe(409);
      expect(e.message).toContain("the agent is still working on this task");
      expect(calls).toEqual([]);
      expect(existsSync(wt.path)).toBe(true);
      expect(getTask(id)!.worktree_path).toBe(wt.path);
    });
  }

  test("an agent with no state yet may be working: refused, and nothing is closed or deleted", async () => {
    const repo = project("discard-unknown");
    const { id, wt } = await taskIn(repo);
    openAgent(id, null);
    const { calls, close } = closer(repo, wt.path);

    const e = await refusal(discardTaskWorktreeClosingAgents(getTask(id)!, close));

    expect(e.status).toBe(409);
    expect(e.message).toContain("can't tell whether it is idle");
    expect(calls).toEqual([]);
    expect(existsSync(wt.path)).toBe(true);
    expect(getTask(id)!.worktree_path).toBe(wt.path);
  });

  test("a task with no worktree is refused before any agent is closed", async () => {
    db.query("INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('mg-bare', 'No worktree', ?, ?)").run(now(), now());
    const sid = openAgent("mg-bare");
    const calls: string[] = [];

    const e = await refusal(discardTaskWorktreeClosingAgents(getTask("mg-bare")!, async (s) => void calls.push(s)));

    expect(e.message).toContain("no worktree");
    expect(calls).toEqual([]);
    expect(db.query("SELECT status FROM sessions WHERE id = ?").get(sid)).toEqual({ status: "running" });
  });
});

describe("work that isn't on the task's branch", () => {
  test("a detached HEAD is refused, and nothing changes", async () => {
    const repo = project("detached");
    const { id, wt } = await taskIn(repo);
    write(wt.path, "one.txt", "1\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-qm", "step 1");
    git(wt.path, "checkout", "-q", "--detach");
    write(wt.path, "two.txt", "2\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-qm", "step 2, on a detached HEAD");
    write(wt.path, "three.txt", "uncommitted\n");

    const e = await refusedUnchanged(id, repo, wt.path);

    expect(e.message).toContain("detached HEAD");
    expect(e.message).toContain(`put its work on ${wt.branch}`);
    expect(git(wt.path, "log", "-1", "--format=%s")).toBe("step 2, on a detached HEAD");
    expect(read(wt.path, "three.txt")).toBe("uncommitted\n");
    expect(existsSync(join(repo, "one.txt"))).toBe(false);
  });

  test("an agent that moved to its own branch is refused, and nothing changes", async () => {
    const repo = project("own-branch");
    const { id, wt } = await taskIn(repo);
    write(wt.path, "one.txt", "1\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-qm", "step 1");
    git(wt.path, "checkout", "-q", "-b", "feat/better-name");
    write(wt.path, "two.txt", "2\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-qm", "step 2, on the agent's own branch");
    write(wt.path, "three.txt", "uncommitted\n");

    const e = await refusedUnchanged(id, repo, wt.path);

    expect(e.message).toContain("is on branch feat/better-name");
    expect(e.message).toContain(`put its work on ${wt.branch}`);
    expect(read(wt.path, "three.txt")).toBe("uncommitted\n");
    expect(existsSync(join(repo, "one.txt"))).toBe(false);

    // Once the work is on the task's branch, the same task merges, with all three files.
    git(wt.path, "checkout", "-q", wt.branch);
    git(wt.path, "merge", "-q", "--ff-only", "feat/better-name");
    await mergeTaskWorktree(getTask(id)!);
    expect(git(repo, "ls-files").split("\n")).toEqual(["a.txt", "one.txt", "three.txt", "two.txt"]);
  });
});

describe("a Git repository nested in the worktree", () => {
  /** What `git clone` or a scaffolder leaves behind: a folder with its own repository and a commit. */
  function nestedRepo(dir: string) {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    write(dir, "index.js", "the real work\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "scaffold");
  }

  test("is refused: its files are still there and nothing is left staged", async () => {
    const repo = project("nested");
    const { id, wt } = await taskIn(repo);
    nestedRepo(join(wt.path, "app"));
    write(wt.path, "README.md", "docs\n");

    const e = await refusedUnchanged(id, repo, wt.path);

    expect(e.message).toContain("app has its own Git repository");
    expect(read(wt.path, "app/index.js")).toBe("the real work\n");
    expect(read(wt.path, "README.md")).toBe("docs\n");
    expect(git(wt.path, "diff", "--cached", "--name-only")).toBe("");
    expect(git(wt.path, "status", "--porcelain").split("\n").sort()).toEqual(["?? README.md", "?? app/"]);
  });

  test("with no commits yet (git init) is refused too, instead of merging only what was staged", async () => {
    const repo = project("nested-empty");
    const { id, wt } = await taskIn(repo);
    mkdirSync(join(wt.path, "tool"));
    git(join(wt.path, "tool"), "init", "-q", "-b", "main");
    write(wt.path, "tool/main.go", "the real work\n");
    write(wt.path, "notes.txt", "not staged\n");
    write(wt.path, "staged.txt", "staged by the agent\n");
    git(wt.path, "add", "staged.txt");

    const e = await refusedUnchanged(id, repo, wt.path);

    expect(e.message).toContain("tool has its own Git repository");
    expect(read(wt.path, "tool/main.go")).toBe("the real work\n");
    expect(read(wt.path, "notes.txt")).toBe("not staged\n");
  });

  test("that the agent already committed as a bare pointer is refused before anything is merged", async () => {
    const repo = project("nested-committed");
    const { id, wt } = await taskIn(repo);
    nestedRepo(join(wt.path, "vendor/lib"));
    write(wt.path, "README.md", "docs\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-qm", "Add lib");
    expect(git(wt.path, "ls-files", "-s", "vendor/lib")).toStartWith("160000 ");

    const e = await refusedUnchanged(id, repo, wt.path);

    expect(e.message).toContain("vendor/lib has its own Git repository");
    expect(read(wt.path, "vendor/lib/index.js")).toBe("the real work\n");
    expect(existsSync(join(repo, "README.md"))).toBe(false);
  });

  test("a submodule the project already tracks doesn't get in the way of a merge", async () => {
    const lib = join(root, "submodule-source");
    nestedRepo(lib);
    const repo = project("submodule");
    git(repo, "submodule", "--quiet", "add", lib, "vendor/lib");
    git(repo, "commit", "-qm", "Add vendor/lib as a submodule");
    const pointer = git(repo, "ls-files", "-s", "vendor/lib");
    expect(pointer).toStartWith("160000 ");
    const { id, wt } = await taskIn(repo);
    write(wt.path, "work.txt", "w\n");

    const r = await mergeTaskWorktree(getTask(id)!);

    expect(r.files).toBe(1);
    expect(read(repo, "work.txt")).toBe("w\n");
    expect(git(repo, "ls-files", "-s", "vendor/lib")).toBe(pointer);
    expect(existsSync(wt.path)).toBe(false);
  });
});

describe("env files copied into the worktree", () => {
  test("are not merged when the project's rule ignoring them was never committed", async () => {
    const repo = project("env");
    write(repo, ".gitignore", "node_modules/\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "gitignore");
    // The user starts ignoring their env files but hasn't committed that yet.
    write(repo, ".gitignore", "node_modules/\n.env*\n");
    write(repo, ".env.local", "STRIPE_SECRET=sk_live_x\n");
    write(repo, "apps/[web] site/.env", "DB_PASSWORD=hunter2\n");

    const { id, wt } = await taskIn(repo);
    // The agent gets the files to run the code with, but Git must not see them as new work.
    expect(read(wt.path, ".env.local")).toBe("STRIPE_SECRET=sk_live_x\n");
    expect(read(wt.path, "apps/[web] site/.env")).toBe("DB_PASSWORD=hunter2\n");
    expect(git(wt.path, "status", "--porcelain")).toBe("");
    write(wt.path, "page.txt", "p\n");

    // Merge wants a clean project folder, so the user commits the rule; the worktree
    // still has the old .gitignore.
    git(repo, "commit", "-qam", "Ignore env files");
    const r = await mergeTaskWorktree(getTask(id)!);

    expect(r.files).toBe(1);
    expect(git(repo, "show", "--name-only", "--format=", "HEAD")).toBe("page.txt");
    expect(git(repo, "ls-files").split("\n").sort()).toEqual([".gitignore", "a.txt", "page.txt"]);
    expect(git(repo, "log", "--all", "--format=%s", "--", ".env.local", "apps")).toBe("");
    // The user's own env files are still theirs, untouched and untracked.
    expect(read(repo, ".env.local")).toBe("STRIPE_SECRET=sk_live_x\n");
    expect(read(repo, "apps/[web] site/.env")).toBe("DB_PASSWORD=hunter2\n");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });
});
