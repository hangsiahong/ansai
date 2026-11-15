import { useMemo, useState } from "preact/hooks";
import { api, type Session } from "../api";
import { openSheet, refreshProjects, toast, toastError, useStore } from "../store";
import { Icon, Link, ToolDot, ago, sessionOrder, sessionState, useTick } from "../ui";

export function SessionRow({ s, active }: { s: Session; active?: boolean }) {
  const st = sessionState(s);
  return (
    <Link href={`/s/${s.id}`} class={`srow ${active ? "active" : ""} ${st.cls === "attn" ? "attn" : ""}`}>
      <ToolDot tool={s.tool} />
      <div class="srow-main">
        <div class="srow-title">{s.title}</div>
        <div class="srow-sub">
          {s.project_name ?? "~"} · {ago(s.activity_at ?? s.created_at)}
        </div>
      </div>
      <span class={`badge ${st.cls}`}>{st.label}</span>
    </Link>
  );
}

export function Home({ route }: { route: string }) {
  useTick();
  const sessions = useStore((s) => [...s.sessions].sort(sessionOrder));
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const connected = useStore((s) => s.connected);
  const accountsAttn = useStore((s) => s.accounts.filter((a) => a.usage?.limits.some((l) => l.used_percent >= 90)).length);
  const [q, setQ] = useState("");

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions) if (s.project_id && s.status === "running") m.set(s.project_id, (m.get(s.project_id) ?? 0) + 1);
    return m;
  }, [sessions]);
  const openTasks = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tasks) if (t.status !== "done" && t.project_id) m.set(t.project_id, (m.get(t.project_id) ?? 0) + 1);
    return m;
  }, [tasks]);
  const openCount = tasks.filter((t) => t.status !== "done").length;
  const dupes = useMemo(() => {
    const seen = new Map<string, number>();
    for (const p of projects) seen.set(p.name, (seen.get(p.name) ?? 0) + 1);
    return seen;
  }, [projects]);
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? projects.filter((p) => p.name.toLowerCase().includes(n) || p.path.toLowerCase().includes(n)) : projects;
  }, [q, projects]);

  const activeSession = route.startsWith("/s/") ? route.slice(3) : null;
  const activeProject = route.startsWith("/p/") ? route.slice(3) : null;
  const contextProject = activeProject ?? sessions.find((s) => s.id === activeSession)?.project_id ?? undefined;

  const rescan = async () => {
    try {
      const r = await api.scanProjects();
      await refreshProjects();
      toast(r.added ? `Found ${r.added} new project${r.added > 1 ? "s" : ""}` : "No new projects");
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div class="home">
      <header class="brand">
        <Link href="/" class="logo">
          <img src="/icon.svg" alt="" width="26" height="26" />
          <span>ansai</span>
        </Link>
        <span class={`conn ${connected ? "on" : ""}`} title={connected ? "Connected" : "Reconnecting…"} />
        <button class="btn primary small push" onClick={() => openSheet({ kind: "new", projectId: contextProject })}>
          <Icon name="plus" size={16} /> New
        </button>
      </header>

      <nav class="navlist">
        <Link href="/backlog" class={`nrow ${route === "/backlog" ? "active" : ""}`}>
          <Icon name="list" size={16} />
          <span>Backlog</span>
          {openCount > 0 && <span class="count muted-count">{openCount}</span>}
        </Link>
        <Link href="/accounts" class={`nrow ${route === "/accounts" ? "active" : ""}`}>
          <Icon name="gauge" size={16} />
          <span>Accounts &amp; usage</span>
          {accountsAttn > 0 && <span class="count warn-count">{accountsAttn}</span>}
        </Link>
        <button class="nrow" onClick={() => openSheet({ kind: "notify" })}>
          <Icon name="bell" size={16} />
          <span>Notifications</span>
        </button>
      </nav>

      <section class="block">
        <h3>Sessions</h3>
        {sessions.length === 0 ? (
          <p class="empty">Nothing running. Start Claude Code, Codex or a shell in any project.</p>
        ) : (
          <div class="list">
            {sessions.map((s) => (
              <SessionRow s={s} active={s.id === activeSession} />
            ))}
          </div>
        )}
      </section>

      <section class="block grow">
        <div class="block-head">
          <h3>Projects</h3>
          <button class="icon-btn" onClick={rescan} title="Rescan ~/projects" aria-label="Rescan projects">
            <Icon name="refresh" size={16} />
          </button>
          <button class="icon-btn" onClick={() => openSheet({ kind: "add-project" })} title="Add a folder" aria-label="Add a folder">
            <Icon name="plus" size={16} />
          </button>
        </div>
        <label class="search">
          <Icon name="search" size={15} />
          <input placeholder={`Filter ${projects.length} projects`} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </label>
        <div class="list">
          {filtered.map((p) => (
            <Link href={`/p/${p.id}`} class={`prow ${p.id === activeProject ? "active" : ""}`}>
              {p.pinned ? <span class="pin">★</span> : <Icon name="folder" size={15} />}
              <span class="prow-name">
                {p.name}
                {(dupes.get(p.name) ?? 0) > 1 && <small>{p.path.split("/").slice(-2, -1)[0]}</small>}
              </span>
              {openTasks.get(p.id) ? <span class="count muted-count" title="Open tasks">{openTasks.get(p.id)}</span> : null}
              {counts.get(p.id) ? <span class="count" title="Running sessions">{counts.get(p.id)}</span> : null}
            </Link>
          ))}
          {filtered.length === 0 && <p class="empty">No match.</p>}
        </div>
      </section>
    </div>
  );
}
