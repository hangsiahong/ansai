import { describe, expect, test } from "bun:test";
import type { Session } from "./api";
import { liveSessionsOf, mergeActivity } from "./live";

const session = (id: string, o: Partial<Session> = {}) =>
  ({ id, task_id: null, status: "running", agent_state: "working", activity_at: 1, current_command: "claude", clients: 0, tokens: null, ...o }) as Session;

describe("mergeActivity", () => {
  test("updates the sessions that moved and keeps the others as they were", () => {
    const a = session("a");
    const b = session("b", { agent_state: "waiting" });
    const next = mergeActivity([a, b], [{ id: "a", activity_at: 5, current_command: "node", clients: 1, tokens: { fresh: 10, cached: 2 } }, { id: "b", activity_at: 1, current_command: "claude", clients: 0, tokens: null }]);
    expect(next[0]).toMatchObject({ id: "a", activity_at: 5, current_command: "node", clients: 1, tokens: { fresh: 10, cached: 2 }, agent_state: "working" });
    expect(next[1]).toBe(b);
  });

  test("returns the same list when nothing moved, so nothing re-renders", () => {
    const list = [session("a", { tokens: { fresh: 3, cached: 1 } })];
    expect(mergeActivity(list, [{ id: "a", activity_at: 1, current_command: "claude", clients: 0, tokens: { fresh: 3, cached: 1 } }, { id: "gone", activity_at: 9, current_command: null, clients: 0, tokens: null }])).toBe(list);
  });
});

describe("liveSessionsOf", () => {
  test("a task's running sessions, the same array until the list changes", () => {
    const list = [session("a", { task_id: "t1" }), session("b", { task_id: "t1", status: "exited" }), session("c", { task_id: "t2" })];
    expect(liveSessionsOf(list, "t1").map((s) => s.id)).toEqual(["a"]);
    expect(liveSessionsOf(list, "t1")).toBe(liveSessionsOf(list, "t1"));
    expect(liveSessionsOf(list, "none")).toBe(liveSessionsOf([...list], "other"));
  });
});
