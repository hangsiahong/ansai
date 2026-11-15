import { useEffect, useState } from "preact/hooks";
import { api, wsUrl, type Account, type Me, type Project, type Session, type Task, type Tool, type ToolId } from "./api";

export type SheetState =
  | null
  | { kind: "new"; projectId?: string; tool?: ToolId; accountId?: string }
  | { kind: "history"; sessionId: string }
  | { kind: "add-project" }
  | { kind: "task"; taskId: string }
  | { kind: "new-task"; projectId?: string | null }
  | { kind: "settings"; section?: "devices" | "notifications" | "appearance" };

export type Dialog =
  | null
  | { kind: "confirm"; title: string; body?: string; confirm: string; danger?: boolean; resolve: (v: boolean) => void }
  | { kind: "prompt"; title: string; value: string; placeholder?: string; confirm: string; resolve: (v: string | null) => void };

export type ThemePref = "system" | "dark" | "light";

type State = {
  sessions: Session[];
  projects: Project[];
  tasks: Task[];
  accounts: Account[];
  tools: Tool[];
  me: Me | null;
  connected: boolean;
  sheet: SheetState;
  dialog: Dialog;
  palette: boolean;
  theme: ThemePref;
  blocked: string | null;
  toast: { msg: string; kind: "error" | "info"; at: number } | null;
};

const savedTheme = (): ThemePref => {
  try {
    const t = localStorage.getItem("ansai.theme");
    if (t === "dark" || t === "light" || t === "system") return t;
  } catch {}
  return "system";
};

let state: State = {
  sessions: [],
  projects: [],
  tasks: [],
  accounts: [],
  tools: [],
  me: null,
  connected: false,
  sheet: null,
  dialog: null,
  palette: false,
  theme: savedTheme(),
  blocked: null,
  toast: null,
};
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

export const openSheet = (sheet: SheetState) => setState({ sheet, palette: false });
export const openPalette = (on = true) => setState({ palette: on });

// ------------------------------------------------------------------ dialogs

export function confirmDialog(o: { title: string; body?: string; confirm?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) =>
    setState({
      dialog: {
        kind: "confirm",
        title: o.title,
        body: o.body,
        confirm: o.confirm ?? "OK",
        danger: o.danger,
        resolve: (v) => {
          setState({ dialog: null });
          resolve(v);
        },
      },
    }),
  );
}

export function promptDialog(o: { title: string; value?: string; placeholder?: string; confirm?: string }): Promise<string | null> {
  return new Promise((resolve) =>
    setState({
      dialog: {
        kind: "prompt",
        title: o.title,
        value: o.value ?? "",
        placeholder: o.placeholder,
        confirm: o.confirm ?? "Save",
        resolve: (v) => {
          setState({ dialog: null });
          resolve(v);
        },
      },
    }),
  );
}

// -------------------------------------------------------------------- theme

const dark = matchMedia("(prefers-color-scheme: dark)");
export function applyTheme(pref: ThemePref = state.theme) {
  const resolved = pref === "system" ? (dark.matches ? "dark" : "light") : pref;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "dark" ? "#0b0d11" : "#f6f7f9");
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", resolved);
}
export function setTheme(pref: ThemePref) {
  try {
    localStorage.setItem("ansai.theme", pref);
  } catch {}
  setState({ theme: pref });
  applyTheme(pref);
}
dark.addEventListener("change", () => applyTheme());

// -------------------------------------------------------------------- toast

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string, kind: "error" | "info" = "info") {
  setState({ toast: { msg, kind, at: Date.now() } });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setState({ toast: null }), kind === "error" ? 6000 : 2500);
}
export function toastError(e: unknown) {
  toast(e instanceof Error ? e.message : String(e), "error");
}

// --------------------------------------------------------------------- data

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

function connectEvents() {
  let retry = 500;
  const open = () => {
    if (state.blocked) return;
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
  applyTheme();
  try {
    const res = await fetch("/api/me");
    const data = await res.json();
    if (res.status === 403 && data.code === "device") {
      setState({ blocked: data.error });
      return;
    }
    if (!res.ok) throw new Error(data.error ?? res.statusText);
    setState({ me: data, tools: await api.tools() });
  } catch (e) {
    toastError(e);
  }
  connectEvents();
}
