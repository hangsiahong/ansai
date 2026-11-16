/**
 * The destructive-command guard: every Claude and Codex agent ansai starts runs this before each
 * shell command and file write (their PreToolUse hook). It is its own process so it still works
 * while ansai restarts, and it imports nothing from the server so it starts in a few ms.
 *
 * Not a sandbox: it stops the handful of commands an agent should never run by itself. "deny"
 * blocks; "ask" makes Claude ask you (a "Needs you" push with Allow/Deny). Codex can't ask, so it
 * is told no. Run: bun guard.ts <claude|codex> <guard.json>, with the hook's JSON on stdin.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readJsonFile } from "./files";

export type GuardHit = { level: "deny" | "ask"; reason: string };
export type GuardContext = {
  cwd: string;
  home: string;
  /** ansai's own folder (database, logins, the running release). */
  dataDir: string;
  /** The main checkouts of ansai's projects: shared by every agent working on that project. */
  projects: string[];
  /** tmux sockets the live agents run on. */
  sockets: string[];
  /** Folders where deleting is always fine. */
  tmp?: string[];
  env?: Record<string, string | undefined>;
};

const SYSTEM_DIRS = ["/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib32", "/lib64", "/media", "/mnt", "/nix", "/opt", "/proc", "/root", "/run", "/sbin", "/snap", "/srv", "/sys", "/usr", "/var"];
const SAFE_DEV = /^\/dev\/(null|zero|full|u?random|stdin|stdout|stderr|tty\w*|fd\/.*|pts\/.*|shm(\/.*)?)$/;
const PREFIX = "ansai guard:";

const within = (path: string, dir: string) => path === dir || path.startsWith(dir === "/" ? "/" : `${dir}/`);
const inside = (path: string, dir: string) => path !== dir && within(path, dir);

type Place = { path: string; what: string };

/** Never removed whole by an agent: deleting one of these, or a folder holding one, is refused. */
function roots(c: GuardContext): Place[] {
  const h = (p: string) => join(c.home, p);
  return [
    { path: "/", what: "the whole filesystem" },
    ...SYSTEM_DIRS.map((path) => ({ path, what: "a system folder" })),
    ...tmps(c).map((path) => ({ path, what: "every agent's scratch files" })),
    { path: c.home, what: "your home folder" },
    { path: h(".ssh"), what: "your SSH keys" },
    { path: h(".gnupg"), what: "your GPG keys" },
    { path: h(".config"), what: "every app's settings" },
    { path: h(".local"), what: "installed apps and their data" },
    { path: h(".claude"), what: "Claude Code's settings and login" },
    { path: h(".codex"), what: "Codex's settings and login" },
    { path: c.dataDir, what: "ansai's database, logins and running release" },
    { path: join(c.dataDir, "profiles"), what: "the agents' logins" },
    { path: join(c.dataDir, "release"), what: "the running ansai" },
    { path: join(c.dataDir, "backups"), what: "ansai's database backups" },
  ];
}

/** Files an agent asks before deleting or overwriting (`tree`: anything inside the folder too). */
function keeps(c: GuardContext): (Place & { tree?: true })[] {
  return [
    ...["ansai.db", "ansai.db-wal", "ansai.db-shm"].map((f) => ({ path: join(c.dataDir, f), what: "ansai's database" })),
    { path: join(c.dataDir, "vapid.json"), what: "the key your phone's notifications are signed with" },
    { path: join(c.home, ".codex", "auth.json"), what: "Codex's login" },
    { path: join(c.home, ".ssh"), what: "your SSH keys and config", tree: true },
    { path: join(c.home, ".gnupg"), what: "your GPG keys", tree: true },
  ];
}

const tmps = (c: GuardContext) => [...new Set(c.tmp ?? ["/tmp", "/var/tmp", tmpdir(), "/dev/shm"])];

/** `path` is a file the agent must not overwrite (or delete) without asking. */
function keptFile(path: string, c: GuardContext): GuardHit | null {
  if (path.startsWith("/dev/") && !SAFE_DEV.test(path)) return { level: "deny", reason: `${PREFIX} this writes straight onto the device ${path}, wiping what is on it.` };
  if (basename(path) === ".credentials.json")
    return { level: "ask", reason: `${PREFIX} ${path} is a Claude login. ansai renews logins itself (claude auth status); never write or delete this file.` };
  const k = keeps(c).find((k) => (k.tree ? inside(path, k.path) : path === k.path));
  return k ? { level: "ask", reason: `${PREFIX} ${path} is ${k.what}. Leave it alone unless the user asked for exactly this.` } : null;
}

