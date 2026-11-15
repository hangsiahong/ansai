import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import "./styles.css";
import { api, type Project, type Session, type ToolId } from "./api";
import { boot, refreshProjects, toast, toastError, useStore } from "./store";
import { TerminalView, isTouch, type TermHandle, type TermStatus } from "./Terminal";

// ------------------------------------------------------------------ routing

function nav(to: string, replace = false) {
  if (to === location.pathname) return;
  history[replace ? "replaceState" : "pushState"](null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}
function useRoute() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const f = () => setPath(location.pathname);
    addEventListener("popstate", f);
    return () => removeEventListener("popstate", f);
  }, []);
  return path;
}
function Link(p: { href: string; class?: string; children: preact.ComponentChildren; title?: string }) {
  return (
    <a
      href={p.href}
      class={p.class}
      title={p.title}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        nav(p.href);
      }}
    >
      {p.children}
    </a>
  );
}

// -------------------------------------------------------------------- icons

const PATHS: Record<string, string> = {
  back: "M15 18l-6-6 6-6",
  plus: "M12 5v14M5 12h14",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  refresh: "M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6",
  x: "M18 6L6 18M6 6l12 12",
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z",
  keyboard: "M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10",
  send: "M4 12l16-8-6 16-2.5-6.5z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3",
  play: "M7 4l13 8-13 8z",
  stop: "M6 6h12v12H6z",
  type: "M4 7V5h16v2M9 19h6M12 5v14",
  minus: "M5 12h14",
};
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

// ------------------------------------------------------------------- helpers

const TOOL_LABEL: Record<ToolId, string> = { claude: "Claude Code", codex: "Codex", agy: "Antigravity", shell: "Shell" };

function ago(ts: number | null) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function useTick(ms = 5000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

function sessionState(s: Session): { label: string; cls: string } {
  if (s.status === "exited") return { label: s.exit_code ? `exited ${s.exit_code}` : "exited", cls: "exited" };
  // Heuristic until agent hooks report real state: output in the last few seconds.
  if (s.activity_at && Date.now() - s.activity_at < 4000) return { label: "active", cls: "active" };
  return { label: "idle", cls: "idle" };
}

function ToolDot({ tool }: { tool: ToolId }) {
  return <span class={`tooldot t-${tool}`} title={TOOL_LABEL[tool]} />;
}

// ------------------------------------------------------------------ sheets

type SheetState = null | { kind: "new"; projectId?: string; tool?: ToolId } | { kind: "history"; sessionId: string } | { kind: "add-project" };
let openSheet: (s: SheetState) => void = () => {};

function Sheet(p: { title: string; onClose: () => void; children: preact.ComponentChildren; full?: boolean; actions?: preact.ComponentChildren }) {
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

function NewSessionSheet(p: { projectId?: string; tool?: ToolId; onClose: () => void }) {
  const projects = useStore((s) => s.projects);
  const tools = useStore((s) => s.tools);
  const [projectId, setProjectId] = useState(p.projectId ?? projects[0]?.id ?? "");
  const [tool, setTool] = useState<ToolId>(p.tool ?? "claude");
  const [prompt, setPrompt] = useState("");
  const [yolo, setYolo] = useState(false);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      const s = await api.createSession({ tool, projectId: projectId || undefined, prompt, yolo });
      p.onClose();
      nav(`/s/${s.id}`);
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };

  return (
    <Sheet title="New session" onClose={p.onClose}>
      <div class="form">
        <label class="field">
          <span>Project</span>
          <select value={projectId} onChange={(e) => setProjectId((e.target as HTMLSelectElement).value)}>
            <option value="">~ (home folder)</option>
            {projects.map((pr) => (
              <option value={pr.id}>
                {pr.name} — {pr.path.replace(/^\/home\/[^/]+/, "~")}
              </option>
            ))}
          </select>
        </label>
        <div class="field">
          <span>Agent</span>
          <div class="seg">
            {(tools.length ? tools : (["claude", "codex", "agy", "shell"] as ToolId[]).map((id) => ({ id, label: TOOL_LABEL[id], installed: true }))).map((t) => (
              <button type="button" class={`seg-btn ${tool === t.id ? "on" : ""}`} disabled={!t.installed} onClick={() => setTool(t.id)}>
                <ToolDot tool={t.id} /> {t.label}
              </button>
            ))}
          </div>
        </div>
        {tool !== "shell" && (
          <label class="field">
            <span>First prompt (optional)</span>
            <textarea
              rows={4}
              placeholder="What should it work on?"
              value={prompt}
              onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
              }}
            />
          </label>
        )}
        {tool !== "shell" && (
          <label class="check">
            <input type="checkbox" checked={yolo} onChange={(e) => setYolo((e.target as HTMLInputElement).checked)} />
            <span>
              Auto-approve everything <em>— the agent won't ask before running commands or editing files</em>
            </span>
          </label>
        )}
        <button class="btn primary big" disabled={busy} onClick={start}>
          <Icon name="play" size={16} /> {busy ? "Starting…" : `Start ${TOOL_LABEL[tool]}`}
        </button>
      </div>
    </Sheet>
  );
}

