import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, type Project } from "../api";
import { openSheet, refreshProjects, toast, toastError, useStore } from "../store";
import { FolderIcon, Icon, Link, goBack, shortPath, useIsPhone } from "../ui";

export function ProjectsPane() {
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const tasks = useStore((s) => s.tasks);
  const phone = useIsPhone();
  const [q, setQ] = useState("");
  const [hidden, setHidden] = useState<Project[] | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!phone) input.current?.focus();
  }, []);

  const running = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions) if (s.project_id && s.status === "running") m.set(s.project_id, (m.get(s.project_id) ?? 0) + 1);
    return m;
  }, [sessions]);
  const open = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tasks) if (t.project_id && t.status !== "done") m.set(t.project_id, (m.get(t.project_id) ?? 0) + 1);
    return m;
  }, [tasks]);
  const dupes = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of projects) m.set(p.name, (m.get(p.name) ?? 0) + 1);
    return m;
  }, [projects]);

  const n = q.trim().toLowerCase();
  const match = (p: Project) => !n || p.name.toLowerCase().includes(n) || p.path.toLowerCase().includes(n);
  const pinned = projects.filter((p) => p.pinned && match(p));
  const rest = projects.filter((p) => !p.pinned && match(p));

  const rescan = async () => {
    try {
      const r = await api.scanProjects();
      await refreshProjects();
      toast(r.added ? `Found ${r.added} new project${r.added > 1 ? "s" : ""}` : "No new projects");
    } catch (e) {
      toastError(e);
    }
  };
  const showHidden = async () => {
    if (hidden) return setHidden(null);
    try {
      setHidden((await api.allProjects()).filter((p) => p.hidden));
    } catch (e) {
      toastError(e);
    }
  };
  const unhide = async (p: Project) => {
    await api.updateProject(p.id, { hidden: false }).catch(toastError);
    setHidden((h) => h?.filter((x) => x.id !== p.id) ?? null);
    refreshProjects();
  };

  const row = (p: Project) => (
    <Link href={`/p/${p.id}`} class="prow">
      <FolderIcon size={32} pinned={!!p.pinned} />
      <span class="prow-main">
        <span class="prow-name">{p.name}</span>
        <span class="prow-path">{dupes.get(p.name)! > 1 || n ? shortPath(p.path) : shortPath(p.path).split("/").slice(-2, -1)[0]}</span>
      </span>
      {running.get(p.id) ? (
        <span class="mini-stat live" title="Running sessions">
          <i />
          {running.get(p.id)}
        </span>
      ) : null}
      {open.get(p.id) ? (
        <span class="mini-stat" title="Open tasks">
          {open.get(p.id)} open
        </span>
      ) : null}
      <Icon name="chevR" size={15} />
    </Link>
  );

  return (
    <div class="pane">
      <header class="topbar">
        <button class="icon-btn phone-only" onClick={() => goBack()} aria-label="Back">
          <Icon name="back" />
        </button>
        <div class="topbar-title">
          <h1>Projects</h1>
          <div class="sub">{projects.length} git repos under ~/projects</div>
        </div>
        <button class="icon-btn" onClick={rescan} title="Rescan for new repos" aria-label="Rescan">
          <Icon name="refresh" />
        </button>
        <button class="icon-btn" onClick={() => openSheet({ kind: "add-project" })} title="Add a folder" aria-label="Add a folder">
          <Icon name="plus" />
        </button>
      </header>
      <div class="scroll narrow">
        <label class="searchfield">
          <Icon name="search" size={16} />
          <input ref={input} placeholder="Search projects" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          {q && (
            <button class="icon-btn sm" onClick={() => setQ("")} aria-label="Clear">
              <Icon name="x" size={15} />
            </button>
          )}
        </label>
        {pinned.length > 0 && (
          <section class="sec">
            <h2 class="sec-title">Pinned</h2>
            <div class="panel">{pinned.map(row)}</div>
          </section>
        )}
        <section class="sec">
          {pinned.length > 0 && <h2 class="sec-title">All</h2>}
          <div class="panel">{rest.length ? rest.map(row) : <p class="hint pad">No project matches “{q}”.</p>}</div>
        </section>
        <button class="linkish" onClick={showHidden}>
          {hidden ? "Hide hidden projects" : "Show hidden projects"}
        </button>
        {hidden && (
          <div class="panel">
            {hidden.length ? (
              hidden.map((p) => (
                <div class="prow">
                  <span class="folder-dim">
                    <FolderIcon size={32} />
                  </span>
                  <span class="prow-main">
                    <span class="prow-name">{p.name}</span>
                    <span class="prow-path">{shortPath(p.path)}</span>
                  </span>
                  <button class="btn sm" onClick={() => unhide(p)}>
                    Show
                  </button>
                </div>
              ))
            ) : (
              <p class="hint pad">No hidden projects.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