/** Deleting `path` (`whole`: with everything under it, as rm -r or mv does). */
function deleting(path: string, whole: boolean, c: GuardContext, remote: boolean): GuardHit | null {
  if (whole) {
    const r = roots(c).find((r) => within(r.path, path));
    if (r)
      return {
        level: "deny",
        reason: `${PREFIX} this deletes ${path}${r.path === path ? `, ${r.what}` : `, which holds ${r.path} (${r.what})`}. Agents never do that; delete only the specific files you need.`,
      };
  }
  const kept = keptFile(path, c);
  if (kept) return kept;
  if (whole && !remote && existsSync(join(path, ".credentials.json")))
    return { level: "ask", reason: `${PREFIX} ${path} holds a Claude login. ansai manages logins on its Accounts page; don't delete it.` };
  if (!whole || tmps(c).some((t) => within(path, t))) return null;
  const project = c.projects.find((p) => within(p, path));
  if (project)
    return {
      level: "ask",
      reason: `${PREFIX} this deletes ${project === path ? path : `${path}, which holds ${project}`}: an ansai project, with every agent's uncommitted work in it. Delete specific build folders instead.`,
    };
  if (!remote && (basename(path) === ".git" || existsSync(join(path, ".git"))))
    return {
      level: "ask",
      reason: `${PREFIX} ${path} is ${basename(path) === ".git" ? "a repository's whole history" : "a git repository, history and uncommitted work included"}. Remove a worktree with \`git worktree remove\`; otherwise delete the specific folders you made.`,
    };
  if (SYSTEM_DIRS.includes(dirname(path)) && !["/home", "/tmp"].includes(dirname(path)))
    return { level: "ask", reason: `${PREFIX} this deletes ${path}, a system folder. Only do this if the user asked for exactly this.` };
  return null;
}

// ------------------------------------------------------------------ reading the shell command

type Seg = { k: "lit" | "q" | "var" | "sub"; v: string };
type Word = { segs: Seg[]; raw: string };
type Heredoc = { delim: string; strip: boolean; body: string };
type Tok = { t: "word"; w: Word } | { t: "op"; v: string } | { t: "redir"; v: string; doc?: Heredoc };

const OPS = ["&&", "||", ";;", "|&", ";", "|", "&", "(", ")"];
const REDIR = /^(\d*)(<<<|<<-|<<|<>|<&|>&|>>|>\||&>>|&>|<|>)/;
const META = new Set([" ", "\t", "\r", "\n", ";", "&", "|", "(", ")", "<", ">"]);

/** End of a $( … ) starting just after the "(": balanced, skipping quoted text. */
function closeParen(s: string, i: number): number {
  let depth = 1;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\\") i += 2;
    else if (c === "'") i = s.indexOf("'", i + 1) === -1 ? s.length : s.indexOf("'", i + 1) + 1;
    else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
      i++;
    } else if (c === "(") (depth++, i++);
    else if (c === ")") {
      if (--depth === 0) return i + 1;
      i++;
    } else i++;
  }
  return s.length;
}

