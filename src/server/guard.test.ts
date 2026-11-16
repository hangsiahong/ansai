// The destructive-command guard (guard.ts): what it stops, and the everyday commands it must let through.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GuardContext, hookReply, judgeCommand, judgeTool, loadContext } from "./guard";

const { config } = await import("./config");
const { db } = await import("./db");
const { withHooks, writeHookFiles } = await import("./hooks");

/** A home with an ansai project (main checkout + a task worktree), another repo, and a scratch folder. */
const root = mkdtempSync(join(tmpdir(), "guard-"));
const home = join(root, "home");
const project = join(home, "code", "app");
const worktree = join(home, "wt", "task1");
const other = join(home, "code", "other");
const scratch = join(root, "scratch");
mkdirSync(join(project, ".git", "worktrees", "task1"), { recursive: true });
writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
writeFileSync(join(project, ".git", "worktrees", "task1", "HEAD"), "ref: refs/heads/ansai/task1\n");
mkdirSync(worktree, { recursive: true });
writeFileSync(join(worktree, ".git"), `gitdir: ${join(project, ".git", "worktrees", "task1")}\n`);
mkdirSync(join(other, ".git"), { recursive: true });
mkdirSync(join(home, ".ansai", "profiles", "claude", "work"), { recursive: true });
writeFileSync(join(home, ".ansai", "profiles", "claude", "work", ".credentials.json"), "{}");
mkdirSync(scratch, { recursive: true });

const ctx = (cwd = project, env: Record<string, string> = {}): GuardContext => ({
  cwd,
  home,
  dataDir: join(home, ".ansai"),
  projects: [project],
  sockets: ["ansai"],
  tmp: [scratch],
  env: { TMUX: "/tmp/tmux-1000/ansai,123,0", ...env },
});
const level = (cmd: string, cwd?: string): string => judgeCommand(cmd, ctx(cwd))[0]?.level ?? "ok";

describe("refused outright", () => {
  test.each([
    "rm -rf /",
    "rm -rf /*",
    "sudo rm -rf --no-preserve-root /",
    "rm -rf ~",
    "rm -rf ~/",
    "rm -rf $HOME",
    'rm -rf "${HOME}"',
    "rm -fr /home",
    "rm -r -f /usr",
    "rm -rf ~/.ssh",
    "rm -rf ~/.ansai",
    "rm -rf ~/.ansai/release",
    "rm -rf ~/.ansai/profiles",
    "rm -rf ~/.claude",
    "rm -rf ~/.c*",
    "rm -rf ~/{.ssh,.config}",
    "cd ~ && rm -rf .ansai",
    "cd / && rm -rf *",
    'D=""; rm -rf "$D/"',
    'bash -c "rm -rf ~"',
    "sh -lc 'cd ~; rm -rf .config'",
    "ssh prod 'rm -rf ~'",
    "echo $(rm -rf ~)",
    "bash <<'EOF'\nrm -rf ~/.codex\nEOF",
    "find ~ -delete",
    "chmod -R 777 /",
    "chown -R nobody ~",
    "mv ~/.ssh " + scratch,
    "rsync -a --delete empty/ ~/",
    "dd if=/dev/zero of=/dev/sda bs=1M",
    "mkfs.ext4 /dev/nvme0n1p1",
    "wipefs -a /dev/sdb",
    "echo x > /dev/sda",
    ":(){ :|:& };:",
    "tmux kill-server",
    "tmux -L ansai kill-server",
    "rm -rf " + scratch,
  ])("%s", (cmd) => expect(level(cmd)).toBe("deny"));
});

