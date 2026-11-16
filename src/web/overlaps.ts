/**
 * File overlaps on task cards: which tasks' agents touch (edit or claim) the same
 * files as another running agent's task, so parallel work doesn't collide at merge.
 * Pure: the team board comes from /api/projects/:id/team, sessions from the store.
 */
import type { Session, TeamBoard } from "./api";

/** One shared file, and the other agents' session ids that touch it. */
export type TaskOverlap = { path: string; with: string[] };

type Sess = Pick<Session, "id" | "task_id" | "status">;

/**
 * Task id → the files its agent shares with an agent on a different task. Only
 * running sessions count (a board can be a little stale), and two sessions on the
 * same task (say, a reviewer and its worker) aren't a collision.
 */
export function overlapsByTask(overlaps: TeamBoard["overlaps"], sessions: Sess[]): Map<string, TaskOverlap[]> {
  const live = new Map(sessions.filter((s) => s.status === "running").map((s) => [s.id, s]));
  const out = new Map<string, TaskOverlap[]>();
  for (const o of overlaps) {
    const ids = [...new Set(o.agents)].filter((id) => live.has(id));
    for (const id of ids) {
      const task = live.get(id)!.task_id;
      if (!task) continue;
      const others = ids.filter((b) => live.get(b)!.task_id !== task);
      if (!others.length) continue;
      const list = out.get(task) ?? [];
      const hit = list.find((x) => x.path === o.path);
      if (hit) hit.with = [...new Set([...hit.with, ...others])];
      else list.push({ path: o.path, with: others });
      out.set(task, list);
    }
  }
  return out;
}

/** "Shares src/x.ts +2 more with Fix login & 1 other", for the badge. */
export function overlapText(list: TaskOverlap[], name: (sessionId: string) => string): string {
  const first = list[0];
  if (!first) return "";
  const names = [...new Set(list.flatMap((x) => x.with).map(name))];
  const files = list.length > 1 ? ` +${list.length - 1} more` : "";
  const more = names.length > 1 ? ` & ${names.length - 1} other${names.length === 2 ? "" : "s"}` : "";
  return `Shares ${first.path}${files} with ${names[0]}${more}`;
}

/** Every shared file and who else touches it, for the badge's tooltip. */
export function overlapTitle(list: TaskOverlap[], name: (sessionId: string) => string): string {
  return [
    "Another running agent edited or claimed the same files; check with it before merging:",
    ...list.map((x) => `${x.path} — ${[...new Set(x.with.map(name))].join(", ")}`),
  ].join("\n");
}
