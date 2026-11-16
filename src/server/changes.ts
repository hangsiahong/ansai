import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { conflict } from "./errors";
import { git, gitOut, type GitOpts } from "./git";
import { projectCheckout } from "./worktrees";

/**
 * What an agent changed in a folder, as a reviewable diff.
 *
 * In a task worktree (a linked Git worktree) the diff is against the point
 * where its branch left the branch of its project's folder, so it covers the task's
 * commits plus anything not committed yet. In an ordinary checkout it is the
 * uncommitted work against HEAD. New files that Git doesn't track yet are
 * included either way, since agents usually don't commit.
 */

export type FileChange = {
  path: string;
  oldPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  additions: number;
  deletions: number;
  binary: boolean;
  /** Unified diff hunks, from the first @@ line; empty for binary files. */
  patch: string;
  truncated: boolean;
};

export type Changes = {
  dir: string;
  branch: string | null;
  /** What the diff is against: `label` is a branch name or "last commit". */
  base: { label: string; sha: string };
  worktree: boolean;
  commits: { sha: string; subject: string; at: number }[];
  /** Files with changes that aren't committed yet (including new files). */
  uncommitted: number;
  files: FileChange[];
  additions: number;
  deletions: number;
  /** Some files or patches were left out because the change is very large. */
  truncated: boolean;
};

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_FILES = 300;
const MAX_UNTRACKED = 100;
const MAX_FILE_LINES = 2000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;

// Read-only, so we never trip up an agent's own git commands; paths unquoted and messages in English, so output parses the same everywhere.
const READ: GitOpts = { readOnly: true, timeout: 20_000, env: { LC_ALL: "C" }, config: { "core.quotePath": "false" } };