/** A $… expansion at s[i] (the "$"): the segment, and where it ends. */
function dollar(s: string, i: number): [Seg, number] {
  const n = s[i + 1];
  if (n === "(") {
    const end = closeParen(s, i + 2);
    return s[i + 2] === "(" ? [{ k: "var", v: "" }, end] : [{ k: "sub", v: s.slice(i + 2, end - 1) }, end];
  }
  if (n === "{") {
    const end = s.indexOf("}", i + 2);
    return end === -1 ? [{ k: "var", v: "" }, s.length] : [{ k: "var", v: s.slice(i + 2, end) }, end + 1];
  }
  const m = /^([A-Za-z_]\w*|[0-9@*#?$!-])/.exec(s.slice(i + 1));
  return m ? [{ k: "var", v: m[1]! }, i + 1 + m[1]!.length] : [{ k: "lit", v: "$" }, i + 1];
}

function lex(s: string): Tok[] {
  const toks: Tok[] = [];
  const docs: Heredoc[] = [];
  let wantDelim: Heredoc | null = null;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\\" && s[i + 1] === "\n") {
      i += 2;
      continue;
    }
    if (c === "\n") {
      toks.push({ t: "op", v: "\n" });
      i++;
      for (const d of docs.splice(0)) {
        while (i < s.length) {
          const nl = s.indexOf("\n", i);
          const line = s.slice(i, nl === -1 ? s.length : nl);
          i = nl === -1 ? s.length : nl + 1;
          if ((d.strip ? line.replace(/^\t+/, "") : line) === d.delim) break;
          d.body += `${line}\n`;
        }
      }
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    const r = REDIR.exec(s.slice(i, i + 8));
    if (r && (r[1] || !/\d/.test(c))) {
      const tok: Tok = { t: "redir", v: r[2]! };
      if (r[2] === "<<" || r[2] === "<<-") docs.push((wantDelim = tok.doc = { delim: "", strip: r[2] === "<<-", body: "" }));
      toks.push(tok);
      i += r[0].length;
      continue;
    }
    const op = OPS.find((o) => s.startsWith(o, i));
    if (op) {
      toks.push({ t: "op", v: op });
      i += op.length;
      continue;
    }
    const start = i;
    const segs: Seg[] = [];
    const lit = (k: "lit" | "q", v: string) => (segs.at(-1)?.k === k ? (segs.at(-1)!.v += v) : segs.push({ k, v }));
    while (i < s.length && !META.has(s[i]!)) {
      const ch = s[i]!;
      if (ch === "'") {
        const end = s.indexOf("'", i + 1);
        lit("q", s.slice(i + 1, end === -1 ? s.length : end));
        i = end === -1 ? s.length : end + 1;
      } else if (ch === "$" && s[i + 1] === "'") {
        let j = i + 2;
        let v = "";
        while (j < s.length && s[j] !== "'") {
          if (s[j] === "\\") j++;
          v += s[j - 1] === "\\" ? ({ n: "\n", t: "\t" }[s[j]!] ?? s[j]) : s[j];
          j++;
        }
        lit("q", v);
        i = j + 1;
      } else if (ch === '"') {
        i++;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === "\\" && /[$`"\\\n]/.test(s[i + 1] ?? "")) {
            lit("q", s[i + 1]!);
            i += 2;
          } else if (s[i] === "$") {
            const [seg, end] = dollar(s, i);
            seg.k === "lit" ? lit("q", seg.v) : segs.push(seg);
            i = end;
          } else if (s[i] === "`") {
            const end = s.indexOf("`", i + 1);
            segs.push({ k: "sub", v: s.slice(i + 1, end === -1 ? s.length : end) });
            i = end === -1 ? s.length : end + 1;
          } else lit("q", s[i++]!);
        }
        i++;
      } else if (ch === "$") {
        const [seg, end] = dollar(s, i);
        seg.k === "lit" ? lit("lit", seg.v) : segs.push(seg);
        i = end;
      } else if (ch === "`") {
        const end = s.indexOf("`", i + 1);
        segs.push({ k: "sub", v: s.slice(i + 1, end === -1 ? s.length : end) });
        i = end === -1 ? s.length : end + 1;
      } else if (ch === "\\") {
        lit("q", s[i + 1] ?? "");
        i += 2;
      } else lit("lit", s[i++]!);
    }
    const w: Word = { segs, raw: s.slice(start, i) };
    if (wantDelim) {
      wantDelim.delim = segs.map((g) => g.v).join("");
      wantDelim = null;
    }
    toks.push({ t: "word", w });
  }
  return toks;
}

type Cmd = { words: Word[]; redirs: { op: string; to?: Word; doc?: Heredoc }[]; raw: string; piped: boolean };

/** Simple commands in order; `piped`: its stdin comes from the command before it. */
function commands(toks: Tok[]): Cmd[] {
  const out: Cmd[] = [];
  let cur: Cmd = { words: [], redirs: [], raw: "", piped: false };
  const flush = (next: { piped: boolean }) => {
    if (cur.words.length || cur.redirs.length) out.push(cur);
    cur = { words: [], redirs: [], raw: "", piped: next.piped };
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.t === "op") flush({ piped: t.v === "|" || t.v === "|&" });
    else if (t.t === "redir") {
      const to = toks[i + 1]?.t === "word" ? (toks[++i] as { w: Word }).w : undefined;
      cur.redirs.push({ op: t.v, to, doc: t.doc });
      cur.raw += ` ${t.v}${to?.raw ?? ""}`;
    } else {
      cur.words.push(t.w);
      cur.raw += ` ${t.w.raw}`;
    }
  }
  flush({ piped: false });
  return out;
}

// ------------------------------------------------------------------ judging it

type State = { cwd: string | null; vars: Map<string, string | null>; remote: boolean; depth: number };
type Arg = { v: string | null; glob: boolean; raw: string };

const GLOB = /[*?[]|\{[^}]*,[^}]*\}/;

function expand(w: Word, st: State, c: GuardContext): Arg {
  let v = "";
  let glob = false;
  for (const [i, g] of w.segs.entries()) {
    if (g.k === "lit") {
      let text = g.v;
      if (i === 0 && (text === "~" || text.startsWith("~/"))) text = c.home + text.slice(1);
      if (GLOB.test(text)) glob = true;
      v += text;
    } else if (g.k === "q") v += g.v;
    else if (g.k === "sub") {
      if (g.v.trim() !== "pwd" || !st.cwd) return { v: null, glob, raw: w.raw };
      v += st.cwd;
    } else {
      const m = /^([A-Za-z_]\w*)(?::?-(.*))?$/.exec(g.v);
      if (!m) return { v: null, glob, raw: w.raw };
      const name = m[1]!;
      const known = st.vars.has(name) ? st.vars.get(name)! : name === "HOME" ? c.home : name === "PWD" ? st.cwd : (c.env?.[name] ?? null);
      const value = known || (m[2] !== undefined ? m[2] : known);
      if (value === null || value === undefined) return { v: null, glob, raw: w.raw };
      v += value;
    }
  }
  return { v, glob, raw: w.raw };
}

