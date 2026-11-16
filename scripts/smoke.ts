#!/usr/bin/env bun
/**
 * Browser smoke test: does the web app still open and work, on a phone and on a desktop?
 *
 *   bun run smoke
 *
 * Starts its own ansai (a temporary home, its own port and tmux server; never the one you
 * use), adds a project, a task and a shell session, then drives a real browser through
 * the things you do every day: open Now, open a session, open a task, open Settings. It
 * also opens a page that fails on purpose and checks the error screen shows up instead of
 * a blank page. Exits 1 on the first thing that doesn't work, and keeps a screenshot.
 *
 * ANSAI_SMOKE_SHOTS=<folder> also saves a picture of the error screen at each size.
 * Browser: $ANSAI_SMOKE_BROWSER (a path), else Playwright's own download
 * (`bunx playwright-core install chromium`), else a Chrome/Chromium found on this machine.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

const repo = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "ansai-smoke-"));
const socket = `ansai-smoke-${process.pid}`;
const shots = join(scratch, "shots");
mkdirSync(shots);

const freePort = () =>
  new Promise<number>((done, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
  });

function findBrowser(): string | undefined {
  if (process.env.ANSAI_SMOKE_BROWSER) return process.env.ANSAI_SMOKE_BROWSER;
  if (existsSync(chromium.executablePath())) return undefined; // Playwright's own
  for (const name of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"]) {
    const r = spawnSync("which", [name], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  throw new Error("No browser to test with. Run `bunx playwright-core install chromium`, or set ANSAI_SMOKE_BROWSER to a Chrome/Chromium path.");
}

let step = "starting";
const say = (s: string) => {
  step = s;
  console.log(`  ${s}`);
};
function check(ok: unknown, what: string): asserts ok {
  if (!ok) throw new Error(what);
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let log = "";
// The agent that runs this may itself be an ansai session: its own ids must not reach the test server.
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("ANSAI_")) env[k] = v;
const server = spawn(process.execPath, [join(repo, "src/server/index.ts")], {
  cwd: repo,
  env: { ...env, ANSAI_HOME: join(scratch, "home"), ANSAI_PORT: String(port), ANSAI_TMUX_SOCKET: socket, ANSAI_ROOTS: scratch },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout!.on("data", (d) => (log += d));
server.stderr!.on("data", (d) => (log += d));

const api = async (path: string, body?: unknown) => {
  const r = await fetch(base + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  check(r.ok, `${path} answered ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
};

let browser: Browser | undefined;
let failed = false;
try {
  say("start a separate ansai");
  for (let i = 0; ; i++) {
    if (await fetch(`${base}/api/me`).then((r) => r.ok, () => false)) break;
    check(server.exitCode === null, `ansai stopped while starting:\n${log}`);
    check(i < 150, `ansai didn't answer within 30 s:\n${log}`);
    await Bun.sleep(200);
  }

  say("add a project, a task and a shell session");
  const dir = join(scratch, "demo");
  mkdirSync(dir);
  const project = await api("/api/projects", { path: dir });
  const task = await api("/api/tasks", { title: "Smoke test task", body: "Opened by the smoke test.", projectId: project.id });
  const session = await api("/api/sessions", { tool: "shell", projectId: project.id, title: "Smoke test shell" });

  browser = await chromium.launch({ executablePath: findBrowser() });

  const sizes = [
    { name: "phone", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    { name: "desktop", viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
  ];
  for (const size of sizes) {
    console.log(`${size.name} (${size.viewport.width}×${size.viewport.height})`);
    const ctx = await browser.newContext({ viewport: size.viewport, isMobile: size.isMobile, hasTouch: size.hasTouch, deviceScaleFactor: size.isMobile ? 3 : 1 });
    const page: Page = await ctx.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const tap = (target: ReturnType<Page["locator"]>) => (size.hasTouch ? target.tap() : target.click());
    const main = page.locator('nav[aria-label="Main"]');
    const noCrash = async (where: string) => {
      check(!(await page.locator(".crash-card").count()), `${where} shows the error screen: ${await page.locator(".crash-text").first().textContent().catch(() => "")}`);
      check(!errors.length, `${where} threw: ${errors.join(" / ")}`);
      // Nothing may stick out past the side of the screen (a sideways-scrolling page).
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(over <= 1, `${where} is ${over}px wider than the screen`);
    };

    try {
      say("open Now");
      await page.goto(base + "/");
      await page.locator(".pane.now").waitFor();
      await page.getByText("Smoke test shell").first().waitFor();
      await noCrash("Now");

      say("open the session");
      await tap(page.getByText("Smoke test shell").first());
      await page.waitForURL(`**/s/${session.id}`);
      await page.locator(".pane.session").waitFor();
      await page.locator(".pane.session .xterm, .pane.session .chat").first().waitFor();
      await noCrash("The session");

      say("open the task from the backlog");
      await page.goto(base + "/backlog");
      await tap(page.getByText("Smoke test task").first());
      const taskSheet = page.locator('[role="dialog"]');
      await taskSheet.waitFor();
      // The title and the details are fields you can edit: look at what they hold.
      const fields = () => taskSheet.locator("input, textarea").evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
      for (let i = 0; !(await fields()).includes("Opened by the smoke test.") && i < 25; i++) await Bun.sleep(200);
      check((await fields()).includes("Smoke test task") && (await fields()).includes("Opened by the smoke test."), `the task sheet doesn't show the task: ${JSON.stringify(await fields())}`);
      await noCrash("The task sheet");
      await tap(taskSheet.locator('button[aria-label="Close"]'));
      await taskSheet.waitFor({ state: "detached" });

      say("open Settings");
      await page.goto(base + "/");
      await page.locator(".pane.now").waitFor();
      await tap(size.isMobile ? page.locator('button[aria-label="Settings"]') : page.locator(".side-foot .side-row"));
      const settings = page.locator('[role="dialog"][aria-label="Settings"]');
      await settings.waitFor();
      await settings.getByText("Appearance").waitFor();
      await noCrash("Settings");
      await tap(settings.locator('button[aria-label="Close"]'));
      await settings.waitFor({ state: "detached" });

      say("a page that fails shows the error screen, and the rest still works");
      await page.goto(base + "/crash-test");
      const crash = page.locator(".crash-card");
      await crash.waitFor();
      check((await crash.locator(".crash-text").textContent())?.includes("fails on purpose"), "the error screen doesn't say what went wrong");
      if (process.env.ANSAI_SMOKE_SHOTS) await page.screenshot({ path: join(process.env.ANSAI_SMOKE_SHOTS, `error-screen-${size.name}.png`) });
      await crash.getByRole("button", { name: "Reload" }).waitFor();
      await main.waitFor(); // the tab bar / sidebar is still there to leave by
      await tap(main.getByText("Backlog").first());
      await page.getByText("Smoke test task").first().waitFor();
      check(!(await page.locator(".crash-card").count()), "the error screen stayed after going to another page");
      check(!errors.length, `the failing page escaped the error screen: ${errors.join(" / ")}`);
    } catch (e) {
      const shot = join(shots, `${size.name}.png`);
      await page.screenshot({ path: shot }).catch(() => {});
      throw new Error(`${size.name}, "${step}": ${e instanceof Error ? e.message : e}\n  screenshot: ${shot}`);
    }
    await ctx.close();
  }

  say("the laptop's log has the page that failed");
  for (let i = 0; !log.includes("web app error") && i < 25; i++) await Bun.sleep(200);
  check(/web app error on .*\(page at \/crash-test\): Error: This page fails on purpose/.test(log), `the error never reached ansai's log:\n${log.slice(-800)}`);

  void task;
  console.log("\nSmoke test passed.");
} catch (e) {
  failed = true;
  console.error(`\nSmoke test FAILED: ${e instanceof Error ? e.message : e}`);
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
  rmSync(join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.()}`, socket), { force: true }); // tmux leaves the socket file behind
  if (failed) console.error(`  kept for a look: ${scratch}`);
  else rmSync(scratch, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