/** Undo Git's C-style quoting of unusual path names ("a\tb" → a<TAB>b). */
function unquote(s: string): string {
  if (!s.startsWith('"') || !s.endsWith('"')) return s;
  const bytes: number[] = [];
  const body = s.slice(1, -1);
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      bytes.push(...Buffer.from(c));
      continue;
    }
    const n = body[++i]!;
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(esc[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

const pathOf = (line: string, prefix: string) => {
  const p = unquote(line.slice(prefix.length).replace(/\t$/, ""));
  return p === "/dev/null" ? null : p.replace(/^[ab]\//, "");
};

function clip(hunks: string[]): { patch: string; truncated: boolean } {
  let bytes = 0;
  for (let i = 0; i < hunks.length; i++) {
    bytes += hunks[i]!.length + 1;
    if (i >= MAX_FILE_LINES || bytes > MAX_FILE_BYTES) return { patch: hunks.slice(0, i).join("\n"), truncated: true };
  }
  return { patch: hunks.join("\n"), truncated: false };
}

/** Split `git diff` output into one entry per file. */
function parsePatch(text: string): FileChange[] {
  const files: FileChange[] = [];
  const chunks = text.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));
  for (const chunk of chunks) {
    const lines = chunk.replace(/\n$/, "").split("\n");
    let status: FileChange["status"] = "modified";
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let binary = false;
    let i = 1;
    for (; i < lines.length && !lines[i]!.startsWith("@@"); i++) {
      const l = lines[i]!;
      if (l.startsWith("new file mode")) status = "added";
      else if (l.startsWith("deleted file mode")) status = "deleted";
      else if (l.startsWith("rename from ")) ((status = "renamed"), (oldPath = unquote(l.slice(12))));
      else if (l.startsWith("rename to ")) newPath = unquote(l.slice(10));
      else if (l.startsWith("--- ")) oldPath ??= pathOf(l, "--- ");
      else if (l.startsWith("+++ ")) newPath ??= pathOf(l, "+++ ");
      else if (l.startsWith("Binary files ") || l === "GIT binary patch") binary = true;
    }
    if (!newPath && !oldPath) {
      // No ---/+++ lines (binary or mode-only change): take the name from the header.
      const rest = lines[0]!.slice("diff --git ".length);
      if (rest.startsWith('"')) {
        const m = rest.match(/^("(?:[^"\\]|\\.)*") /);
        oldPath = m ? unquote(m[1]!).replace(/^a\//, "") : rest;
      } else {
        const len = (rest.length - 5) / 2; // "a/<p> b/<p>"
        oldPath = Number.isInteger(len) ? rest.slice(2, 2 + len) : rest;
      }
      newPath = oldPath;
    }
    const hunks = lines.slice(i);
    let additions = 0;
    let deletions = 0;
    for (const h of hunks) {
      if (h.startsWith("+")) additions++;
      else if (h.startsWith("-")) deletions++;
    }
    const { patch, truncated } = clip(hunks);
    files.push({
      path: (status === "deleted" ? oldPath : newPath) ?? oldPath ?? "?",
      oldPath: status === "renamed" ? oldPath : null,
      status,
      additions,
      deletions,
      binary,
      patch: binary ? "" : patch,
      truncated,
    });
  }
  return files;
}

function untrackedFile(dir: string, path: string): FileChange {
  const base: FileChange = { path, oldPath: null, status: "untracked", additions: 0, deletions: 0, binary: false, patch: "", truncated: false };
  const full = join(dir, path);
  try {
    const st = statSync(full);
    if (!st.isFile()) return base;
    if (st.size > MAX_FILE_BYTES * 4) return { ...base, truncated: true };
    const buf = readFileSync(full);
    if (buf.subarray(0, 8000).includes(0)) return { ...base, binary: true };
    const text = buf.toString("utf8");
    const lines = text.replace(/\n$/, "").split("\n");
    if (text === "") return base;
    const { patch, truncated } = clip([`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => "+" + l)]);
    return { ...base, additions: lines.length, patch, truncated };
  } catch {
    return base;
  }
}

/** The diff for a folder (a project checkout or a task worktree). */
export async function changesIn(dir: string): Promise<Changes> {
  if (!existsSync(dir)) throw conflict(`folder no longer exists: ${dir}`);
  if (!Bun.which("git")) throw conflict("git is not installed");
  if ((await git(dir, ["rev-parse", "--show-toplevel"], READ)).code !== 0) throw conflict("this folder isn't in a Git repository");

  const hasHead = (await git(dir, ["rev-parse", "--verify", "-q", "HEAD"], READ)).code === 0;
  const branchOut = await git(dir, ["symbolic-ref", "-q", "--short", "HEAD"], READ);
  const branch = branchOut.code === 0 ? branchOut.stdout : null;

  const [gitDir, commonDir] = (await gitOut(dir, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], READ)).trim().split("\n");
  const worktree = !!gitDir && !!commonDir && realpathSync(gitDir) !== realpathSync(commonDir);

  let base: Changes["base"] = { label: "last commit", sha: hasHead ? (await gitOut(dir, ["rev-parse", "HEAD"], READ)).trim() : EMPTY_TREE };
  if (!hasHead) base.label = "empty repository";
  if (worktree && hasHead) {
    // Compare against where this branch left the project's branch: for a task's worktree that
    // is its project's own folder (which may be a linked worktree itself); otherwise the
    // repository's main checkout (a bare repository has none: the last commit it is).
    let against = await projectCheckout(dir);
    if (!against) {
      const list = await gitOut(dir, ["worktree", "list", "--porcelain"], READ);
      const main = list.split("\n\n")[0] ?? "";
      against = { path: "", branch: main.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null, head: main.match(/^HEAD ([0-9a-f]+)$/m)?.[1] ?? null };
    }
    const ref = against.branch ?? against.head;
    if (ref) {
      const mb = await git(dir, ["merge-base", "HEAD", ref], READ);
      if (mb.code === 0 && mb.stdout) base = { label: against.branch ?? "main checkout", sha: mb.stdout };
    }
  }

  const diffArgs = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "--src-prefix=a/", "--dst-prefix=b/", "--relative"];
  const [patchOut, untrackedOut, dirtyOut, logOut] = await Promise.all([
    gitOut(dir, [...diffArgs, base.sha, "--", "."], READ),
    gitOut(dir, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."], READ),
    hasHead ? gitOut(dir, ["diff", "--name-only", "--relative", "-z", "HEAD", "--", "."], READ) : Promise.resolve(""),
    worktree && hasHead && base.label !== "last commit"
      ? gitOut(dir, ["log", "--format=%H%x1f%s%x1f%ct", "-n", "50", `${base.sha}..HEAD`], READ)
      : Promise.resolve(""),
  ]);

  let files = parsePatch(patchOut);
  const untracked = untrackedOut.split("\0").filter(Boolean);
  let truncated = untracked.length > MAX_UNTRACKED;
  files.push(...untracked.slice(0, MAX_UNTRACKED).map((p) => untrackedFile(dir, p)));
  files.sort((a, b) => a.path.localeCompare(b.path));

  if (files.length > MAX_FILES) ((files = files.slice(0, MAX_FILES)), (truncated = true));
  let total = 0;
  for (const f of files) {
    total += f.patch.length;
    if (total > MAX_TOTAL_BYTES) ((f.patch = ""), (f.truncated = true), (truncated = true));
  }

  const commits = logOut
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha = "", subject = "", at = "0"] = l.split("\x1f");
      return { sha, subject, at: Number(at) * 1000 };
    });

  return {
    dir,
    branch,
    base: { label: base.label, sha: base.sha },
    worktree,
    commits,
    uncommitted: dirtyOut.split("\0").filter(Boolean).length + untracked.length,
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    truncated,
  };
}

/** The folder a task's agent works in: its worktree, or the project folder for tasks without one. */
export async function taskDir(task: { worktree_path: string | null }, projectPath: string): Promise<string> {
  if (!task.worktree_path) return projectPath;
  // A project inside a monorepo works in the matching subfolder of the worktree.
  const root = await git(projectPath, ["rev-parse", "--show-toplevel"], READ);
  if (root.code !== 0) return task.worktree_path;
  const sub = relative(realpathSync(root.stdout), realpathSync(projectPath));
  return sub ? join(task.worktree_path, sub) : task.worktree_path;
}
