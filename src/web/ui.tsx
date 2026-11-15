import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Session, ToolId } from "./api";

// ------------------------------------------------------------------ routing

export function nav(to: string, replace = false) {
  if (to === location.pathname) return;
  history[replace ? "replaceState" : "pushState"](null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const f = () => setPath(location.pathname);
    addEventListener("popstate", f);
    return () => removeEventListener("popstate", f);
  }, []);
  return path;
}

export function Link(p: { href: string; class?: string; children: ComponentChildren; title?: string; onClick?: () => void }) {
  return (
    <a
      href={p.href}
      class={p.class}
      title={p.title}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        p.onClick?.();
        nav(p.href);
      }}
    >
      {p.children}
    </a>
  );
}

export const goBack = (fallback = "/") => (history.length > 1 ? history.back() : nav(fallback));

// -------------------------------------------------------------------- icons

const PATHS: Record<string, string> = {
  back: "M15 18l-6-6 6-6",
  plus: "M12 5v14M5 12h14",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  refresh: "M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6",
  x: "M18 6L6 18M6 6l12 12",
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z",
  send: "M4 12l16-8-6 16-2.5-6.5z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3",
  play: "M7 4l13 8-13 8z",
  type: "M4 7V5h16v2M9 19h6M12 5v14",
  list: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  check: "M5 12.5l4.5 4.5L19 7.5",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  inbox: "M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6H3v-6z",
  eyeoff: "M3 3l18 18M10.6 6.1A9.9 9.9 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3 3.6M6.6 6.6C4.2 8.2 3 12 3 12s4 6 9 6a9 9 0 0 0 4-.9M9.9 9.9a3 3 0 0 0 4.2 4.2",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  gauge: "M12 14l4-4M3.5 18a10 10 0 1 1 17 0z",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4",
};

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

// ------------------------------------------------------------------- helpers

export const TOOL_LABEL: Record<ToolId, string> = { claude: "Claude Code", codex: "Codex", agy: "Antigravity", shell: "Shell" };
export const AGENTS: ToolId[] = ["claude", "codex", "agy"];

export function ago(ts: number | null) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function until(ts: number | null) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  if (s < 60) return "<1m";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export function compact(n: number) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}

export function useTick(ms = 5000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function sessionState(s: Session): { label: string; cls: string } {
  if (s.status === "exited") return { label: s.exit_code ? `exited ${s.exit_code}` : "exited", cls: "exited" };
  const recent = !!s.activity_at && Date.now() - s.activity_at < 4000;
  const since = s.agent_state_at ?? 0;
  if (s.agent_state === "needs-input") return { label: "needs you", cls: "attn" };
  // Claude's spinner keeps the screen moving while it works; silence means it was interrupted.
  if (s.agent_state === "working") return s.activity_at && Date.now() - s.activity_at > 20000 ? { label: "your turn", cls: "turn" } : { label: "working", cls: "active" };
  if (s.agent_state === "waiting") {
    // Codex/agy have no "started working" hook: fresh output after the last status means busy again.
    if (recent && s.activity_at! > since + 3000) return { label: "active", cls: "active" };
    return { label: "your turn", cls: "turn" };
  }
  // Tools without hooks: output in the last few seconds.
  if (recent) return { label: "active", cls: "active" };
  return { label: "idle", cls: "idle" };
}

/** Sessions that want you first, then most recent. */
export function sessionOrder(a: Session, b: Session) {
  const rank = (s: Session) => (s.agent_state === "needs-input" && s.status === "running" ? 0 : s.status === "exited" ? 2 : 1);
  return rank(a) - rank(b) || b.created_at - a.created_at;
}

export function ToolDot({ tool }: { tool: ToolId }) {
  return <span class={`tooldot t-${tool}`} title={TOOL_LABEL[tool]} />;
}

export const shortPath = (p: string) => p.replace(/^\/home\/[^/]+/, "~");

export const isTouch = () => matchMedia("(pointer: coarse)").matches;

// -------------------------------------------------------------------- sheet

export function Sheet(p: { title: string; onClose: () => void; children: ComponentChildren; full?: boolean; actions?: ComponentChildren }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && p.onClose();
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);
  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class={`sheet ${p.full ? "full" : ""}`} role="dialog" aria-label={p.title}>
        <header class="sheet-head">
          <h2>{p.title}</h2>
          <div class="row">
            {p.actions}
            <button class="icon-btn" onClick={p.onClose} aria-label="Close">
              <Icon name="x" />
            </button>
          </div>
        </header>
        {p.children}
      </div>
    </div>
  );
}
