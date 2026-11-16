// Merging a task of ansai's own project releases it: when that happens at all, the release
// queue, and what each way release.sh ends tells your phone. Fakes stand in for git, systemd and push.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { db, getSetting, setSetting } = await import("./db");
const sr = await import("./selfrelease");
const { updateSettings } = await import("./autopilot");

const SRC = realpathSync(mkdtempSync(join(tmpdir(), "ansai-src-")));
const OTHER = realpathSync(mkdtempSync(join(tmpdir(), "ansai-other-")));

let source: string | null = SRC;
let live: string | null = "live0";
/** Pairs "a<b": a is an ancestor of b. */
let ancestry = new Set<string>();
let started: { sha: string; unit: string; log: string; exit: string }[] = [];
let active = new Set<string>();
let startError: Error | null = null;
let pushed: { kind: string; title: string; body: string; url: string }[] = [];

sr.setReleaseDeps({
  source: () => source,
  live: async () => live,
  contains: async (_src, a, b) => a === b || ancestry.has(`${a}<${b}`),
  start: async (_src, sha, unit, log, exit) => {
    if (startError) throw startError;
    started.push({ sha, unit, log, exit });
    active.add(unit);
  },
  active: async (unit) => active.has(unit),
  notify: async (kind, n) => {
    pushed.push({ kind, title: n.title, body: n.body, url: n.url });
  },
});
afterAll(() => sr.setReleaseDeps(null));

const task = (id: string, project = "ansai") => ({ id, title: `Task ${id}`, project_id: project });

/** release.sh ends: its output and exit code land where the unit writes them. */
function ends(code: number, out = "") {
  const run = started.at(-1)!;
  writeFileSync(run.log, out);
  writeFileSync(run.exit, `${code}\n`);
  active.delete(run.unit);
}

beforeEach(() => {
  db.query("DELETE FROM settings WHERE key LIKE 'self-release:%' OR key = 'release_on_merge'").run();
  db.query("INSERT OR REPLACE INTO projects (id, name, path, created_at) VALUES ('ansai', 'ansai', ?, 0)").run(SRC);
  db.query("INSERT OR REPLACE INTO projects (id, name, path, created_at) VALUES ('other', 'other', ?, 0)").run(OTHER);
  source = SRC;
  live = "live0";
  ancestry = new Set(["live0<m1", "live0<m2", "m1<m2"]);
  started = [];
  active = new Set();
  startError = null;
  pushed = [];
});

describe("when a merge releases", () => {
  test("a merge in ansai's own project starts release.sh on the merged commit", async () => {
    expect(sr.releaseAfterMerge(task("t1"), "m1", "main")).toBe(true);
    await sr.releaseTick();
    expect(started.map((s) => s.sha)).toEqual(["m1"]);
    expect(sr.releaseStatus().running).toMatchObject({ sha: "m1", task: "t1" });
  });

  test("another project's merge doesn't", async () => {
    expect(sr.releaseAfterMerge(task("t1", "other"), "m1", "main")).toBe(false);
    await sr.releaseTick();
    expect(started).toEqual([]);
  });

  test("an ansai that isn't the released service never releases (a test instance, a checkout)", async () => {
    source = null;
    expect(sr.releaseAfterMerge(task("t1"), "m1", "main")).toBe(false);
    expect(sr.releaseStatus().available).toBe(false);
    await sr.releaseTick();
    expect(started).toEqual([]);
  });

  test("the switch in Settings turns it off", async () => {
    updateSettings({ releaseOnMerge: false });
    expect(sr.releaseAfterMerge(task("t1"), "m1", "main")).toBe(false);
    updateSettings({ releaseOnMerge: true });
    expect(sr.releaseAfterMerge(task("t1"), "m1", "main")).toBe(true);
  });
});

