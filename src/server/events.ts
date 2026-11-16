/**
 * Tiny change bus: modules emit a topic, the server pushes fresh data to every open UI.
 * "activity" is the small one: only the session fields that move while agents print (see activityView).
 */
export type Topic = "sessions" | "activity" | "tasks" | "projects" | "accounts" | "messages" | "health";

const listeners = new Set<(t: Topic) => void>();
const pending = new Set<Topic>();
let scheduled = false;

export function onChange(fn: (t: Topic) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Coalesces bursts (e.g. a batch of task moves) into one push per topic. */
export function emit(topic: Topic) {
  pending.add(topic);
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    if (pending.has("sessions")) pending.delete("activity"); // the full list already carries it
    const topics = [...pending];
    pending.clear();
    for (const t of topics) for (const fn of listeners) fn(t);
  });
}