describe("asks you first", () => {
  test.each([
    "rm -rf " + project,
    "rm -rf " + join(home, "code"),
    "rm -rf " + join(project, ".git"),
    "rm -rf " + other,
    "rm -rf ~/.ansai/profiles/claude/work",
    "rm ~/.ansai/ansai.db",
    "mv new.db ~/.ansai/ansai.db",
    "cp backup.db ~/.ansai/ansai.db",
    "echo {} > ~/.claude/.credentials.json",
    "rm ~/.ssh/id_ed25519",
    "rm -rf /etc/nginx",
    "git reset --hard",
    "git reset --hard origin/main",
    "git -C " + project + " clean -fdx",
    "git checkout .",
    "git checkout -- .",
    "git restore .",
    "git stash",
    "git stash -u",
    "git push --force",
    "git push -f origin HEAD",
    "git push origin +main",
    "git push --force-with-lease origin HEAD:master",
    "git push origin --delete main",
    "git push origin :main",
    'psql -c "DROP TABLE users"',
    'echo "DROP DATABASE app" | psql',
    'sqlite3 ~/.ansai/ansai.db "DELETE FROM tasks"',
    "psql <<'SQL'\nTRUNCATE users;\nSQL",
    "redis-cli FLUSHALL",
    "ssh prod \"psql -c 'TRUNCATE users'\"",
    "bunx prisma migrate reset --force",
    "dropdb app",
    "docker compose down -v",
    "docker volume rm app_pgdata",
    'pkill -f "bun src/server/index.ts"',
    "killall claude",
    "systemctl --user stop ansai",
    "gh repo delete me/app --yes",
  ])("%s", (cmd) => expect(level(cmd)).toBe("ask"));
});

describe("everyday work goes through", () => {
  test.each([
    "rm -rf node_modules dist",
    "rm -rf build/*",
    "rm -rf " + join(scratch, "e2e"),
    'rm -rf "$SOME_UNSET_VAR/"',
    "D=" + scratch + "/x; rm -rf $D",
    "export OUT=" + scratch + "/o && rm -rf $OUT",
    "for d in a b; do rm -rf \"$d/\"; done",
    "rm -rf ~/.cache/bun",
    "rm -f .git/index.lock",
    "rm -rf .git/worktrees/old",
    "rm -rf src/old",
    "rm ~/.ansai/profiles/claude/work/projects/x/memory/old-note.md",
    "git reset --soft HEAD~1",
    "git clean -n",
    "git checkout -- src/a.ts",
    "git checkout -b feature",
    "git restore --staged .",
    "git stash list",
    "git push --force origin feature",
    "git push origin main",
    "git log --oneline | head",
    'grep -rn "DROP TABLE" src',
    'echo "rm -rf ~"',
    "cat > drop.sql <<'EOF'\nDROP TABLE x;\nEOF",
    "cat > a.sh <<'EOF'\nrm -rf ~\nEOF",
    'psql -c "DELETE FROM users WHERE id = 1"',
    `sqlite3 ${scratch}/home/ansai.db "DELETE FROM tasks; DELETE FROM sessions"`,
    `sqlite3 ~/.ansai/ansai.db "VACUUM INTO '${scratch}/copy.db'"`,
    "docker compose down",
    "tmux -L ansai-guard kill-server",
    "pkill -f ANSAI_PORT=7801",
    "find . -name '*.pyc' -delete",
    "chmod -R u+w build",
    "mv a.ts b.ts",
    "dd if=/dev/zero of=disk.img bs=1M count=10",
    "mkfs.ext4 disk.img",
    "fdisk -l /dev/sda",
    "echo hi > /dev/null 2>&1",
    "ls ~/.ssh && cat ~/.ssh/config",
    "systemctl --user restart ansai",
    "bun run typecheck && bun test",
  ])("%s", (cmd) => expect(judgeCommand(cmd, ctx())).toEqual([]));

  test("a task worktree may reset, clean, stash and force-push its own branch", () => {
    for (const cmd of ["git reset --hard", "git clean -fdx", "git checkout .", "git stash", "git push --force"]) expect(level(cmd, worktree)).toBe("ok");
  });

  test("a repository that isn't one of ansai's projects is nobody else's checkout", () => {
    expect(level("git reset --hard", other)).toBe("ok");
  });
});