describe("how it ends", () => {
  test("live: your phone is told, and the result is kept for the Settings sheet", async () => {
    sr.releaseAfterMerge(task("t1"), "m1abcdef99", "main");
    ancestry.add("live0<m1abcdef99");
    await sr.releaseTick();
    ends(0, "ansai is now running m1abcde.");
    await sr.releaseTick();
    expect(pushed).toEqual([{ kind: "system", title: "ansai is updated", body: "Now running your merge of “Task t1” (m1abcde). Pull to refresh.", url: "/p/ansai" }]);
    expect(sr.releaseStatus()).toMatchObject({ running: null, pending: null, last: { sha: "m1abcdef99", ok: true } });
  });

  test("a failed check: nothing changed, and the reason says which check", async () => {
    sr.releaseAfterMerge(task("t1"), "m1", "main");
    await sr.releaseTick();
    ends(
      1,
      "Checking m1  Task t1\n  packages    ok\n  typecheck   ok\n  tests       FAILED\n(fail) something > broke\nrelease: tests failed, so nothing was changed. The full output is in /x/release-check.log\n",
    );
    await sr.releaseTick();
    expect(pushed[0]).toMatchObject({ title: "ansai didn't update", body: "The tests check failed, so nothing changed. Your merge of “Task t1” is kept on main." });
    expect(sr.releaseStatus().last).toMatchObject({ ok: false });
  });

  test("a version that didn't start: ansai went back", () => {
    const out =
      "Releasing m1  x\nBuilding the web app: ok\n\nThe new version didn't come up: it didn't answer on port 7777 within 40 seconds\nGoing back to live0  y\nansai is running the version from before again. Nothing was released.\n";
    expect(sr.whyFailed(out, 1)).toBe("The new version didn't come up: it didn't answer on port 7777 within 40 seconds ansai went back to the version from before.");
  });

  test("any other stop gives release.sh's own reason", () => {
    expect(sr.whyFailed("release: the ansai service isn't installed: run scripts/install-service.sh\n", 1)).toBe(
      "The ansai service isn't installed: run scripts/install-service.sh.",
    );
  });

  test("a unit that vanished without a result is a failure, not a release forever under way", async () => {
    sr.releaseAfterMerge(task("t1"), "m1", "main");
    await sr.releaseTick(1_000_000);
    active.clear();
    await sr.releaseTick(1_000_000 + 5_000); // too soon to tell
    expect(pushed).toEqual([]);
    await sr.releaseTick(1_000_000 + 20_000);
    expect(pushed[0]!.body).toContain("stopped before it finished");
    expect(sr.releaseStatus().running).toBeNull();
  });

  test("systemd-run refusing is reported", async () => {
    startError = new Error("Failed to connect to bus");
    sr.releaseAfterMerge(task("t1"), "m1", "main");
    await sr.releaseTick();
    expect(pushed[0]!.body).toContain("Couldn't start the release: Failed to connect to bus.");
    expect(sr.releaseStatus()).toMatchObject({ running: null, pending: null });
  });
});

describe("the queue", () => {
  test("a merge during a release waits for it, then the newest merge goes out", async () => {
    sr.releaseAfterMerge(task("t1"), "m1", "main");
    await sr.releaseTick();
    sr.releaseAfterMerge(task("t2"), "m2", "main");
    await sr.releaseTick();
    expect(started.map((s) => s.sha)).toEqual(["m1"]); // one at a time
    ends(0);
    live = "m1";
    await sr.releaseTick(); // m1's result
    await sr.releaseTick(); // then m2
    expect(started.map((s) => s.sha)).toEqual(["m1", "m2"]);
    expect(pushed.map((p) => p.title)).toEqual(["ansai is updated"]);
  });

  test("a release someone started by hand: this one tries again after it, quietly", async () => {
    sr.releaseAfterMerge(task("t1"), "m1", "main");
    await sr.releaseTick(1_000_000);
    ends(1, "release: another release is running\n");
    await sr.releaseTick(1_000_000 + 5_000);
    expect(pushed).toEqual([]);
    expect(sr.releaseStatus().pending).toMatchObject({ sha: "m1" });
    await sr.releaseTick(1_000_000 + 30_000);
    expect(started).toHaveLength(1);
    await sr.releaseTick(1_000_000 + 5_000 + sr.RETRY_MS);
    expect(started.map((s) => s.sha)).toEqual(["m1", "m1"]);
  });

  test("already live (released by hand meanwhile): nothing to do", async () => {
    live = "m2";
    sr.releaseAfterMerge(task("t1"), "m1", "main");
    await sr.releaseTick();
    expect(started).toEqual([]);
    expect(pushed).toEqual([]);
    expect(sr.releaseStatus().pending).toBeNull();
  });

  test("live has commits the merge lacks: it isn't released over them", async () => {
    live = "elsewhere";
    sr.releaseAfterMerge(task("t1"), "m1", "main");
    await sr.releaseTick();
    expect(started).toEqual([]);
    expect(pushed[0]!.body).toContain("has commits your merge doesn't");
  });

  test("a release running across ansai's restart is picked up by the new process (state is in the database)", async () => {
    sr.releaseAfterMerge(task("t1"), "m1", "main");
    await sr.releaseTick();
    const saved = getSetting("self-release:running", null);
    expect(saved).toMatchObject({ sha: "m1" });
    // The restart: the new process has only the database and the files.
    setSetting("self-release:running", saved);
    ends(0);
    await sr.releaseTick();
    expect(pushed.map((p) => p.title)).toEqual(["ansai is updated"]);
  });
});
