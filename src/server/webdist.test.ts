// The prebuilt web app: what the server hands out from it (exactly the files that were
// there, nothing a request can steer elsewhere), and how it decides whether there is a
// build for the commit it is running. Real files, a real HTTP server and real git repos.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAGE_PATHS, WEB_PREFIX, commitOf, findWebDist, hasChanges, loadWebDist, webRoutes } from "./webdist";

const root = mkdtempSync(join(tmpdir(), "ansai-webdist-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const PAGE = '<!doctype html><script type="module" src="/_app/chunk-abc123.js"></script>';
const SECRET = "TOP-SECRET-NEXT-TO-THE-BUILD";

/** A folder like the one scripts/build-web.ts writes, plus things a build never has but a request might aim at. */
function fixture(name: string) {
  const dir = join(root, name, "build");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(root, name, "secret.txt"), SECRET);
  writeFileSync(join(dir, "index.html"), PAGE);
  writeFileSync(join(dir, "chunk-abc123.js"), "console.log('app')");
  writeFileSync(join(dir, "chunk-def456.css"), "body{margin:0}");
  writeFileSync(join(dir, "font-9z.woff2"), "wOF2-bytes");
  writeFileSync(join(dir, "claude-1a2b.svg"), "<svg/>");
  writeFileSync(join(dir, "sub", "inner.js"), "inner");
  writeFileSync(join(dir, "we ird.js"), "odd name");
  symlinkSync(join(root, name, "secret.txt"), join(dir, "link.js"));
  return dir;
}

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

describe("what is served", () => {
  const dir = fixture("serve");
  const dist = loadWebDist(dir)!;

  test("the table holds the plain files of the build, and nothing else", () => {
    expect([...dist.files.keys()].sort()).toEqual(
      ["/_app/chunk-abc123.js", "/_app/chunk-def456.css", "/_app/claude-1a2b.svg", "/_app/font-9z.woff2"].sort(),
    );
  });

  test("the page: html, never cached, the file's own bytes", async () => {
    const r = dist.page();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/html;charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("no-cache");
    expect(await r.text()).toBe(PAGE);
  });

  test("a file: its type, cached for a year as immutable, the file's own bytes", async () => {
    const js = dist.asset("/_app/chunk-abc123.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toStartWith("text/javascript");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await js.text()).toBe("console.log('app')");
    expect(dist.asset("/_app/chunk-def456.css").headers.get("content-type")).toStartWith("text/css");
    expect(dist.asset("/_app/font-9z.woff2").headers.get("content-type")).toBe("font/woff2");
    expect(dist.asset("/_app/claude-1a2b.svg").headers.get("content-type")).toBe("image/svg+xml");
  });

  test("everything else under /_app/ is a 404 that isn't cached", async () => {
    const aimed = [
      "/_app/",
      "/_app",
      "/_app/nope.js",
      "/_app/index.html", // the page has its own addresses
      "/_app/sub/inner.js", // sub-folders aren't served
      "/_app/sub",
      "/_app/we%20ird.js", // names that aren't plain aren't served
      "/_app/we ird.js",
      "/_app/link.js", // a link could point anywhere
      "/_app/CHUNK-ABC123.JS", // exact match, not case-folded
      "/_app/chunk-abc123.js/",
      "/_app/chunk-abc123.js%00",
      "/_app/../secret.txt",
      "/_app/%2e%2e/secret.txt",
      "/_app/..%2fsecret.txt",
      "/_app/%2e%2e%2fsecret.txt",
      "/_app/..%5csecret.txt",
      "/_app/....//secret.txt",
      "/_app//chunk-abc123.js",
      "/_app/./chunk-abc123.js",
      "/_app/chunk-abc123.js/../secret.txt",
      "/secret.txt",
      "",
    ];
    for (const p of aimed) {
      const r = dist.asset(p);
      expect(r.status).toBe(404);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(await r.text()).not.toContain(SECRET);
    }
  });

  test("the list and the page are read once: a rebuilt folder changes nothing until a restart", async () => {
    writeFileSync(join(dir, "late-1.js"), "late");
    writeFileSync(join(dir, "index.html"), "<html>rebuilt</html>");
    expect(dist.asset("/_app/late-1.js").status).toBe(404);
    expect(await dist.page().text()).toBe(PAGE);
    const restarted = loadWebDist(dir)!; // a restart sees it
    expect(restarted.asset("/_app/late-1.js").status).toBe(200);
    expect(await restarted.page().text()).toBe("<html>rebuilt</html>");
  });

  test("a folder that isn't a build isn't loaded", () => {
    expect(loadWebDist(join(root, "does-not-exist"))).toBeNull();
    const noPage = join(root, "no-page");
    mkdirSync(noPage);
    writeFileSync(join(noPage, "chunk-1.js"), "x");
    expect(loadWebDist(noPage)).toBeNull();
    const pageIsFolder = join(root, "page-is-folder");
    mkdirSync(join(pageIsFolder, "index.html"), { recursive: true });
    expect(loadWebDist(pageIsFolder)).toBeNull();
  });
});

describe("over HTTP", () => {
  const dist = loadWebDist(fixture("http"))!;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: webRoutes(dist), fetch: () => new Response("fell through", { status: 404 }) });
  afterAll(() => server.stop(true));
  const at = (p: string, init?: RequestInit) => fetch(new URL(p, server.url), init);

  /** The request line exactly as written: fetch() would tidy up `..` before sending it. */
  function raw(path: string): Promise<{ status: number; body: string }> {
    return new Promise((done, fail) => {
      const s = connect(server.port!, "127.0.0.1");
      let data = "";
      s.on("connect", () => s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`));
      s.on("data", (d) => (data += d.toString("latin1")));
      s.on("error", fail);
      s.on("close", () => done({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1]), body: data.split("\r\n\r\n").slice(1).join("") }));
    });
  }

  test("every page address answers with the page, and the page names files under /_app/", async () => {
    for (const p of PAGE_PATHS) {
      const url = p.replace("*", "abc");
      const r = await at(url);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toStartWith("text/html");
      expect(r.headers.get("cache-control")).toBe("no-cache");
      expect(await r.text()).toBe(PAGE);
    }
    expect(PAGE).toContain(`src="${WEB_PREFIX}chunk-abc123.js"`);
  });

  test("files come with their type and the long cache; HEAD has no body", async () => {
    const r = await at("/_app/chunk-abc123.js");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await r.text()).toBe("console.log('app')");
    const head = await at("/_app/chunk-abc123.js", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await at("/", { method: "HEAD" })).status).toBe(200);
  });

  test("other methods and unknown files are 404s", async () => {
    expect((await at("/_app/nope.js")).status).toBe(404);
    expect((await at("/_app/chunk-abc123.js", { method: "POST", body: "x" })).status).toBe(404);
    expect((await at("/", { method: "POST", body: "x" })).status).toBe(404);
  });

  test("the request line is never turned into a path: dot segments and encodings find nothing", async () => {
    for (const p of [
      "/_app/../secret.txt",
      "/_app/%2e%2e/secret.txt",
      "/_app/..%2fsecret.txt",
      "/_app/%2e%2e%2fsecret.txt",
      "/_app/..%5csecret.txt",
      "/_app/....//secret.txt",
      "/_app/link.js",
      "/_app/sub/inner.js",
      "/_app/%00",
      "/_app/chunk-abc123.js%00.css",
      "/_app/index.html",
      "/_app//etc/passwd",
    ]) {
      const r = await raw(p);
      expect({ p, status: r.status }).toEqual({ p, status: 404 });
      expect(r.body).not.toContain(SECRET);
    }
  });
});

describe("is there a build for this commit?", () => {
  let repo: string;
  let sha: string;
  const build = (at: string, c: string) => {
    const d = join(at, "dist", "web", c);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "index.html"), PAGE);
    writeFileSync(join(d, "chunk-abc123.js"), "x");
  };

  beforeAll(() => {
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one");
    writeFileSync(join(repo, ".gitignore"), "dist\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "first");
    sha = git(repo, "rev-parse", "HEAD");
  });

  test("the full commit of a normal checkout", () => {
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(commitOf(repo)).toBe(sha);
  });

  test("a build for that commit is found; none yet means in-process, said in one line", () => {
    const none = findWebDist(repo);
    expect(none.dist).toBeNull();
    expect(none.note).toContain(`no prebuilt web app for ${sha.slice(0, 7)}`);
    build(repo, sha);
    const found = findWebDist(repo);
    expect(found.dist?.dir).toBe(join(repo, "dist", "web", sha));
    expect(found.note).toContain(`serving the prebuilt web app for ${sha.slice(0, 7)}`);
    expect(found.note).not.toContain("\n");
  });

  test("a build of another commit is never used: a new commit has none until it is built", () => {
    writeFileSync(join(repo, "a.txt"), "two");
    git(repo, "commit", "-qam", "second");
    const second = git(repo, "rev-parse", "HEAD");
    expect(second).not.toBe(sha);
    expect(findWebDist(repo).dist).toBeNull(); // dist/web/<first> is there, but isn't this commit's
    build(repo, second);
    expect(findWebDist(repo).dist?.dir).toBe(join(repo, "dist", "web", second));
    git(repo, "reset", "-q", "--hard", sha); // back to the older commit: its own build is found again
    expect(findWebDist(repo).dist?.dir).toBe(join(repo, "dist", "web", sha));
    git(repo, "reset", "-q", "--hard", second);
  });

  test("edited files mean the build is not this folder's: in-process, but new untracked files don't count", () => {
    const head = git(repo, "rev-parse", "HEAD");
    build(repo, head);
    writeFileSync(join(repo, "new-file.txt"), "untracked");
    expect(hasChanges(repo)).toBe(false);
    expect(findWebDist(repo).dist).not.toBeNull();
    writeFileSync(join(repo, "a.txt"), "edited");
    expect(hasChanges(repo)).toBe(true);
    const r = findWebDist(repo);
    expect(r.dist).toBeNull();
    expect(r.note).toContain("files changed");
    git(repo, "checkout", "--", "a.txt");
    expect(findWebDist(repo).dist).not.toBeNull();
  });

  test("a git worktree finds its own commit and its own dist folder", () => {
    const wt = join(root, "wt");
    git(repo, "worktree", "add", "-q", "--detach", wt, sha);
    expect(commitOf(wt)).toBe(sha);
    expect(findWebDist(wt).dist).toBeNull();
    build(wt, sha);
    expect(findWebDist(wt).dist?.dir).toBe(join(wt, "dist", "web", sha));
  });

  test("no git, no repository, no commits, or no folder: no crash, in-process", () => {
    expect(findWebDist(repo, "", "no-such-git-program").dist).toBeNull();
    expect(findWebDist(repo, "", "no-such-git-program").note).toContain("can't tell");
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(commitOf(plain)).toBeNull();
    expect(findWebDist(plain).dist).toBeNull();
    const empty = join(root, "empty-repo");
    mkdirSync(empty);
    git(empty, "init", "-q", "-b", "main");
    expect(commitOf(empty)).toBeNull();
    expect(findWebDist(empty).dist).toBeNull();
    expect(findWebDist(join(root, "gone")).dist).toBeNull();
  });

  test("a GIT_DIR from whoever started the server doesn't point it at another repository", () => {
    const other = join(root, "other");
    mkdirSync(other);
    git(other, "init", "-q", "-b", "main");
    writeFileSync(join(other, "b.txt"), "b");
    git(other, "add", "-A");
    git(other, "commit", "-qm", "other");
    const before = process.env.GIT_DIR;
    process.env.GIT_DIR = join(other, ".git");
    try {
      expect(commitOf(repo)).toBe(git(repo, "rev-parse", "HEAD"));
    } finally {
      if (before === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = before;
    }
  });

  test("ANSAI_WEB_DIST names a build folder directly, with no git involved", () => {
    const dir = fixture("override");
    const r = findWebDist(join(root, "gone"), dir, "no-such-git-program");
    expect(r.dist?.dir).toBe(dir);
    expect(r.note).toContain("ANSAI_WEB_DIST");
    const bad = findWebDist(repo, join(root, "no-build-here"));
    expect(bad.dist).toBeNull();
    expect(bad.note).toContain("ANSAI_WEB_DIST holds no built web app");
  });
});
