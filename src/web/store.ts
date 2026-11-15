import { useEffect, useState } from "preact/hooks";
import { api, wsUrl, type Account, type Me, type Project, type Session, type Task, type Tool, type ToolId } from "./api";

export type SheetState =
  | null
  | { kind: "new"; projectId?: string; tool?: ToolId; accountId?: string }
  | { kind: "history"; sessionId: string }
  | { kind: "add-project" }
  | { kind: "task"; taskId: string };

type State = {
  sessions: Session[];
  projects: Project[];
  tasks: Task[];
  accounts: Account[];
  tools: Tool[];
  me: Me | null;
  connected: boolean;
  sheet: SheetState;
  toast: { msg: string; kind: "error" | "info"; at: number } | null;
};

let state: State = { sessions: [], projects: [], tasks: [], accounts: [], tools: [], me: null, connected: false, sheet: null, toast: null };
const subs = new Set<() => void>();

export function setState(patch: Partial<State>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}
export const getState = () => state;

export function useStore<T>(pick: (s: State) => T): T {
  const [v, setV] = useState(() => pick(state));
  useEffect(() => {
    const f = () => setV(() => pick(state));
    subs.add(f);
    f();
    return () => void subs.delete(f);
  }, []);
  return v;
}

export const openSheet = (sheet: SheetState) => setState({ sheet });

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string, kind: "error" | "info" = "info") {
  setState({ toast: { msg, kind, at: Date.now() } });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setState({ toast: null }), kind === "error" ? 6000 : 2500);
}
export function toastError(e: unknown) {
  toast(e instanceof Error ? e.message : String(e), "error");
}

export async function refreshProjects() {
  try {
    setState({ projects: await api.projects() });
  } catch (e) {
    toastError(e);
  }
}

/** Optimistic local patch; the server's push brings the authoritative copy right after. */
export function patchTaskLocal(id: string, patch: Partial<Task>) {
  setState({ tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
}

// Live data over a single reconnecting WebSocket.
function connectEvents() {
  let retry = 500;
  const open = () => {
    const ws = new WebSocket(wsUrl("/ws/events"));
    ws.onopen = () => {
      retry = 500;
      setState({ connected: true });
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.t === "sessions") setState({ sessions: m.sessions });
        else if (m.t === "tasks") setState({ tasks: m.tasks });
        else if (m.t === "projects") setState({ projects: m.projects });
        else if (m.t === "accounts") setState({ accounts: m.accounts });
      } catch {}
    };
    ws.onclose = () => {
      setState({ connected: false });
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 8000);
    };
  };
  open();
}

export async function boot() {
  connectEvents();
  try {
    const [me, tools] = await Promise.all([api.me(), api.tools()]);
    setState({ me, tools });
  } catch (e) {
    toastError(e);
  }
}
