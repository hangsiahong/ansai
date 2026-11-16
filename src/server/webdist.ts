import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The web app, built ahead of time.
 *
 * Without this, Bun bundles the web app inside the server process on the first page load,
 * and the memory that takes (tens of MB) stays for as long as the service runs. A release
 * builds the app once instead (scripts/build-web.ts, into dist/web/<commit>/ of the folder
 * the service runs from) and the server only hands those files out.
 *
 * The folder is named after the full commit the server is running, so a build can never be
 * for the wrong version: going back to an older commit finds that commit's build, or none,
 * and with none the server falls back to Bun's own HTML import, exactly as before.
 */

/** Where the built files are served, and the public path the build bakes into the page. It is
 *  absolute because the page itself is served at nested addresses (/p/<id>, /s/<id>). */
export const WEB_PREFIX = "/_app/";

/** Every address that answers with the app's one page; the app draws the right screen itself. */
export const PAGE_PATHS = [
  "/",
  "/p/*",
  "/backlog",
  "/projects",
  "/accounts",
  "/system",
  "/s/*",
  "/crash-test", // a page that fails on purpose, to see (and test) the error screen
] as const;

/** Built file names are hashed, so they only ever hold letters, digits, dots, dashes and underscores. */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const FOREVER = "public, max-age=31536000, immutable";

export type WebDist = {
  dir: string;
  /** Request path (/_app/<name>) to the file behind it. This is the only thing ever served from /_app/. */
  files: ReadonlyMap<string, { path: string; type: string }>;
  page(): Response;
  /** `pathname` is the request's path as the URL parser gives it. Anything not in `files` is a 404. */
  asset(pathname: string): Response;
};

/** The built app in `dir`, or null when `dir` doesn't hold one (no index.html). */
export function loadWebDist(dir: string): WebDist | null {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  // Regular files only (a link could point anywhere), listed once here: a request is looked up
  // in this table as-is and never turned into a path, so there is nothing to traverse.
  const files = new Map<string, { path: string; type: string }>();
  let hasPage = false;
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name === "index.html") hasPage = true;
    else if (SAFE_NAME.test(e.name)) files.set(WEB_PREFIX + e.name, { path: join(dir, e.name), type: Bun.file(join(dir, e.name)).type });
  }
  if (!hasPage) return null;
  // The page is under a kilobyte and names the other files, so it is read here with the list:
  // the two can't drift apart if the folder is rebuilt while this process runs.
  let pageHtml;
  try {
    pageHtml = readFileSync(join(dir, "index.html"));
  } catch {
    return null; // unreadable: better no build than a server that doesn't start
  }
  return {
    dir,
    files,
    page: () => new Response(pageHtml, { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" } }),
    asset(pathname) {
      const f = files.get(pathname);
      if (!f) return new Response("not found", { status: 404, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
      return new Response(Bun.file(f.path), { headers: { "content-type": f.type, "cache-control": FOREVER } });
    },
  };
}

/** Bun's route table for the prebuilt app: the page at every page address, the files under /_app/. */
export function webRoutes(dist: WebDist) {
  const page = () => dist.page();
  const asset = (req: Request) => dist.asset(new URL(req.url).pathname);
  const routes: Record<string, { GET: (req: Request) => Response; HEAD: (req: Request) => Response }> = {};
  for (const p of PAGE_PATHS) routes[p] = { GET: page, HEAD: page };
  routes[WEB_PREFIX + "*"] = { GET: asset, HEAD: asset };
  return routes;
}

// ----------------------------------------------------------------------- finding the build

/** Output of a git command run in `dir`, or null when it fails (no git, not a repository, …). */
function git(dir: string, args: string[], bin = "git"): string | null {
  try {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" } as Record<string, string | undefined>;
    for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[k]; // a caller's repository, not this one
    const r = Bun.spawnSync([bin, "-C", dir, ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

/** The full commit a checkout (or git worktree, or release folder) is on; null if it can't be told. */
export function commitOf(dir: string, bin = "git"): string | null {
  const sha = git(dir, ["rev-parse", "HEAD"], bin);
  return sha && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/** Whether tracked files differ from the commit: then a build of that commit isn't what this folder holds. */
export function hasChanges(dir: string, bin = "git"): boolean {
  const out = git(dir, ["status", "--porcelain", "--untracked-files=no"], bin);
  return out === null || out !== "";
}

/**
 * The prebuilt web app this server should use, if there is one, and a line saying what it did.
 * `override` (env ANSAI_WEB_DIST) names a build folder directly, for tests; otherwise it's
 * <checkout>/dist/web/<commit>, and only when the checkout is exactly that commit.
 */
export function findWebDist(checkout: string, override = "", bin = "git"): { dist: WebDist | null; note: string } {
  if (override) {
    const dist = loadWebDist(override);
    return dist
      ? { dist, note: `serving the prebuilt web app from ANSAI_WEB_DIST (${dist.files.size + 1} files)` }
      : { dist: null, note: "ANSAI_WEB_DIST holds no built web app (no index.html), so the page is built inside this process on first use" };
  }
  const commit = commitOf(checkout, bin);
  if (!commit) return { dist: null, note: "can't tell which commit this is (no git here?), so the page is built inside this process on first use" };
  const short = commit.slice(0, 7);
  if (hasChanges(checkout, bin)) return { dist: null, note: `files changed since ${short}, so the page is built inside this process on first use` };
  const dist = loadWebDist(join(checkout, "dist", "web", commit));
  return dist
    ? { dist, note: `serving the prebuilt web app for ${short} (dist/web/${commit}, ${dist.files.size + 1} files)` }
    : { dist: null, note: `no prebuilt web app for ${short} (dist/web/${commit} is missing), so the page is built inside this process on first use` };
}
