import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Session, ToolId } from "./api";
import { useStore } from "./store";
import claudeIcon from "./icons/claude.svg";
import codexIcon from "./icons/codex.svg";
import agyIcon from "./icons/agy.svg";

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

export function useMedia(query: string) {
  const [m, setM] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const q = matchMedia(query);
    const f = () => setM(q.matches);
    q.addEventListener("change", f);
    return () => q.removeEventListener("change", f);
  }, [query]);
  return m;
}
export const useIsPhone = () => useMedia("(max-width: 820px)");
export const isTouch = () => matchMedia("(pointer: coarse)").matches;

// -------------------------------------------------------------------- icons

const PATHS: Record<string, string> = {
  back: "M15 18l-6-6 6-6",
  chevR: "M9 6l6 6-6 6",
  chevD: "M6 9l6 6 6-6",
  plus: "M12 5v14M5 12h14",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  refresh: "M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6",
  x: "M18 6L6 18M6 6l12 12",
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z",
  send: "M12 19V5M5 12l7-7 7 7",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3",
  play: "M7 4.5v15l12-7.5z",
  type: "M4 7V5h16v2M9 19h6M12 5v14",
  list: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  check: "M5 12.5l4.5 4.5L19 7.5",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  eyeoff: "M3 3l18 18M10.6 6.1A9.9 9.9 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3 3.6M6.6 6.6C4.2 8.2 3 12 3 12s4 6 9 6a9 9 0 0 0 4-.9M9.9 9.9a3 3 0 0 0 4.2 4.2",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  gauge: "M12 14l4-4M3.5 18a10 10 0 1 1 17 0z",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4",
  home: "M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  layers: "M12 3L2 8l10 5 10-5-10-5zM2 16l10 5 10-5M2 12l10 5 10-5",
  sliders: "M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4",
  command: "M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  monitor: "M3 4h18v12H3zM8 20h8M12 16v4",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  phone: "M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2",
  laptop: "M4 5h16v10H4zM2 19h20",
  terminal: "M4 17l6-6-6-6M12 19h8",
  keyboard: "M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10",
  out: "M7 17L17 7M8 7h9v9",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  pencil: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
  plug: "M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5",
  question: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.3M12 17h.01",
  bulb: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.5.4.5 1.1.5 1.6V16h6v-.5c0-.6 0-1.2.5-1.6A6 6 0 0 0 12 3z",
  stop: "M7 7h10v10H7z",
  chat: "M4 5h16v11H9l-5 4z",
  dot: "M12 12h.01",
};