function abs(p: string, st: State): string | null {
  if (isAbsolute(p)) return resolve(p);
  return st.cwd ? resolve(st.cwd, p) : null;
}

/** The places a path argument stands for: `dir/*` stands for `dir`; another glob for every guarded place it matches. */
function places(a: Arg, st: State, c: GuardContext): string[] {
  if (a.v === null || a.v === "") return [];
  const p = abs(a.v, st);
  if (!p) return [];
  if (!a.glob) return [p];
  const parts = p.split("/");
  const at = parts.findIndex((x) => GLOB.test(x));
  if (at === parts.length - 1 && /^[.*]+$|^\{[.*,]+\}$/.test(parts[at]!)) return [resolve(parts.slice(0, at).join("/") || "/")];
  const glob = new Bun.Glob(p);
  const candidates = [...roots(c).map((r) => r.path), ...keeps(c).map((k) => k.path), ...c.projects];
  const hits = new Set<string>();
  for (const cand of candidates) for (let q = cand; ; q = dirname(q)) {
    if (glob.match(q)) hits.add(q);
    if (q === "/") break;
  }
  return [...hits];
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const KEYWORDS = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "{", "}", "fi", "done", "esac", "time"]);
const name = (a: Arg | undefined) => (a?.v ? basename(a.v) : "");
const flags = (args: Arg[]) => args.filter((a) => a.v?.startsWith("-") && a.v !== "-").map((a) => a.v!);
const has = (args: Arg[], long: string[], short = "") =>
  flags(args).some((f) => long.includes(f) || long.some((l) => f.startsWith(`${l}=`)) || (short && /^-[^-]/.test(f) && [...short].some((s) => f.slice(1).includes(s))));

