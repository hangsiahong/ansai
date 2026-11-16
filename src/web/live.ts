import type { Session } from "./api";

type Activity = Pick<Session, "id" | "activity_at" | "current_command" | "clients" | "tokens">;
/** Folds an "activity" push (the few fields that move while agents print) into the session list. */
export function mergeActivity(sessions: Session[], activity: Activity[]): Session[] {
  const byId = new Map(activity.map((a) => [a.id, a]));
  let changed = false;
  const next = sessions.map((s) => {
    const a = byId.get(s.id);
    if (!a || (a.activity_at === s.activity_at && a.current_command === s.current_command && a.clients === s.clients && a.tokens?.fresh === s.tokens?.fresh && a.tokens?.cached === s.tokens?.cached)) return s;
    changed = true;
    return { ...s, ...a };
  });
  return changed ? next : sessions;
}

const noSessions: Session[] = [];
const liveMemo = new WeakMap<Session[], Map<string, Session[]>>();
/** A task's running sessions, from the live session list (task.sessions' agent state is stale). Same array until the list changes. */
export function liveSessionsOf(sessions: Session[], taskId: string): Session[] {
  let m = liveMemo.get(sessions);
  if (!m) {
    m = new Map();
    for (const s of sessions) if (s.task_id && s.status === "running") m.set(s.task_id, [...(m.get(s.task_id) ?? []), s]);
    liveMemo.set(sessions, m);
  }
  return m.get(taskId) ?? noSessions;
}