export function Icon({ name, size = 18, stroke = 1.9 }: { name: string; size?: number; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

// ------------------------------------------------------------------- helpers

export const TOOL_LABEL: Record<ToolId, string> = { claude: "Claude Code", codex: "Codex", agy: "Antigravity", shell: "Shell" };
export const TOOL_SHORT: Record<ToolId, string> = { claude: "Claude", codex: "Codex", agy: "agy", shell: "Shell" };
export const AGENTS: ToolId[] = ["claude", "codex", "agy"];
// Real CLI logos (from @lobehub/icons, MIT); bundled as hashed assets.
const TOOL_ICON: Partial<Record<ToolId, string>> = { claude: claudeIcon, codex: codexIcon, agy: agyIcon };

/** "claude-opus-5-5" → "Opus 5.5", "claude-sonnet-4-20250514" → "Sonnet 4"; other ids (Codex's) pass through. */
export function modelName(id: string): string {
  const m = id.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2})(?!\d))?/i);
  if (m) return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? "." + m[3] : ""}`;
  const old = id.match(/^claude-(\d+)(?:-(\d{1,2})(?!\d))?-(opus|sonnet|haiku)/i); // claude-3-5-sonnet-…
  if (old) return `${old[3]![0]!.toUpperCase()}${old[3]!.slice(1)} ${old[1]}${old[2] ? "." + old[2] : ""}`;
  return id;
}

/** What a session runs on, e.g. "Opus 5.5 · xhigh". Empty until the agent reports it. */
export function modelLabel(s: { model: string | null; effort: string | null }): string {
  if (!s.model) return "";
  return s.effort ? `${modelName(s.model)} · ${s.effort}` : modelName(s.model);
}

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

export type StateCls = "attn" | "working" | "turn" | "idle" | "exited";

export function sessionState(s: Session): { label: string; cls: StateCls } {
  if (s.status === "exited") return { label: s.exit_code ? `Exited ${s.exit_code}` : "Exited", cls: "exited" };
  const recent = !!s.activity_at && Date.now() - s.activity_at < 4000;
  const since = s.agent_state_at ?? 0;
  if (s.agent_state === "needs-input") return { label: "Needs you", cls: "attn" };
  // Claude's spinner keeps the screen moving while it works; silence means it was interrupted.
  if (s.agent_state === "working")
    return s.activity_at && Date.now() - s.activity_at > 20000 ? { label: "Your turn", cls: "turn" } : { label: "Working", cls: "working" };
  if (s.agent_state === "waiting") {
    // Codex/agy have no "started working" hook: fresh output after the last status means busy again.
    if (recent && s.activity_at! > since + 3000) return { label: "Working", cls: "working" };
    return { label: "Your turn", cls: "turn" };
  }
  if (recent) return { label: "Active", cls: "working" };
  return { label: "Idle", cls: "idle" };
}

/** Sessions that want you first, then most recent. */
export function sessionOrder(a: Session, b: Session) {
  const rank = (s: Session) => (s.agent_state === "needs-input" && s.status === "running" ? 0 : s.status === "exited" ? 2 : 1);
  return rank(a) - rank(b) || b.created_at - a.created_at;
}

export function ToolBadge({ tool, size = 24 }: { tool: ToolId; size?: number }) {
  const src = TOOL_ICON[tool];
  const px = `${size}px`;
  return (
    <span class={`toolbadge t-${tool}`} style={{ width: px, height: px }} title={TOOL_LABEL[tool]} role="img" aria-label={TOOL_LABEL[tool]}>
      {src ? (
        <img src={src} alt="" draggable={false} style={{ width: `${Math.round(size * 0.72)}px`, height: `${Math.round(size * 0.72)}px` }} />
      ) : (
        <Icon name="terminal" size={Math.round(size * 0.62)} stroke={2.4} />
      )}
    </span>
  );
}

/** iOS Files-style folder: light-blue body over a darker back tab. Pinned gets a star badge. */
export function FolderIcon({ size = 30, pinned = false }: { size?: number; pinned?: boolean }) {
  return (
    <span class="folder-icon" style={{ width: `${size}px`, height: `${size}px` }} aria-hidden="true">
      <svg viewBox="0 0 32 32" width={size} height={size}>
        <path d="M2.5 8.2A2.7 2.7 0 0 1 5.2 5.5h6.6c.8 0 1.6.4 2.1 1l1.2 1.5c.4.5 1 .8 1.6.8h10.1a2.7 2.7 0 0 1 2.7 2.7v13.8a2.7 2.7 0 0 1-2.7 2.7H5.2a2.7 2.7 0 0 1-2.7-2.7z" fill="#2f9bf0" />
        <path d="M2.5 13.4a2.4 2.4 0 0 1 2.4-2.4h22.2a2.4 2.4 0 0 1 2.4 2.4v11.1a2.7 2.7 0 0 1-2.7 2.7H5.2a2.7 2.7 0 0 1-2.7-2.7z" fill="#5fbefc" />
        <path d="M2.5 13.4a2.4 2.4 0 0 1 2.4-2.4h22.2a2.4 2.4 0 0 1 2.4 2.4v.9H2.5z" fill="#fff" opacity=".28" />
      </svg>
      {pinned && (
        <span class="folder-pin">
          <Icon name="star" size={Math.max(8, Math.round(size * 0.3))} stroke={3} />
        </span>
      )}
    </span>
  );
}

export function StatusPill({ s, compact: small }: { s: Session; compact?: boolean }) {
  const st = sessionState(s);
  return (
    <span class={`pill ${st.cls} ${small ? "sm" : ""}`}>
      <i />
      {st.label}
    </span>
  );
}

export const shortPath = (p: string) => p.replace(/^\/home\/[^/]+/, "~");

export function Empty(p: { icon: string; title: string; children?: ComponentChildren }) {
  return (
    <div class="empty-state">
      <div class="empty-icon">
        <Icon name={p.icon} size={20} />
      </div>
      <div class="empty-title">{p.title}</div>
      {p.children && <div class="empty-body">{p.children}</div>}
    </div>
  );
}

// -------------------------------------------------------------------- sheet

/**
 * Centered dialog on desktop, bottom sheet on phones. On phones it can be
 * dragged down by its header to dismiss.
 */
export function Sheet(p: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  full?: boolean;
  size?: "sm" | "md" | "lg";
  actions?: ComponentChildren;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; dy: number } | null>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && p.onClose();
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);

  const onTouchStart = (e: TouchEvent) => {
    drag.current = { y: e.touches[0]!.clientY, dy: 0 };
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!drag.current || !panel.current) return;
    const dy = Math.max(0, e.touches[0]!.clientY - drag.current.y);
    drag.current.dy = dy;
    panel.current.style.transition = "none";
    panel.current.style.transform = `translateY(${dy}px)`;
  };
  const onTouchEnd = () => {
    const el = panel.current;
    if (!drag.current || !el) return;
    const close = drag.current.dy > 90;
    drag.current = null;
    el.style.transition = "";
    el.style.transform = close ? "translateY(100%)" : "";
    if (close) setTimeout(p.onClose, 160);
  };

  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && p.onClose()}>
      <div ref={panel} class={`sheet ${p.full ? "full" : ""} ${p.size ?? "md"}`} role="dialog" aria-modal="true" aria-label={p.title}>
        <header class="sheet-head" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
          <span class="grabber" aria-hidden="true" />
          <h2>{p.title}</h2>
          <div class="row tight">
            {p.actions}
            <button class="icon-btn glass sm" onClick={p.onClose} aria-label="Close">
              <Icon name="x" size={16} stroke={2.6} />
            </button>
          </div>
        </header>
        <div class="sheet-body">{p.children}</div>
      </div>
    </div>
  );
}

/** In-app replacement for window.confirm / window.prompt. */
export function DialogHost() {
  const d = useStore((s) => s.dialog);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (d?.kind === "prompt") {
      setValue(d.value);
      setTimeout(() => input.current?.select(), 30);
    }
  }, [d]);
  if (!d) return null;
  const cancel = () => (d.kind === "confirm" ? d.resolve(false) : d.resolve(null));
  const ok = () => (d.kind === "confirm" ? d.resolve(true) : value.trim() && d.resolve(value.trim()));
  return (
    <Sheet title={d.title} onClose={cancel} size="sm">
      <form
        class="form"
        onSubmit={(e) => {
          e.preventDefault();
          ok();
        }}
      >
        {d.kind === "confirm" && d.body && <p class="dialog-body">{d.body}</p>}
        {d.kind === "prompt" && (
          <input ref={input} class="input" value={value} placeholder={d.placeholder} onInput={(e) => setValue((e.target as HTMLInputElement).value)} />
        )}
        <div class="dialog-actions">
          <button type="button" class="btn" onClick={cancel}>
            Cancel
          </button>
          <button type="submit" class={`btn ${d.kind === "confirm" && d.danger ? "danger" : "primary"}`} autoFocus={d.kind === "confirm"}>
            {d.confirm}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
