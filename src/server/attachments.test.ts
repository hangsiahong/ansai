import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, now } from "./db";
import { attachmentsDir, dropAttachments, sweepAttachments } from "./attachments";

const root = mkdtempSync(join(tmpdir(), "ansai-attach-test-"));
const ids = ["attclosed01", "attrunning1", "attexited01"];

function session(id: string, status: string) {
  db.query("INSERT INTO sessions (id, tool, title, cwd, argv, tmux_name, status, created_at) VALUES (?, 'shell', ?, '/tmp', '[]', ?, ?, ?)").run(id, id, `t-${id}`, status, now());
}
function folder(id: string) {
  mkdirSync(attachmentsDir(id, root), { recursive: true });
  writeFileSync(join(attachmentsDir(id, root), "photo.png"), "x");
}
const clean = () => db.query(`DELETE FROM sessions WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);

beforeEach(() => {
  clean();
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
});
afterAll(() => {
  clean();
  rmSync(root, { recursive: true, force: true });
});

describe("files attached to a session", () => {
  test("are removed with the session's folder, and a missing folder is fine", async () => {
    folder("attclosed01");
    await dropAttachments("attclosed01", root);
    expect(existsSync(attachmentsDir("attclosed01", root))).toBe(false);
    await dropAttachments("attclosed01", root); // already gone
  });

  test("a name that isn't a session id never reaches outside the attachments folder", async () => {
    const outside = join(root, "..", `ansai-attach-outside-${process.pid}`);
    mkdirSync(outside, { recursive: true });
    try {
      await dropAttachments(`../ansai-attach-outside-${process.pid}`, root);
      await dropAttachments("..", root);
      expect(existsSync(outside)).toBe(true);
      expect(existsSync(root)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("the sweep at start removes closed sessions' folders and leaves every other one", async () => {
    session("attclosed01", "closed");
    session("attrunning1", "running");
    session("attexited01", "exited"); // can be restarted: its agent may read the files again
    for (const id of [...ids, "otheransai01"]) folder(id); // otheransai01: a session of another ansai on this machine
    expect(await sweepAttachments(root)).toBe(1);
    expect(existsSync(attachmentsDir("attclosed01", root))).toBe(false);
    for (const id of ["attrunning1", "attexited01", "otheransai01"]) expect(existsSync(attachmentsDir(id, root))).toBe(true);
  });

  test("a sweep with no attachments folder at all does nothing", async () => {
    rmSync(root, { recursive: true, force: true });
    expect(await sweepAttachments(root)).toBe(0);
  });
});