describe("file writes", () => {
  const tool = (name: string, file: string) => judgeTool(name, { file_path: file }, ctx())?.level ?? "ok";
  test("logins, the database and SSH keys ask; the agent's memory and the code don't", () => {
    expect(tool("Write", join(home, ".ansai", "ansai.db"))).toBe("ask");
    expect(tool("Edit", join(home, ".claude", ".credentials.json"))).toBe("ask");
    expect(tool("Write", join(home, ".ssh", "authorized_keys"))).toBe("ask");
    expect(tool("Write", join(home, ".ansai", "profiles", "claude", "work", "projects", "p", "memory", "MEMORY.md"))).toBe("ok");
    expect(tool("Edit", join(project, "src", "a.ts"))).toBe("ok");
    expect(tool("Read", join(home, ".ansai", "ansai.db"))).toBe("ok");
  });
  test("Codex's Bash command can come as argv", () => {
    expect(judgeTool("Bash", { command: ["bash", "-lc", "rm -rf ~"] }, ctx())?.level).toBe("deny");
  });
});

describe("the hook's answer", () => {
  test("Claude asks you; Codex can't ask, so it is told no and to tell you", () => {
    const hit = { level: "ask" as const, reason: "ansai guard: x." };
    expect(hookReply(hit, "claude").hookSpecificOutput).toMatchObject({ permissionDecision: "ask", permissionDecisionReason: "ansai guard: x." });
    const codex = hookReply(hit, "codex").hookSpecificOutput;
    expect(codex.permissionDecision).toBe("deny");
    expect(codex.permissionDecisionReason).toContain("they can run it themselves");
  });

  test("the reason names the place and says what to do instead", () => {
    const [hit] = judgeCommand("git reset --hard", ctx());
    expect(hit!.reason).toContain(project);
    expect(hit!.reason).toContain("task worktree");
  });

  test("a missing guard.json still guards this machine's home", () => {
    const c = loadContext(join(root, "nope", "guard.json"), "/x");
    expect(c).toMatchObject({ cwd: "/x", dataDir: join(root, "nope"), projects: [], sockets: ["ansai"] });
  });
});

describe("as the agents run it", () => {
  db.query("INSERT INTO projects (id, name, path, created_at) VALUES ('pguard', 'app', ?, 0) ON CONFLICT(id) DO NOTHING").run(project);
  writeHookFiles();
  const hooks = JSON.parse(readFileSync(join(config.dataDir, "claude-hooks.json"), "utf8"));
  const command: string = hooks.hooks.PreToolUse.find((h: { matcher: string }) => h.matcher.includes("Bash")).hooks[0].command;

  const run = async (cmd: string, payload: unknown) => {
    const p = Bun.spawn(["sh", "-c", cmd], { stdin: new Blob([JSON.stringify(payload)]), stdout: "pipe", stderr: "pipe" });
    const [out, code] = [await new Response(p.stdout).text(), await p.exited];
    return { code, out: out ? JSON.parse(out) : null };
  };

  test("guard.json lists the projects, and Claude's hook refuses, asks or stays quiet", async () => {
    expect(JSON.parse(readFileSync(join(config.dataDir, "guard.json"), "utf8")).projects).toContain(project);
    expect(await run(command, { tool_name: "Bash", tool_input: { command: "rm -rf /" }, cwd: "/" })).toMatchObject({ code: 0, out: { hookSpecificOutput: { permissionDecision: "deny" } } });
    expect(await run(command, { tool_name: "Bash", tool_input: { command: "git reset --hard" }, cwd: project })).toMatchObject({ out: { hookSpecificOutput: { permissionDecision: "ask" } } });
    expect(await run(command, { tool_name: "Bash", tool_input: { command: "ls" }, cwd: project })).toEqual({ code: 0, out: null });
    expect(await run(command, "not json")).toEqual({ code: 0, out: null });
  });

  test("Codex gets the same guard as an inline hook it may run without a trust prompt", async () => {
    const argv = withHooks("codex", ["codex"], "sguard");
    expect(argv).toContain("--dangerously-bypass-hook-trust");
    const hook = argv.find((a) => a.startsWith("hooks.PreToolUse="))!;
    const codexCmd = JSON.parse(/command=("(?:[^"\\]|\\.)*")/.exec(hook)![1]!);
    expect(await run(codexCmd, { tool_name: "Bash", tool_input: { command: "git reset --hard" }, cwd: project })).toMatchObject({
      out: { hookSpecificOutput: { permissionDecision: "deny" } },
    });
  });
});
