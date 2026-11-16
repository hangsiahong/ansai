// Rules for the source itself. Each failure names file:line, what is wrong, and what to write instead.
import { describe, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const SELF = "src/server/rules.test.ts";

/** Per-file counts allowed today. Only ever lower these; a file not listed may have none. */
const ANY_BASELINE: Record<string, number> = {
  "src/server/accounts.ts": 3,
  "src/server/auth.ts": 3,
  "src/server/files.ts": 1,
  "src/server/hooks.ts": 2,
  "src/server/mcp.ts": 3,
  "src/server/models.ts": 5,
  "src/server/push.ts": 1,
  "src/server/transcripts.ts": 15,
  "src/server/usage.ts": 1,
  "src/web/chat.tsx": 4,
};

const EMPTY_CATCH_BASELINE: Record<string, number> = {
  "src/server/accounts.ts": 3,
  "src/server/attachments.ts": 1,
  "src/server/auth.ts": 1,
  "src/server/autopilot.ts": 3,
  "src/server/backup.ts": 2,
  "src/server/compaction.ts": 1,
  "src/server/config.ts": 1,
  "src/server/health.ts": 7,
  "src/server/holds.ts": 1,
  "src/server/hooks.ts": 3,
  "src/server/index.ts": 3,
  "src/server/limits.ts": 4,
  "src/server/models.ts": 1,
  "src/server/renew.ts": 1,
  "src/server/runs.ts": 1,
  "src/server/sessions.ts": 1,
  "src/server/shifts.ts": 3,
  "src/server/tasks.ts": 1,
  "src/server/team.ts": 1,
  "src/server/transcripts.ts": 4,
  "src/server/usage.ts": 3,
  "src/server/validate.ts": 1,
  "src/server/worktrees.ts": 4,
  "src/web/Terminal.tsx": 5,
  "src/web/crash.tsx": 2,
  "src/web/digest.tsx": 1,
  "src/web/main.tsx": 1,
  "src/web/models.tsx": 1,
  "src/web/notify.tsx": 1,
  "src/web/store.ts": 4,
  "src/web/system.tsx": 3,
  "src/web/ui.tsx": 1,
  "src/web/views/backlog.tsx": 1,
  "src/web/views/session.tsx": 2,
};

type Source = { path: string; text: string; lines: string[]; test: boolean };

const sources: Source[] = (readdirSync(join(ROOT, "src"), { recursive: true }) as string[])
  .map((rel) => `src/${rel.split("\\").join("/")}`)
  .filter((path) => /\.(tsx?|css|html)$/.test(path))
  .sort()
  .map((path) => {
    const text = readFileSync(join(ROOT, path), "utf8");
    return { path, text, lines: text.split("\n"), test: /\.test\.tsx?$/.test(path) || /\/test-[^/]*\.ts$/.test(path) };
  });
const code = sources.filter((s) => /\.tsx?$/.test(s.path));
const production = code.filter((s) => !s.test);
const server = production.filter((s) => s.path.startsWith("src/server/"));

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;
function restOfLine(text: string, from: number) {
  const end = text.indexOf("\n", from);
  return text.slice(from, end === -1 ? undefined : end);
}

/** `import ... from` path for `module`, as written in `from`. */
function importPath(from: string, module: string) {
  const rel = relative(dirname(from), module).replace(/\.tsx?$/, "");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function check(problems: string[]) {
  if (problems.length) throw new Error(`\n${problems.join("\n\n")}\n`);
}

// ------------------------------------------------------------------ shared helpers stay shared

const GIT = "src/server/git.ts";
const FILES = "src/server/files.ts";
const gitUse = (at: string) =>
  `import what you need from "${importPath(at, GIT)}": git(cwd, args, opts) resolves { code, stdout, stderr } (trimmed, never throws on a failed command); ` +
  `gitOut(cwd, args, opts) is stdout as written and throws on failure; gitSync(cwd, args, opts) is stdout or null. opts: { timeout, readOnly, config, env, bin }.`;
const jsonUse = (at: string) => `import { readJsonFile } from "${importPath(at, FILES)}": the parsed file, or null when it is missing or not JSON.`;
const lineUse = (at: string) =>
  `import { eachLine } from "${importPath(at, FILES)}": eachLine(path, start, (line: Buffer, at) => ..., { end, skipFirst, slice }) ` +
  `resolves to the offset past the last line, or null when there was none.`;

const HELPERS: Record<string, { home: string; what: string; use: (at: string) => string }> = {
  git: { home: GIT, what: "git helper", use: gitUse },
  gitOk: { home: GIT, what: "git helper", use: gitUse },
  gitIn: { home: GIT, what: "git helper", use: gitUse },
  gitOut: { home: GIT, what: "git helper", use: gitUse },
  gitSync: { home: GIT, what: "git helper", use: gitUse },
  runGit: { home: GIT, what: "git helper", use: gitUse },
  readJson: { home: FILES, what: "JSON file reader", use: jsonUse },
  readJsonFile: { home: FILES, what: "JSON file reader", use: jsonUse },
  eachLine: { home: FILES, what: "line reader", use: lineUse },
};
/** Same name, different job: reads a request body, not a file. */
const ALLOWED: Record<string, string[]> = { "src/server/validate.ts": ["readJson"] };

const DEFINES = new RegExp(String.raw`^\s*(?:export\s+)?(?:(?:async\s+)?function\s*\*?\s*|(?:const|let|var)\s+)(${Object.keys(HELPERS).join("|")})\b\s*[(<:=]`);
const SPAWNS_GIT = /\b(?:spawn|spawnSync|execFile|execFileSync|execSync|exec)\(\s*\[?\s*["'`]git\b|\$`git\b/;
const JSON_READER = /try\s*\{\s*return\s+JSON\.parse\(\s*readFileSync\(/g;
const SPLITS_BYTES = /\.indexOf\(\s*(?:10|0x0a)\s*[,)]/;

describe("shared helpers", () => {
  test("git, JSON files and log lines go through the shared modules, not local copies", () => {
    const problems: string[] = [];
    for (const s of server) {
      s.lines.forEach((line, i) => {
        const at = `${s.path}:${i + 1}`;
        const name = line.match(DEFINES)?.[1];
        if (name && HELPERS[name]!.home !== s.path && !ALLOWED[s.path]?.includes(name)) {
          problems.push(`${at}: defines its own ${HELPERS[name]!.what} \`${name}\`. Delete it and ${HELPERS[name]!.use(s.path)}`);
        }
        if (s.path !== GIT && SPAWNS_GIT.test(line)) {
          problems.push(`${at}: runs git directly. Use the shared helper so every call gets the same environment (no agent-session vars, no inherited GIT_DIR): ${gitUse(s.path)}`);
        }
        if (s.path !== FILES && SPLITS_BYTES.test(line)) {
          problems.push(`${at}: splits a file into lines by hand. Use the shared reader: ${lineUse(s.path)}`);
        }
      });
      if (s.path !== FILES) {
        for (const m of s.text.matchAll(JSON_READER)) problems.push(`${s.path}:${lineOf(s.text, m.index)}: a copy of the JSON file reader. Delete it and ${jsonUse(s.path)}`);
      }
    }
    check(problems);
  });
});

// ------------------------------------------------------------------ the web app stays out of the server

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

describe("web and server", () => {
  test("src/web never imports from src/server", () => {
    const problems: string[] = [];
    for (const s of code.filter((s) => s.path.startsWith("src/web/"))) {
      for (const m of s.text.matchAll(IMPORT)) {
        const spec = m[1]!;
        const target = spec.startsWith(".") ? relative(ROOT, resolve(ROOT, dirname(s.path), spec)).split("\\").join("/") : spec;
        if (!/(^|\/)src\/server(\/|$)/.test(target)) continue;
        problems.push(
          `${s.path}:${lineOf(s.text, m.index)}: imports "${spec}", which is server code; the browser bundle must not pull it in. ` +
            `Move what both sides need (usually a type) into a module outside src/server that imports nothing from it, and import that from both; or get the data through the API (src/web/api.ts).`,
        );
      }
    }
    check(problems);
  });
});

// ------------------------------------------------------------------ ratchets: counts may fall, never rise

const ANY = /(?::|\bas|[<,|&])\s*any\b|\bany(?=\[\])/g;
const EMPTY_CATCH = [/\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g, /\.catch\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*\{\s*\}\s*\)/g];

function ratchet(baseline: Record<string, number>, find: (s: Source) => number[], explain: (path: string, count: number, allowed: number, lines: number[]) => string) {
  const problems: string[] = [];
  for (const s of production) {
    const lines = find(s);
    const allowed = baseline[s.path] ?? 0;
    if (lines.length > allowed) problems.push(explain(s.path, lines.length, allowed, lines));
  }
  check(problems);
}

describe("ratchets", () => {
  test("no new `any`", () => {
    ratchet(
      ANY_BASELINE,
      (s) => s.lines.flatMap((line, i) => Array.from(line.matchAll(ANY), () => i + 1)),
      (path, count, allowed, lines) =>
        `${path}: ${count} \`any\` types, ${allowed} allowed. Type the new one as \`unknown\` and narrow it (typeof, Array.isArray, \`in\`, a type guard), or write the real type. ` +
        `They are at ${lines.map((l) => `${path}:${l}`).join(", ")}.`,
    );
  });

  test("no new empty catch", () => {
    ratchet(
      EMPTY_CATCH_BASELINE,
      (s) =>
        EMPTY_CATCH.flatMap((re) => Array.from(s.text.matchAll(re)))
          .filter((m) => !/\/[/*]/.test(restOfLine(s.text, m.index + m[0].length)))
          .map((m) => lineOf(s.text, m.index))
          .sort((a, b) => a - b),
      (path, count, allowed, lines) =>
        `${path}: ${count} empty catches, ${allowed} allowed. Handle the error (log it, return a fallback, rethrow), or keep swallowing it and say why that is safe ` +
        `in a one-line comment on the same line: \`} catch {} // <why>\` or \`.catch(() => {}); // <why>\`. They are at ${lines.map((l) => `${path}:${l}`).join(", ")}.`,
    );
  });
});

// ------------------------------------------------------------------ no work left in comments

describe("comments", () => {
  test("no TODO, FIXME, XXX or HACK", () => {
    const problems: string[] = [];
    for (const s of sources) {
      if (s.path === SELF) continue;
      s.lines.forEach((line, i) => {
        const word = line.match(/\b(TODO|FIXME|XXX|HACK)\b/)?.[1];
        if (word) problems.push(`${s.path}:${i + 1}: a ${word} comment. File it with the add_task tool (ansai backlog) instead of leaving a comment, and delete the comment.`);
      });
    }
    check(problems);
  });
});
