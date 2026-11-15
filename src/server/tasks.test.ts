// A rerun of a task starts with a handoff: the last summary and what's already on its branch.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { handoff } = await import("./tasks");

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};

describe("rerun handoff", () => {
  test("lists the last summary, the branch's commits, and uncommitted files", async () => {
    const root = mkdtempSync(join(tmpdir(), "ansai-handoff-"));
    const repo = join(root, "repo");
    const wt = join(root, "wt");
    Bun.spawnSync(["mkdir", "-p", repo]);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    git(repo, "worktree", "add", "-q", "-b", "ansai/t1", wt, "HEAD");
    writeFileSync(join(wt, "b.txt"), "b\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-qm", "Add b");
    writeFileSync(join(wt, "c.txt"), "wip\n");

    const task = { summary: "Added b; c is half done.", worktree_path: wt } as never;
    const text = await handoff(task, wt);
    expect(text).toContain("worked on before");
    expect(text).toContain("The last run's summary: Added b; c is half done.");
    expect(text).toMatch(/Already committed on ansai\/t1[\s\S]*Add b/);
    expect(text).toContain("1 file has uncommitted changes");
  });

  test("a first run gets no handoff", async () => {
    expect(await handoff({ summary: null, worktree_path: null } as never, null)).toBe("");
  });
});