function HistorySheet(p: { sessionId: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const pre = useRef<HTMLPreElement>(null);
  const load = () =>
    api
      .history(p.sessionId)
      .then((t) => setText(t))
      .catch(toastError);
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [text]);
  return (
    <Sheet
      title="History"
      full
      onClose={p.onClose}
      actions={
        <>
          <button class="icon-btn" onClick={load} aria-label="Refresh">
            <Icon name="refresh" />
          </button>
          <button
            class="btn small"
            onClick={() =>
              navigator.clipboard
                ?.writeText(text ?? "")
                .then(() => toast("Copied"))
                .catch(() => toast("Clipboard blocked — select the text instead", "error"))
            }
          >
            Copy
          </button>
        </>
      }
    >
      <pre class="history" ref={pre}>
        {text ?? "Loading…"}
      </pre>
    </Sheet>
  );
}

function AddProjectSheet(p: { onClose: () => void }) {
  const [path, setPath] = useState("~/projects/");
  const add = async () => {
    try {
      const pr = await api.addProject(path);
      await refreshProjects();
      p.onClose();
      nav(`/p/${pr.id}`);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Sheet title="Add a folder" onClose={p.onClose}>
      <div class="form">
        <label class="field">
          <span>Path on this laptop</span>
          <input value={path} onInput={(e) => setPath((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && add()} autoFocus />
        </label>
        <button class="btn primary big" onClick={add}>
          Add project
        </button>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- sidebar

function SessionRow({ s, active }: { s: Session; active?: boolean }) {
  const st = sessionState(s);
  return (
    <Link href={`/s/${s.id}`} class={`srow ${active ? "active" : ""}`}>
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

function Home({ route }: { route: string }) {
  useTick();
  const sessions = useStore((s) => s.sessions);
  const projects = useStore((s) => s.projects);
  const connected = useStore((s) => s.connected);
  const [q, setQ] = useState("");
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions) if (s.project_id && s.status === "running") m.set(s.project_id, (m.get(s.project_id) ?? 0) + 1);
    return m;
  }, [sessions]);
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? projects.filter((p) => p.name.toLowerCase().includes(n) || p.path.toLowerCase().includes(n)) : projects;
  }, [q, projects]);
  const activeSession = route.startsWith("/s/") ? route.slice(3) : null;
  const activeProject = route.startsWith("/p/") ? route.slice(3) : null;
  const contextProject = activeProject ?? sessions.find((s) => s.id === activeSession)?.project_id ?? undefined;
  const dupes = useMemo(() => {
    const seen = new Map<string, number>();
    for (const p of projects) seen.set(p.name, (seen.get(p.name) ?? 0) + 1);
    return seen;
  }, [projects]);

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
              {counts.get(p.id) ? <span class="count">{counts.get(p.id)}</span> : null}
            </Link>
          ))}
          {filtered.length === 0 && <p class="empty">No match.</p>}
        </div>
      </section>
    </div>
  );
}

// ------------------------------------------------------------ main panes

