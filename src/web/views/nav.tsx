import { useMemo } from "preact/hooks";
import type { Session } from "../api";
import { openPalette, openSheet, useStore } from "../store";
import { Icon, Link, StatusPill, ToolBadge, sessionOrder, useTick } from "../ui";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function SideSession({ s, active }: { s: Session; active: boolean }) {
  return (
    <Link href={`/s/${s.id}`} class={`side-row ${active ? "active" : ""}`}>
      <ToolBadge tool={s.tool} size={20} />
      <span class="side-label">{s.title}</span>
      <StatusPill s={s} compact />
    </Link>
  );
}

export function Sidebar({ route }: { route: string }) {
  useTick();
  const sessions = useStore((s) => [...s.sessions].sort(sessionOrder));
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const connected = useStore((s) => s.connected);
  const me = useStore((s) => s.me);
  const openTasks = tasks.filter((t) => t.status !== "done").length;
  const hotAccounts = useStore((s) => s.accounts.filter((a) => a.usage?.limits.some((l) => l.used_percent >= 90)).length);

  const activeSession = route.startsWith("/s/") ? route.slice(3) : null;
  const activeProject = route.startsWith("/p/") ? route.slice(3) : null;
  const contextProject = activeProject ?? sessions.find((s) => s.id === activeSession)?.project_id ?? undefined;

  const shortcut = useMemo(() => {
    const pinned = projects.filter((p) => p.pinned);
    const recent = projects.filter((p) => !p.pinned && p.last_used_at).slice(0, Math.max(0, 6 - pinned.length));
    return { pinned, recent };
  }, [projects]);

  const navItem = (href: string, icon: string, label: string, badge?: number, warn?: boolean) => (
    <Link href={href} class={`side-row nav ${route === href ? "active" : ""}`}>
      <Icon name={icon} size={17} />
      <span class="side-label">{label}</span>
      {badge ? <span class={`count ${warn ? "warn" : ""}`}>{badge}</span> : null}
    </Link>
  );

  return (
    <nav class="sidebar" aria-label="Main">
      <header class="side-head">
        <Link href="/" class="brand">
          <img src="/icon.svg" alt="" width="24" height="24" />
          <span>ansai</span>
        </Link>
        <span class={`conn ${connected ? "on" : ""}`} title={connected ? "Live" : "Reconnecting…"} />
        <button class="icon-btn accent push" onClick={() => openSheet({ kind: "new", projectId: contextProject })} title="New session" aria-label="New session">
          <Icon name="plus" />
        </button>
      </header>

      <button class="searchbox" onClick={() => openPalette()}>
        <Icon name="search" size={15} />
        <span>Search or run…</span>
        <kbd>{isMac ? "⌘" : "Ctrl"} K</kbd>
      </button>

      <div class="side-group">
        {navItem("/", "home", "Now")}
        {navItem("/backlog", "list", "Backlog", openTasks)}
        {navItem("/projects", "layers", "Projects")}
        {navItem("/accounts", "gauge", "Accounts", hotAccounts, true)}
      </div>

      <div class="side-scroll">
        {sessions.length > 0 && (
          <div class="side-group">
            <div class="side-title">Sessions</div>
            {sessions.map((s) => (
              <SideSession s={s} active={s.id === activeSession} />
            ))}
          </div>
        )}
        {(shortcut.pinned.length > 0 || shortcut.recent.length > 0) && (
          <div class="side-group">
            <div class="side-title">Projects</div>
            {[...shortcut.pinned, ...shortcut.recent].map((p) => (
              <Link href={`/p/${p.id}`} class={`side-row ${p.id === activeProject ? "active" : ""}`}>
                <Icon name={p.pinned ? "star" : "folder"} size={15} />
                <span class="side-label">{p.name}</span>
              </Link>
            ))}
            <Link href="/projects" class="side-row more">
              <span class="side-label">All {projects.length} projects</span>
              <Icon name="chevR" size={14} />
            </Link>
          </div>
        )}
      </div>

      <footer class="side-foot">
        <button class="side-row" onClick={() => openSheet({ kind: "settings" })}>
          <Icon name="sliders" size={17} />
          <span class="side-label">Settings</span>
          {me && <span class="side-device">{me.device}</span>}
        </button>
      </footer>
    </nav>
  );
}

export function TabBar({ route }: { route: string }) {
  const tasks = useStore((s) => s.tasks);
  const attn = useStore((s) => s.sessions.filter((x) => x.status === "running" && x.agent_state === "needs-input").length);
  const open = tasks.filter((t) => t.status === "doing" || t.status === "review").length;
  const tab = (href: string, icon: string, label: string, badge?: number) => {
    const on = href === "/" ? route === "/" : route.startsWith(href) || (href === "/projects" && route.startsWith("/p/"));
    return (
      <Link href={href} class={`tab ${on ? "on" : ""}`}>
        <span class="tab-icon">
          <Icon name={icon} size={23} stroke={on ? 2.3 : 1.9} />
          {badge ? <b class="tab-badge">{badge}</b> : null}
        </span>
        <span class="tab-label">{label}</span>
      </Link>
    );
  };
  return (
    <>
      <nav class="tabbar" aria-label="Main">
        {tab("/", "home", "Now", attn)}
        {tab("/backlog", "list", "Backlog", open)}
        {tab("/projects", "layers", "Projects")}
        {tab("/accounts", "gauge", "Usage")}
      </nav>
      <button class="tab-new" onClick={() => openSheet({ kind: "new" })} aria-label="New session">
        <Icon name="plus" size={26} stroke={2.4} />
      </button>
    </>
  );
}
