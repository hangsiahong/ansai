/** Who is looking at which session right now (terminal open in a visible tab). */
const visible = new Map<string, Set<object>>();

export function setViewer(sessionId: string, conn: object, isVisible: boolean) {
  let set = visible.get(sessionId);
  if (isVisible) {
    if (!set) visible.set(sessionId, (set = new Set()));
    set.add(conn);
  } else if (set) {
    set.delete(conn);
    if (!set.size) visible.delete(sessionId);
  }
}

export const isWatched = (sessionId: string) => (visible.get(sessionId)?.size ?? 0) > 0;
