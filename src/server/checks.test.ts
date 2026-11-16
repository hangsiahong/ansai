import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { db, now } = await import("./db");
const { mcpHttp } = await import("./mcp");
const { runCommand, setChecks, tailOf } = await import("./checks");
const { evidenceDir, evidenceFile, pickEvidence, saveEvidence } = await import("./evidence");
const { listTasks } = await import("./tasks");

const work = mkdtempSync(join(process.env.ANSAI_HOME!, "work-"));

describe("runCommand", () => {
  test("passes, fails with the output's tail, and hides the service's ANSAI_* env", async () => {
    expect((await runCommand(work, "true")).ok).toBe(true);
    const bad = await runCommand(work, "seq 1 500; echo boom >&2; exit 3");
    expect(bad).toMatchObject({ ok: false, code: 3 });
    expect(bad.tail).toEndWith("boom");
    expect(bad.tail).not.toContain("\n400\n");
    const env = await runCommand(work, 'test -z "$ANSAI_HOME" && test "$CI" = 1');
    expect(env.ok).toBe(true);
  });

  test("a run past its time limit is killed with its children", async () => {
    const r = await runCommand(work, "sleep 30 & sleep 30; wait", 200);
    expect(r).toMatchObject({ ok: false, timedOut: true });
    expect(r.ms).toBeLessThan(5000);
  });

  test("tailOf strips colour codes and keeps the last lines", () => {
    expect(tailOf("\x1b[31mred\x1b[0m\nb\nc", 2)).toBe("b\nc");
    expect(tailOf("\x1b[31mred\x1b[0m")).toBe("red");
  });
});

describe("evidence", () => {
  test("paths are checked before anything runs, and saved files replace earlier ones", async () => {
    writeFileSync(join(work, "shot.png"), "png");
    writeFileSync(join(work, "secret"), "x");
    const bad = await pickEvidence(["shot.png", "missing.png", "secret", "../x.exe"], work);
    expect(bad.files.map((f) => f.name)).toEqual(["1-shot.png"]);
    expect(bad.errors).toHaveLength(3);
    expect((await pickEvidence("shot.png", work)).errors).toEqual(["evidence must be a list of file paths"]);

    const root = join(work, "ev");
    expect(await saveEvidence("tev1abc", bad.files, root)).toEqual([{ name: "1-shot.png", kind: "image", size: 3 }]);
    expect(existsSync(join(evidenceDir("tev1abc", root), "1-shot.png"))).toBe(true);
    await saveEvidence("tev1abc", [], root);
    expect(existsSync(evidenceDir("tev1abc", root))).toBe(false);
  });

  test("only plain names inside the task's folder are served", () => {
    expect(evidenceFile("tev1abc", "1-shot.png")?.type).toBe("image/png");
    expect(evidenceFile("tev1abc", "../../ansai.db")).toBeNull();
    expect(evidenceFile("tev1abc", "1-page.svg")).toBeNull();
    expect(evidenceFile("../x", "1-shot.png")).toBeNull();
  });
});

describe("finish_task with project checks", () => {
  beforeEach(() => {
    db.exec("DELETE FROM sessions; DELETE FROM tasks;");
    db.query("INSERT OR IGNORE INTO projects (id, name, path, created_at) VALUES ('chk', 'chk', ?, 0)").run(work);
    db.query("INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) VALUES ('tchk1', 'chk', 'Fix it', 'doing', 0, 0)").run();
    db.query(
      `INSERT INTO sessions (id, project_id, task_id, tool, title, cwd, argv, tmux_name, status, agent_state, created_at, msg_cursor)
       VALUES ('schk1', 'chk', 'tchk1', 'claude', 'Fix it', ?, '[]', 'ansai-schk1', 'running', 'working', ?, 0)`,
    ).run(work, now());
  });
  const finish = async (args: object) => {
    const res = await mcpHttp(
      new Request("http://127.0.0.1/mcp?s=schk1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "finish_task", arguments: args } }),
      }),
    );
    return ((await res.json()) as { result: { content: { text: string }[]; isError: boolean } }).result;
  };
  const task = () => listTasks().find((t) => t.id === "tchk1")!;

  test("a failing check bounces back to the agent and the task stays in Doing", async () => {
    setChecks("chk", "test -f fixed || { echo 'expected fixed'; exit 1; }");
    const r = await finish({ summary: "done" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("expected fixed");
    expect(task()).toMatchObject({ status: "doing", summary: null, checks: { ok: false, code: 1 } });

    writeFileSync(join(work, "fixed"), "");
    mkdirSync(join(work, "shots"), { recursive: true });
    writeFileSync(join(work, "shots", "phone.png"), "png");
    const ok = await finish({ summary: "done", evidence: ["shots/phone.png"] });
    expect(ok.isError).toBe(false);
    expect(ok.content[0]!.text).toContain("Checks passed");
    expect(task()).toMatchObject({ status: "review", summary: "done", checks: { ok: true }, evidence: [{ name: "1-phone.png", kind: "image" }] });
  });

  test("a bad evidence path fails fast without running the checks", async () => {
    setChecks("chk", "touch ran");
    const r = await finish({ summary: "done", evidence: ["nope.png"] });
    expect(r.isError).toBe(true);
    expect(existsSync(join(work, "ran"))).toBe(false);
    expect(task().status).toBe("doing");
  });

  test("without a checks command it finishes as before", async () => {
    setChecks("chk", "");
    const r = await finish({ summary: "done" });
    expect(r.isError).toBe(false);
    expect(task()).toMatchObject({ status: "review", checks: null, evidence: [] });
  });
});