function Overview() {
  useTick();
  const sessions = useStore((s) => s.sessions);
  const me = useStore((s) => s.me);
  return (
    <div class="pane overview">
      <div class="hero">
        <h1>Your agents, from anywhere.</h1>
        <p>
          {me?.tailscale.url ? (
            <>
              Private URL: <code>{me.tailscale.url}</code>
            </>
          ) : (
            <>Local only — log in to Tailscale to reach this from your phone.</>
          )}
        </p>
        <div class="row">
          <button class="btn primary" onClick={() => openSheet({ kind: "new", tool: "claude" })}>
            <ToolDot tool="claude" /> Claude Code
          </button>
          <button class="btn" onClick={() => openSheet({ kind: "new", tool: "codex" })}>
            <ToolDot tool="codex" /> Codex
          </button>
          <button class="btn" onClick={() => openSheet({ kind: "new", tool: "agy" })}>
            <ToolDot tool="agy" /> Antigravity
          </button>
          <button class="btn" onClick={() => openSheet({ kind: "new", tool: "shell" })}>
            <ToolDot tool="shell" /> Shell
          </button>
        </div>
      </div>
      {sessions.length > 0 && (
        <div class="cards">
          {sessions.map((s) => {
            const st = sessionState(s);
            return (
              <Link href={`/s/${s.id}`} class="card">
                <div class="card-top">
                  <ToolDot tool={s.tool} />
                  <span class="card-tool">{TOOL_LABEL[s.tool]}</span>
                  <span class={`badge ${st.cls}`}>{st.label}</span>
                </div>
                <div class="card-title">{s.title}</div>
                <div class="card-sub">
                  {s.project_name ?? "~"} · started {ago(s.created_at)} ago
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProjectPane({ id }: { id: string }) {
  useTick();
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const tools = useStore((s) => s.tools);
  const [fetched, setFetched] = useState<Project | null>(null);
  const project = projects.find((p) => p.id === id) ?? fetched;
  useEffect(() => {
    if (!projects.find((p) => p.id === id)) api.project(id).then(setFetched).catch(toastError);
  }, [id]);
  if (!project) return <div class="pane center muted">Loading…</div>;
  const mine = sessions.filter((s) => s.project_id === id);

  const togglePin = async () => {
    try {
      await api.updateProject(id, { pinned: !project.pinned });
      await refreshProjects();
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div class="pane">
      <header class="topbar">
        <button class="icon-btn mobile-only" onClick={() => nav("/")} aria-label="Back">
          <Icon name="back" />
        </button>
        <div class="topbar-title">
          <h1>{project.name}</h1>
          <div class="sub mono">{project.path.replace(/^\/home\/[^/]+/, "~")}</div>
        </div>
        <button class={`icon-btn ${project.pinned ? "pinned" : ""}`} onClick={togglePin} aria-label={project.pinned ? "Unpin" : "Pin"} title={project.pinned ? "Unpin" : "Pin to top"}>
          <Icon name="star" />
        </button>
      </header>
      <div class="scroll">
        <section class="block">
          <h3>Start an agent here</h3>
          <div class="launch">
            {(["claude", "codex", "agy", "shell"] as ToolId[]).map((t) => {
              const installed = tools.find((x) => x.id === t)?.installed ?? true;
              return (
                <button class="launch-btn" disabled={!installed} onClick={() => openSheet({ kind: "new", projectId: id, tool: t })}>
                  <ToolDot tool={t} />
                  <span>{TOOL_LABEL[t]}</span>
                  {!installed && <em>not installed</em>}
                </button>
              );
            })}
          </div>
        </section>
        <section class="block">
          <h3>Sessions</h3>
          {mine.length ? (
            <div class="list">
              {mine.map((s) => (
                <SessionRow s={s} />
              ))}
            </div>
          ) : (
            <p class="empty">No sessions in this project yet.</p>
          )}
        </section>
        <section class="block">
          <h3>Backlog</h3>
          <p class="empty">Coming in phase 2: tasks for this project, each one startable with an agent.</p>
        </section>
      </div>
    </div>
  );
}

const KEYS: { label: string; seq?: string; act?: "ctrl" | "kbd" | "up" | "down"; wide?: boolean; title?: string }[] = [
  { label: "esc", seq: "\x1b" },
  { label: "tab", seq: "\t" },
  { label: "⇧tab", seq: "\x1b[Z", title: "Shift+Tab (Claude: cycle mode)" },
  { label: "ctrl", act: "ctrl" },
  { label: "^C", seq: "\x03" },
  { label: "↑", seq: "\x1b[A" },
  { label: "↓", seq: "\x1b[B" },
  { label: "←", seq: "\x1b[D" },
  { label: "→", seq: "\x1b[C" },
  { label: "⏎", seq: "\r" },
  { label: "1", seq: "1" },
  { label: "2", seq: "2" },
  { label: "3", seq: "3" },
  { label: "/", seq: "/" },
  { label: "⇞", act: "up", title: "Scroll up" },
  { label: "⇟", act: "down", title: "Scroll down" },
  { label: "⌨", act: "kbd", title: "Type directly in the terminal" },
];

function SessionPane({ id }: { id: string }) {
  useTick();
  const sessions = useStore((s) => s.sessions);
  const [fetched, setFetched] = useState<Session | null>(null);
  const [missing, setMissing] = useState(false);
  const s = sessions.find((x) => x.id === id) ?? fetched;
  const handle = useRef<TermHandle | null>(null);
  const [tstatus, setTstatus] = useState<TermStatus>("connecting");
  const [ctrl, setCtrl] = useState(false);
  const [kbd, setKbd] = useState(false);
  const [compose, setCompose] = useState("");
  const [showTools, setShowTools] = useState(isTouch());
  const [menu, setMenu] = useState(false);
  const touch = isTouch();

  useEffect(() => {
    setMissing(false);
    if (!sessions.find((x) => x.id === id))
      api
        .session(id)
        .then(setFetched)
        .catch(() => setMissing(true));
  }, [id]);

  if (missing) {
    return (
      <div class="pane center">
        <p class="muted">This session is gone.</p>
        <button class="btn" onClick={() => nav("/")}>
          Back
        </button>
      </div>
    );
  }
  if (!s) return <div class="pane center muted">Loading…</div>;

  const st = sessionState(s);
  const closed = s.status === "closed";

  const key = async (k: (typeof KEYS)[number]) => {
    const h = handle.current;
    if (!h) return;
    if (k.seq) h.send(k.seq);
    else if (k.act === "ctrl") {
      const on = !ctrl;
      setCtrl(on);
      h.armCtrl(on);
      if (on && !kbd && touch) toast("Ctrl armed — type a letter in the terminal (⌨) or tap a key");
    } else if (k.act === "kbd") {
      const on = !kbd;
      setKbd(on);
      h.setKeyboard(on);
    } else if (k.act === "up" || k.act === "down") {
      h.send(k.act === "up" ? "\x1b[<64;2;2M".repeat(8) : "\x1b[<65;2;2M".repeat(8));
    }
  };

  const sendCompose = async (enter = true) => {
    const text = compose;
    if (!text && !enter) return;
    setCompose("");
    try {
      await api.send(id, text, enter);
    } catch (e) {
      setCompose(text);
      toastError(e);
    }
  };

  const act = async (what: "restart" | "close" | "rename") => {
    setMenu(false);
    try {
      if (what === "restart") await api.restartSession(id);
      if (what === "close") {
        if (!confirm(`Close "${s.title}"? This stops the agent.`)) return;
        await api.closeSession(id);
        nav("/", true);
      }
      if (what === "rename") {
        const t = prompt("Session name", s.title);
        if (t) await api.renameSession(id, t);
      }
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div class="pane session">
      <header class="topbar">
        <button class="icon-btn mobile-only" onClick={() => (history.length > 1 ? history.back() : nav("/"))} aria-label="Back">
          <Icon name="back" />
        </button>
        <ToolDot tool={s.tool} />
        <div class="topbar-title" onClick={() => act("rename")}>
          <h1>{s.title}</h1>
          <div class="sub">
            {s.project_id ? <Link href={`/p/${s.project_id}`}>{s.project_name}</Link> : "~"} · <span class={`st ${st.cls}`}>{st.label}</span>
            {tstatus !== "live" && !closed && <span class="st warn"> · {tstatus}</span>}
          </div>
        </div>
        <button class="icon-btn" onClick={() => openSheet({ kind: "history", sessionId: id })} title="History (scrollback as text)" aria-label="History">
          <Icon name="history" />
        </button>
        {!touch && (
          <button class={`icon-btn ${showTools ? "pinned" : ""}`} onClick={() => setShowTools(!showTools)} title="Compose box & keys" aria-label="Toggle compose">
            <Icon name="type" />
          </button>
        )}
        <div class="menu-wrap">
          <button class="icon-btn" onClick={() => setMenu(!menu)} aria-label="More">
            <Icon name="more" />
          </button>
          {menu && (
            <div class="menu" onMouseLeave={() => setMenu(false)}>
              <button onClick={() => (handle.current?.bumpFont(1), setMenu(false))}>Bigger text</button>
              <button onClick={() => (handle.current?.bumpFont(-1), setMenu(false))}>Smaller text</button>
              <button onClick={() => act("rename")}>Rename</button>
              <button onClick={() => act("restart")}>Restart agent</button>
              <button class="danger" onClick={() => act("close")}>
                Close session
              </button>
            </div>
          )}
        </div>
      </header>

      {s.status === "exited" && (
        <div class="banner">
          <span>
            {TOOL_LABEL[s.tool]} exited{s.exit_code ? ` with code ${s.exit_code}` : ""}.
          </span>
          <button class="btn small" onClick={() => act("restart")}>
            Restart
          </button>
          <button class="btn small ghost" onClick={() => act("close")}>
            Close
          </button>
        </div>
      )}

      {closed ? (
        <div class="pane center muted">Session closed.</div>
      ) : (
        <TerminalView
          sessionId={id}
          handle={handle}
          onStatus={setTstatus}
          onCtrlUsed={() => {
            setCtrl(false);
          }}
        />
      )}

      {showTools && !closed && (
        <div class="dock">
          <div class="keys" role="toolbar" aria-label="Terminal keys">
            {KEYS.map((k) => (
              <button
                class={`key ${(k.act === "ctrl" && ctrl) || (k.act === "kbd" && kbd) ? "on" : ""}`}
                title={k.title ?? k.label}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => key(k)}
              >
                {k.label}
              </button>
            ))}
          </div>
          <div class="compose">
            <textarea
              rows={1}
              placeholder={s.tool === "shell" ? "Command…" : "Message the agent…"}
              value={compose}
              onInput={(e) => {
                const t = e.target as HTMLTextAreaElement;
                setCompose(t.value);
                t.style.height = "auto";
                t.style.height = Math.min(t.scrollHeight, 140) + "px";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !touch) {
                  e.preventDefault();
                  sendCompose(true);
                }
              }}
            />
            <button class="btn primary send" onClick={() => sendCompose(true)} aria-label="Send">
              <Icon name="send" size={17} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- app

function App() {
  const route = useRoute();
  const toastS = useStore((s) => s.toast);
  const [sheet, setSheet] = useState<SheetState>(null);
  openSheet = setSheet;

  // Keep layout above the on-screen keyboard (iOS doesn't resize the layout viewport).
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const f = () => document.documentElement.style.setProperty("--app-h", `${vv.height}px`);
    f();
    vv.addEventListener("resize", f);
    return () => vv.removeEventListener("resize", f);
  }, []);

  let main: preact.ComponentChildren;
  if (route.startsWith("/s/")) main = <SessionPane id={route.slice(3)} />;
  else if (route.startsWith("/p/")) main = <ProjectPane id={route.slice(3)} />;
  else main = <Overview />;

  const isHome = route === "/";
  return (
    <div class={`app ${isHome ? "at-home" : "at-detail"}`}>
      <aside class="side">
        <Home route={route} />
      </aside>
      <main class="main">{main}</main>
      {sheet?.kind === "new" && <NewSessionSheet projectId={sheet.projectId} tool={sheet.tool} onClose={() => setSheet(null)} />}
      {sheet?.kind === "history" && <HistorySheet sessionId={sheet.sessionId} onClose={() => setSheet(null)} />}
      {sheet?.kind === "add-project" && <AddProjectSheet onClose={() => setSheet(null)} />}
      {toastS && (
        <div class={`toast ${toastS.kind}`} role="status">
          {toastS.msg}
        </div>
      )}
    </div>
  );
}

// Added at runtime: Bun's HTML bundler would otherwise try to bundle these server-served files.
for (const [rel, href, type] of [
  ["manifest", "/manifest.webmanifest"],
  ["icon", "/icon.svg", "image/svg+xml"],
  ["apple-touch-icon", "/icon-192.png"],
] as const) {
  const l = document.createElement("link");
  l.rel = rel;
  l.href = href;
  if (type) l.type = type;
  document.head.appendChild(l);
}

boot();
render(<App />, document.getElementById("app")!);

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
