import { describe, expect, test } from "bun:test";
import type { Session } from "./api";
import { overlapsByTask, overlapText, overlapTitle } from "./overlaps";

const run = (id: string, task_id: string | null, status: Session["status"] = "running") => ({ id, task_id, status });

describe("overlapsByTask", () => {
  test("maps each shared file to the tasks of the sessions involved, naming the others", () => {
    const m = overlapsByTask(
      [
        { path: "src/x.ts", agents: ["s1", "s2"] },
        { path: "src/y.ts", agents: ["s1", "s2", "s3"] },
      ],
      [run("s1", "t1"), run("s2", "t2"), run("s3", "t3")],
    );
    expect(m.get("t1")).toEqual([
      { path: "src/x.ts", with: ["s2"] },
      { path: "src/y.ts", with: ["s2", "s3"] },
    ]);
    expect(m.get("t2")).toEqual([
      { path: "src/x.ts", with: ["s1"] },
      { path: "src/y.ts", with: ["s1", "s3"] },
    ]);
    expect(m.get("t3")).toEqual([{ path: "src/y.ts", with: ["s1", "s2"] }]);
  });

  test("ignores sessions that stopped, sessions without a task, and two sessions on the same task", () => {
    const m = overlapsByTask(
      [
        { path: "a.ts", agents: ["s1", "gone"] }, // the other one exited since the board was fetched
        { path: "b.ts", agents: ["s1", "loose"] }, // no task: nothing to badge for it, but s1's task still shares
        { path: "c.ts", agents: ["s1", "rev"] }, // reviewer on the same task
      ],
      [run("s1", "t1"), run("gone", "t2", "exited"), run("loose", null), run("rev", "t1")],
    );
    expect(m.get("t1")).toEqual([{ path: "b.ts", with: ["loose"] }]);
    expect(m.has("t2")).toBe(false);
    expect([...m.keys()]).toEqual(["t1"]);
  });

  test("merges a task's sessions on the same file into one entry", () => {
    const m = overlapsByTask([{ path: "a.ts", agents: ["s1", "s1b", "s2"] }], [run("s1", "t1"), run("s1b", "t1"), run("s2", "t2")]);
    expect(m.get("t1")).toEqual([{ path: "a.ts", with: ["s2"] }]);
    expect(m.get("t2")).toEqual([{ path: "a.ts", with: ["s1", "s1b"] }]);
  });

  test("no overlaps, no entries", () => {
    expect(overlapsByTask([], [run("s1", "t1")]).size).toBe(0);
  });
});

describe("overlapText", () => {
  const names: Record<string, string> = { s2: "Fix login", s3: "Add search", s4: "Fix login" };
  const name = (id: string) => names[id] ?? id;

  test("one file, one other", () => {
    expect(overlapText([{ path: "src/x.ts", with: ["s2"] }], name)).toBe("Shares src/x.ts with Fix login");
  });

  test("first file plus a count of the rest, and of the other agents", () => {
    const list = [
      { path: "src/x.ts", with: ["s2"] },
      { path: "src/y.ts", with: ["s3"] },
      { path: "src/z.ts", with: ["s2"] },
    ];
    expect(overlapText(list, name)).toBe("Shares src/x.ts +2 more with Fix login & 1 other");
  });

  test("two sessions with the same name count once", () => {
    expect(overlapText([{ path: "a.ts", with: ["s2", "s4"] }], name)).toBe("Shares a.ts with Fix login");
  });

  test("empty list is empty text", () => {
    expect(overlapText([], name)).toBe("");
  });

  test("the tooltip lists every file and who else touches it", () => {
    expect(overlapTitle([{ path: "a.ts", with: ["s2", "s3"] }, { path: "b.ts", with: ["s3"] }], name).split("\n").slice(1)).toEqual([
      "a.ts — Fix login, Add search",
      "b.ts — Add search",
    ]);
  });
});
