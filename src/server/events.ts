/** Tiny change bus: modules emit a topic, the server pushes fresh data to every open UI. */
export type Topic = "sessions" | "tasks" | "projects" | "accounts";

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
    const topics = [...pending];
    pending.clear();
    for (const t of topics) for (const fn of listeners) fn(t);
  });
}