/** Drop wrappers (sudo, env, nohup, xargs…) down to the command that runs; may change the folder (env -C). */
function unwrap(args: Arg[], st: State): Arg[] {
  for (let guard = 0; guard < 10 && args.length; guard++) {
    const n = name(args[0]);
    const skip = (withValue: string[]) => {
      let i = 1;
      while (i < args.length && args[i]!.v?.startsWith("-") && args[i]!.v !== "--") i += withValue.includes(args[i]!.v!) ? 2 : 1;
      if (args[i]?.v === "--") i++;
      return args.slice(i);
    };
    if (n === "sudo") args = skip(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T"]);
    else if (n === "doas") args = skip(["-u", "-C"]);
    else if (n === "env") {
      let i = 1;
      for (; i < args.length; i++) {
        const v = args[i]!.v ?? "";
        if (v === "-C" || v === "--chdir") st.cwd = args[++i]?.v ? abs(args[i]!.v!, st) : null;
        else if (v === "-u" || v === "--unset") i++;
        else if (!v.startsWith("-") && !/^[A-Za-z_]\w*=/.test(v)) break;
      }
      args = args.slice(i);
    } else if (["nohup", "command", "builtin", "chronic", "unbuffer", "busybox"].includes(n)) {
      if (n === "command" && has(args, [], "vV")) return [];
      args = skip([]);
    } else if (n === "exec") args = skip(["-a"]);
    else if (n === "nice") args = skip(["-n", "--adjustment"]);
    else if (n === "ionice") args = skip(["-c", "-n", "-p", "-t"]);
    else if (n === "stdbuf") args = skip(["-i", "-o", "-e"]);
    else if (n === "timeout") args = skip(["-s", "--signal", "-k", "--kill-after"]).slice(1);
    else if (n === "watch") args = skip(["-n", "--interval", "-d"]);
    else if (n === "flock") args = skip(["-w", "--timeout", "-E"]).slice(1);
    else if (n === "xargs") args = skip(["-I", "-L", "-n", "-P", "-d", "-E", "-s", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file"]);
    else if (n === "time") args = skip(["-f", "-o"]);
    else return args;
  }
  return args;
}

const FIND_FILTERS = /^-(i?name|i?path|i?wholename|i?regex|newer\w*|[acm](time|min)|size|empty|user|group|perm|links|inum|samefile|uid|gid)$/;
const DISK_TOOLS = /^(mkfs(\..+)?|mke2fs|mkswap|mkntfs|mkdosfs|mkfs\.\w+|blkdiscard)$/;
const DB_CLIENT = /^(psql|pgcli|mysql|mariadb|mycli|sqlite3?|litecli|duckdb|mongosh|mongo|redis-cli|valkey-cli|clickhouse(-client)?|cqlsh|sqlcmd|cockroach|turso)$/;
const FILE_DB = /^(sqlite3?|litecli|duckdb)$/;
const DROPS_DATA = /\b(drop\s+(database|schema|table|keyspace|collection)\b|truncate\s+(table\s+)?[\w"`'.]+|flushall\b|flushdb\b|dropdatabase\s*\(|delete\s+from\s+[\w"`.[\]]+\s*(;|$|"|'|\)))/im;
const DB_RUNNERS = new Set(["prisma", "rails", "rake", "bundle", "php", "python", "python3", "django-admin", "sqlx", "diesel", "sea-orm-cli", "docker", "docker-compose", "podman", "npx", "bunx", "pnpm", "pnpx", "yarn", "npm", "bun", "uv", "poetry", "cargo", "dropdb"]);
const WIPES_DB = [
  /^dropdb\b/,
  /\bprisma\s+migrate\s+reset\b/,
  /\bprisma\s+db\s+push\b.*--(force-reset|accept-data-loss)\b/,
  /\b(rails|rake)\s+db:(drop|reset|purge)\b/,
  /\bartisan\s+(migrate:(fresh|reset)|db:wipe)\b/,
  /\b(manage\.py|django-admin)\s+(flush|reset_db)\b/,
  /\bsqlx\s+(database|db)\s+(drop|reset)\b/,
  /\bdiesel\s+database\s+reset\b/,
  /\bsea-orm-cli\s+migrate\s+(fresh|refresh|reset)\b/,
  /\b(docker|podman)\s+volume\s+(rm|prune)\b/,
  /\b(docker|podman)\s+system\s+prune\b.*\s--volumes\b/,
  /\b(docker[\s-]compose|podman-compose)\b.*\sdown\b.*\s(-v|--volumes)\b/,
];
const SQL_ASK = `${PREFIX} this deletes data from a database. If the user asked for exactly this, they can allow it; otherwise work on a copy or a test database.`;
const SHARED = (top: string, what: string) =>
  `${PREFIX} ${what} in ${top}, the project's main checkout, which other agents share: it would throw away their uncommitted work too. ` +
  `Undo only your own files (git checkout -- <file>, or git show HEAD:<file>), or do this in a task worktree.`;

/** The repository `dir` is in: its top folder, and whether that is a linked worktree. */
function repoOf(dir: string): { top: string; linked: boolean; gitDir: string } | null {
  for (let d = dir; ; d = dirname(d)) {
    const g = join(d, ".git");
    try {
      const s = statSync(g);
      if (s.isDirectory()) return { top: d, linked: false, gitDir: g };
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(g, "utf8"));
      return { top: d, linked: true, gitDir: m ? resolve(d, m[1]!.trim()) : g };
    } catch {} // no .git here: look one folder up
    if (d === "/") return null;
  }
}

function branchOf(gitDir: string): string | null {
  try {
    return /^ref:\s*refs\/heads\/(.+)$/m.exec(readFileSync(join(gitDir, "HEAD"), "utf8"))?.[1]?.trim() ?? null;
  } catch {
    return null; // detached or unreadable: nothing to compare against main
  }
}

function judgeGit(args: Arg[], st: State, c: GuardContext): GuardHit | null {
  let dir = st.cwd;
  let i = 1;
  for (; i < args.length; i++) {
    const v = args[i]!.v;
    if (v === "-C") dir = args[++i]?.v ? (dir ? resolve(dir, args[i]!.v!) : abs(args[i]!.v!, st)) : null;
    else if (v === "-c" || v === "--git-dir" || v === "--work-tree" || v === "--namespace") i++;
    else if (!v?.startsWith("-")) break;
  }
  const sub = args[i]?.v;
  const rest = args.slice(i + 1);
  const repo = dir && !st.remote ? repoOf(dir) : null;
  const shared = repo && !repo.linked && c.projects.some((p) => resolve(p) === repo.top) ? repo.top : null;

  if (sub === "push") {
    const force = has(rest, ["--force", "--force-with-lease", "--mirror", "--delete"], "fd");
    const positional = rest.filter((a) => a.v !== null && !a.v.startsWith("-")).map((a) => a.v!);
    const specs = positional.slice(1);
    const forced = force || specs.some((s) => s.startsWith("+") || s.startsWith(":"));
    if (!forced) return null;
    const head = repo ? branchOf(repo.gitDir) : null;
    const targets = specs.length ? specs.map((s) => s.replace(/^\+/, "").split(":").at(-1)!.replace(/^refs\/heads\//, "")) : [head];
    const hit = has(rest, ["--all", "--mirror"]) || targets.some((t) => (t === "HEAD" ? head : t) === "main" || (t === "HEAD" ? head : t) === "master");
    return hit
      ? { level: "ask", reason: `${PREFIX} a forced push (or delete) to main rewrites history everyone else has. Push your own branch and merge it instead.` }
      : null;
  }
  if (!shared) return null;
  if (sub === "reset" && has(rest, ["--hard", "--merge"])) return { level: "ask", reason: SHARED(shared, "git reset --hard") };
  if (sub === "clean" && has(rest, ["--force"], "f") && !has(rest, ["--dry-run"], "n")) return { level: "ask", reason: SHARED(shared, "git clean") };
  const everything = rest.some((a) => a.v !== null && /^(\.|\.\/|\*|:\/|:\(top\).*)$/.test(a.v));
  if (sub === "checkout" && (everything || has(rest, ["--force"], "f"))) return { level: "ask", reason: SHARED(shared, "git checkout of every file") };
  if (sub === "restore" && everything && (!has(rest, ["--staged"], "S") || has(rest, ["--worktree"], "W"))) return { level: "ask", reason: SHARED(shared, "git restore of every file") };
  if (sub === "stash" && (!rest.length || ["push", "save", "clear", "-u", "--include-untracked", "-a", "--all", "-k", "--keep-index", "-m", "--message", "-p"].includes(rest[0]!.v ?? "")))
    return { level: "ask", reason: SHARED(shared, "git stash") };
  return null;
}

/** The live tmux server a bare `tmux` talks to from inside an agent's pane. */
const tmuxSocket = (c: GuardContext) => (c.env?.TMUX ? basename(c.env.TMUX.split(",")[0]!) : "default");

function judgeCmd(cmd: Cmd, st: State, c: GuardContext, hits: GuardHit[], pipeText: string) {
  let args = cmd.words.map((w) => expand(w, st, c));
  for (const w of cmd.words) for (const g of w.segs) if (g.k === "sub") judgeScript(g.v, { ...st, vars: new Map(st.vars), depth: st.depth + 1 }, c, hits);

  for (const r of cmd.redirs) {
    if (!r.to || !r.op.includes(">") || (r.op === ">&" && /^\d+$/.test(r.to.raw))) continue;
    const to = expand(r.to, st, c);
    for (const p of places(to, st, c)) {
      const hit = keptFile(p, c);
      if (hit) hits.push(hit);
    }
  }

  const assigns = args.findIndex((a) => !/^[A-Za-z_]\w*=/.test(a.raw));
  if (assigns === -1) {
    for (const a of args) {
      const k = a.raw.slice(0, a.raw.indexOf("="));
      st.vars.set(k, a.v === null ? null : a.v.slice(k.length + 1));
    }
    return;
  }
  args = args.slice(assigns);
  while (args.length && KEYWORDS.has(args[0]!.v ?? "")) args = args.slice(1);
  if (["for", "select", "case", "function"].includes(args[0]?.v ?? "")) {
    if (args[1]?.v) st.vars.set(args[1].v, null);
    return;
  }
  if (["export", "local", "declare", "readonly", "typeset"].includes(args[0]?.v ?? "")) {
    for (const a of args.slice(1)) {
      const m = /^([A-Za-z_]\w*)=/.exec(a.raw);
      if (m) st.vars.set(m[1]!, a.v === null ? null : a.v.slice(a.v.indexOf("=") + 1));
    }
    return;
  }
  args = unwrap(args, st);
  const n = name(args[0]);
  const rest = args.slice(1);
  const positional = (from = rest) => {
    const out: Arg[] = [];
    let opts = true;
    for (const a of from) {
      if (opts && a.v === "--") opts = false;
      else if (!opts || !a.v?.startsWith("-") || a.v === "-") out.push(a);
    }
    return out;
  };
  const add = (h: GuardHit | null) => h && hits.push(h);
  const del = (as: Arg[], whole: boolean) => as.forEach((a) => places(a, st, c).forEach((p) => add(deleting(p, whole, c, st.remote))));

  if (n === "cd" || n === "pushd") {
    const to = rest[0];
    st.cwd = !to ? c.home : to.v === null ? null : to.v === "-" ? st.cwd : abs(to.v, st);
  } else if (n === "rm" || n === "unlink") del(positional(), has(rest, ["--recursive"], "rR"));
  else if (n === "shred") positional().forEach((a) => places(a, st, c).forEach((p) => add(keptFile(p, c))));
  else if (n === "mv") {
    const t = rest.findIndex((a) => a.v === "-t" || a.v?.startsWith("--target-directory"));
    const ps = positional().filter((a) => t === -1 || a !== rest[t + 1] || rest[t]!.v !== "-t");
    del(t === -1 ? ps.slice(0, -1) : ps, true);
    if (t === -1 && ps.length > 1) places(ps.at(-1)!, st, c).forEach((p) => add(keptFile(p, c)));
  } else if (n === "cp" || n === "install") {
    const ps = positional();
    if (ps.length > 1) places(ps.at(-1)!, st, c).forEach((p) => add(keptFile(p, c)));
  } else if (n === "rsync" && has(rest, ["--delete", "--delete-before", "--delete-after", "--delete-during", "--delete-excluded", "--del"])) {
    const dest = positional().at(-1);
    if (dest?.v && !/^[^/]*:/.test(dest.v)) del([dest], true);
  } else if (["chmod", "chown", "chgrp"].includes(n) && has(rest, ["--recursive"], "R")) {
    for (const a of positional().slice(has(rest, ["--reference"]) ? 0 : 1))
      for (const p of places(a, st, c)) {
        const r = roots(c).find((r) => within(r.path, p));
        if (r) add({ level: "deny", reason: `${PREFIX} this changes permissions on everything in ${p} (${r.what}). Change only the files you need.` });
      }
  } else if (n === "find" && (rest.some((a) => a.v === "-delete") || rest.some((a, i) => /^-(exec|execdir|ok)$/.test(a.v ?? "") && /^(rm|shred|unlink)$/.test(name(rest[i + 1]))))) {
    if (!rest.some((a) => FIND_FILTERS.test(a.v ?? ""))) {
      const start = rest.findIndex((a) => /^[-(!]/.test(a.v ?? ""));
      del(rest.slice(0, start === -1 ? rest.length : start), true);
    }
  } else if (n === "dd") {
    for (const a of rest) if (a.v?.startsWith("of=")) places({ ...a, v: a.v.slice(3) }, st, c).forEach((p) => add(keptFile(p, c)));
  } else if (DISK_TOOLS.test(n) || (n === "cryptsetup" && rest.some((a) => /^luksFormat$|^erase$/.test(a.v ?? "")))) {
    if (rest.some((a) => a.v?.startsWith("/dev/") && !SAFE_DEV.test(a.v))) add({ level: "deny", reason: `${PREFIX} ${n} wipes the disk it is given. Agents never format disks.` });
  } else if (n === "wipefs" && has(rest, ["--all", "--offset"], "ao")) add({ level: "deny", reason: `${PREFIX} wipefs erases a disk's signatures. Agents never do that.` });
  else if (["fdisk", "sfdisk", "cfdisk", "gdisk", "sgdisk", "parted"].includes(n)) {
    const reads = has(rest, ["--list", "--dump", "--json", "--print", "--info", "--verify"], n === "parted" ? "l" : n === "sgdisk" ? "piv" : "ldJ") || (n === "parted" && rest.some((a) => a.v === "print") && !rest.some((a) => /^(mklabel|mktable|mkpart|rm|resizepart|rescue|mkfs)$/.test(a.v ?? "")));
    if (!reads && rest.some((a) => a.v?.startsWith("/dev/"))) add({ level: "deny", reason: `${PREFIX} ${n} rewrites a disk's partitions. Agents never do that.` });
  } else if (n === "git") add(judgeGit(args, st, c));
  else if (n === "tmux" && rest.some((a) => a.v === "kill-server")) {
    const l = rest.findIndex((a) => a.v === "-L" || a.v === "-S");
    const socket = l === -1 ? tmuxSocket(c) : basename(rest[l + 1]?.v ?? "");
    if (c.sockets.includes(socket))
      add({ level: "deny", reason: `${PREFIX} this tmux server runs every agent ansai has, you included. Kill only your own: tmux -L ansai-<topic> kill-server.` });
  } else if ((n === "pkill" || n === "killall") && positional().some((a) => /(^|[^\w-])(tmux|claude|codex|ansai|bun)([^\w-]|$)/i.test(a.v ?? ""))) {
    add({ level: "ask", reason: `${PREFIX} that name also matches the agents or ansai itself. Kill only the process you started, by its pid.` });
  } else if (n === "systemctl" && rest.some((a) => /^(stop|kill|disable|mask)$/.test(a.v ?? "")) && rest.some((a) => /^ansai(\.service)?$/.test(a.v ?? ""))) {
    add({ level: "ask", reason: `${PREFIX} this stops ansai, so nothing watches the agents. Ship changes with ./scripts/release.sh, which restarts it safely.` });
  } else if (n === "gh" && rest[0]?.v === "repo" && rest[1]?.v === "delete") add({ level: "ask", reason: `${PREFIX} this deletes the GitHub repository. Only if the user asked for exactly this.` });
  else if (SHELLS.has(n) || n === "eval" || n === "ssh") {
    const remote = n === "ssh";
    let script: string | null = null;
    if (n === "eval") script = rest.map((a) => a.v ?? "").join(" ");
    else if (remote) {
      const withValue = new Set(["-p", "-i", "-l", "-o", "-F", "-J", "-L", "-R", "-D", "-b", "-c", "-E", "-e", "-I", "-m", "-O", "-Q", "-S", "-W", "-w", "-B"]);
      let i = 0;
      while (i < rest.length && rest[i]!.v?.startsWith("-")) i += withValue.has(rest[i]!.v!) ? 2 : 1;
      script = rest.slice(i + 1).map((a) => a.v ?? "").join(" ") || null;
    } else {
      const ci = rest.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a.v ?? ""));
      if (ci !== -1) script = rest[ci + 1]?.v ?? null;
    }
    const doc = cmd.redirs.find((r) => r.doc)?.doc?.body;
    const sub: State = { ...st, vars: new Map(st.vars), depth: st.depth + 1, ...(remote ? { remote: true, cwd: c.home } : {}) };
    if (script) judgeScript(script, sub, c, hits);
    else if (doc && (remote || !positional().length)) judgeScript(doc, sub, c, hits);
  }

  if (DB_CLIENT.test(n)) {
    const file = FILE_DB.test(n) ? positional()[0]?.v : null;
    const scratch = file === ":memory:" || (file && abs(file, st) && tmps(c).some((t) => within(abs(file, st)!, t)));
    const text = `${cmd.raw}\n${cmd.redirs.map((r) => r.doc?.body ?? "").join("\n")}\n${cmd.piped ? pipeText : ""}`;
    if (!scratch && DROPS_DATA.test(text)) add({ level: "ask", reason: SQL_ASK });
  }
  if (DB_RUNNERS.has(n)) {
    const line = [n, ...rest.map((a) => a.v ?? "")].join(" ");
    if (WIPES_DB.some((re) => re.test(line))) add({ level: "ask", reason: SQL_ASK });
  }
}

function judgeScript(script: string, st: State, c: GuardContext, hits: GuardHit[]) {
  if (st.depth > 4) return;
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(script)) hits.push({ level: "deny", reason: `${PREFIX} that is a fork bomb.` });
  let pipeText = "";
  for (const cmd of commands(lex(script))) {
    pipeText = cmd.piped ? pipeText : "";
    judgeCmd(cmd, st, c, hits, pipeText);
    pipeText += cmd.raw;
  }
}

/** Everything wrong with a shell command, worst first (empty when it may run). */
export function judgeCommand(command: string, c: GuardContext): GuardHit[] {
  const hits: GuardHit[] = [];
  judgeScript(command, { cwd: c.cwd, vars: new Map(), remote: false, depth: 0 }, c, hits);
  return hits.sort((a, b) => (a.level === b.level ? 0 : a.level === "deny" ? -1 : 1));
}

const WRITES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The verdict on one tool call (the PreToolUse payload's tool_name and tool_input), or null to let it run. */
export function judgeTool(tool: unknown, input: unknown, c: GuardContext): GuardHit | null {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (tool === "Bash") {
    const cmd = Array.isArray(o.command) ? o.command.map((x) => quote(String(x))).join(" ") : typeof o.command === "string" ? o.command : "";
    const hits = judgeCommand(cmd, c);
    if (!hits.length) return null;
    const reasons = [...new Set(hits.filter((h) => h.level === hits[0]!.level).map((h) => h.reason))];
    return { level: hits[0]!.level, reason: reasons.slice(0, 2).join(" ") };
  }
  if (typeof tool === "string" && WRITES.has(tool)) {
    const file = o.file_path ?? o.notebook_path;
    return typeof file === "string" ? keptFile(isAbsolute(file) ? resolve(file) : resolve(c.cwd, file), c) : null;
  }
  return null;
}

/** The hook's answer: Claude asks you on "ask"; Codex can't, so it is told no. */
export function hookReply(hit: GuardHit, agent: string) {
  const ask = hit.level === "ask" && agent !== "codex";
  const reason = hit.level === "ask" && !ask ? `${hit.reason} If the user asked for exactly this, tell them it was blocked and why; they can run it themselves.` : hit.reason;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: ask ? "ask" : "deny", permissionDecisionReason: reason } };
}

/** What guard.json says (written by ansai at each agent start), with this machine's defaults for anything missing. */
export function loadContext(file: string | undefined, cwd: unknown): GuardContext {
  const j: unknown = file ? readJsonFile(file) : null;
  const o = (j && typeof j === "object" ? j : {}) as Record<string, unknown>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    cwd: typeof cwd === "string" && cwd ? cwd : process.cwd(),
    home: typeof o.home === "string" ? o.home : homedir(),
    dataDir: typeof o.dataDir === "string" ? o.dataDir : file ? dirname(file) : join(homedir(), ".ansai"),
    projects: strings(o.projects),
    sockets: o.sockets ? strings(o.sockets) : ["ansai"],
    env: process.env,
  };
}

if (import.meta.main) {
  const [agent = "claude", file] = process.argv.slice(2);
  let payload: { tool_name?: unknown; tool_input?: unknown; cwd?: unknown } = {};
  try {
    payload = JSON.parse(await Bun.stdin.text());
  } catch {
    process.exit(0); // not a hook payload: nothing to judge
  }
  const hit = judgeTool(payload.tool_name, payload.tool_input, loadContext(file, payload.cwd));
  if (hit) process.stdout.write(JSON.stringify(hookReply(hit, agent)));
}
