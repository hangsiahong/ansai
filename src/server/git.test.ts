import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, gitOut, gitSync } from "./git";

const repo = mkdtempSync(join(process.env.ANSAI_HOME!, "git-"));
const who = { "user.email": "t@t", "user.name": "t" };
gitSync(repo, ["init", "-q", "-b", "main"]);
writeFileSync(join(repo, "a.txt"), "a\n");
gitSync(repo, ["add", "-A"]);
gitSync(repo, ["commit", "-qm", "first"], { config: who });
const env = { "alias.env": "!env" };

describe("git", () => {
  test("a failed command resolves with its exit code and trimmed output", async () => {
    const r = await git(repo, ["rev-parse", "--verify", "no-such-ref"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toBe(r.stderr.trim());
    expect((await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout).toBe("main");
  });

  test("gitOut keeps stdout as written and throws `git <command>: <stderr>`", async () => {
    expect(await gitOut(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main\n");
    await expect(gitOut(repo, ["rev-parse", "--verify", "no-such-ref"], { config: { "core.quotePath": "false" } })).rejects.toThrow(/^git rev-parse: fatal/);
  });

  test("gitSync is trimmed stdout, or null when the command fails or there is no such program", () => {
    expect(gitSync(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(gitSync(repo, ["rev-parse", "--verify", "no-such-ref"])).toBeNull();
    expect(gitSync(repo, ["status"], { bin: "no-such-git-program" })).toBeNull();
  });

  test("every call runs in `cwd`'s repository with a clean environment; readOnly takes no optional locks", async () => {
    const before = { GIT_DIR: process.env.GIT_DIR, CLAUDECODE: process.env.CLAUDECODE };
    process.env.GIT_DIR = join(repo, "nowhere");
    process.env.CLAUDECODE = "1";
    try {
      expect((await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout).toBe("main");
      expect(gitSync(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
      const plain = (await git(repo, ["env"], { config: env })).stdout.split("\n");
      expect(plain).toContain("TERM=xterm-256color");
      expect(plain).not.toContain("CLAUDECODE=1");
      expect(plain).not.toContain("GIT_OPTIONAL_LOCKS=0");
      const read = (await git(repo, ["env"], { config: env, readOnly: true, env: { LC_ALL: "C" } })).stdout.split("\n");
      expect(read).toEqual(expect.arrayContaining(["GIT_OPTIONAL_LOCKS=0", "LC_ALL=C"]));
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
