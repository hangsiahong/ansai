import { cleanEnv } from "./env";

export type GitOpts = {
  /** Kill git after this many ms. No limit by default. */
  timeout?: number;
  /** GIT_OPTIONAL_LOCKS=0: never take index.lock, so an agent's own git commands in that folder don't trip on ours. */
  readOnly?: boolean;
  /** `-c key=value` for this call only. */
  config?: Record<string, string>;
  env?: Record<string, string>;
  /** The program to run; tests name one that doesn't exist. */
  bin?: string;
};

export type GitResult = { code: number; stdout: string; stderr: string };

const argv = (cwd: string, args: string[], o: GitOpts) => [
  o.bin ?? "git",
  "-C",
  cwd,
  ...Object.entries(o.config ?? {}).flatMap(([k, v]) => ["-c", `${k}=${v}`]),
  ...args,
];

function env(o: GitOpts): Record<string, string> {
  const e = cleanEnv();
  // Set when ansai is started from a git hook; they would point every call at that repository.
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete e[k];
  return { ...e, ...(o.readOnly ? { GIT_OPTIONAL_LOCKS: "0" } : {}), ...o.env };
}

async function run(cwd: string, args: string[], o: GitOpts) {
  const p = Bun.spawn(argv(cwd, args, o), { env: env(o), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: o.timeout });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout, stderr };
}

/** `git -C cwd …args`, never throwing on a failed command; stdout and stderr are trimmed. Throws only when git can't be started. */
export async function git(cwd: string, args: string[], opts: GitOpts = {}): Promise<GitResult> {
  const r = await run(cwd, args, opts);
  return { code: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

/** stdout exactly as git wrote it (diffs, -z lists); throws `git <command>: <stderr>` when the command fails. */
export async function gitOut(cwd: string, args: string[], opts: GitOpts = {}): Promise<string> {
  const r = await run(cwd, args, opts);
  if (r.code !== 0) throw new Error(`git ${args[0]}: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout;
}

/** Trimmed stdout, or null when the command fails or git can't be run at all. Blocks: for startup checks only. */
export function gitSync(cwd: string, args: string[], opts: GitOpts = {}): string | null {
  try {
    const r = Bun.spawnSync(argv(cwd, args, opts), { env: env(opts), stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: opts.timeout });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  } catch {
    return null; // no such program
  }
}
