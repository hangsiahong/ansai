import { useEffect, useState } from "preact/hooks";
import { api, wsUrl, type Me, type Project, type Session, type Tool } from "./api";

type State = {
  sessions: Session[];
  projects: Project[];
  tools: Tool[];
  me: Me | null;
  connected: boolean;
  toast: { msg: string; kind: "error" | "info"; at: number } | null;
};

let state: State = { sessions: [], projects: [], tools: [], me: null, connected: false, toast: null };
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

// Live session list over a single reconnecting WebSocket.
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
  await refreshProjects();
}
