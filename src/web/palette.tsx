import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ToolId } from "./api";
import { getState, openPalette, openSheet, setTheme, useStore } from "./store";
import { FolderIcon, Icon, StatusPill, TOOL_LABEL, ToolBadge, nav, shortPath } from "./ui";

type Item = { id: string; group: string; label: string; hint?: string; icon?: string; tool?: ToolId; folder?: boolean; run: () => void; extra?: preact.ComponentChildren };

/** Subsequence match; consecutive and word-start hits score higher. */
function score(q: string, text: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  let ti = 0;
  let s = 0;
  let streak = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return 0;
    streak = i === ti ? streak + 1 : 0;
    s += 1 + streak * 2 + (i === 0 || /[\s\-_/.·]/.test(t[i - 1] ?? "") ? 3 : 0);
    ti = i + 1;
  }
  return s - t.length * 0.01;
}

export function Palette() {
  const open = useStore((s) => s.palette);
  if (!open) return null;
  return <PaletteInner />;
}

function PaletteInner() {
  const sessions = useStore((s) => s.sessions);
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const close = () => openPalette(false);
  const go = (path: string) => () => (close(), nav(path));

  useEffect(() => {
    setTimeout(() => input.current?.focus(), 20);
  }, []);

  const items = useMemo(() => {
    const query = q.trim().toLowerCase();
    // "claude ansai" → offer to start Claude in the matching project
    const toolWord = (["claude", "codex", "agy", "shell"] as ToolId[]).find((t) => query.startsWith(t + " ") || query === t);
    const all: Item[] = [];
    const startIn: Item[] = [];
    if (toolWord) {
      const rest = query.slice(toolWord.length).trim();
      for (const p of projects) {
        const sc = score(rest, p.name);
        if (sc > 0) startIn.push({ id: `start-${toolWord}-${p.id}`, group: "Start", label: `${TOOL_LABEL[toolWord]} in ${p.name}`, hint: shortPath(p.path), tool: toolWord, run: () => (close(), openSheet({ kind: "new", tool: toolWord, projectId: p.id })), extra: sc } as Item & { extra: number });
      }
      startIn.sort((a, b) => (b.extra as number) - (a.extra as number));
    }
    const actions: Item[] = [
      { id: "a-new", group: "Actions", label: "New session…", icon: "plus", run: () => (close(), openSheet({ kind: "new" })) },
      { id: "a-task", group: "Actions", label: "New task…", icon: "list", run: () => (close(), openSheet({ kind: "new-task" })) },
      { id: "a-now", group: "Go to", label: "Now", icon: "home", run: go("/") },
      { id: "a-backlog", group: "Go to", label: "Backlog", icon: "list", run: go("/backlog") },
      { id: "a-projects", group: "Go to", label: "Projects", icon: "layers", run: go("/projects") },
      { id: "a-accounts", group: "Go to", label: "Accounts & usage", icon: "gauge", run: go("/accounts") },
      { id: "a-system", group: "Go to", label: "System", hint: "CPU, memory, disk, temperature", icon: "cpu", run: go("/system") },
      { id: "a-settings", group: "Go to", label: "Settings", icon: "gear", run: () => (close(), openSheet({ kind: "settings" })) },
      { id: "a-theme", group: "Actions", label: "Switch theme", hint: "System → Dark → Light", icon: "moon", run: () => setTheme(({ system: "dark", dark: "light", light: "system" } as const)[getState().theme]) },
    ];
    all.push(...actions);
    for (const s of sessions)
      all.push({ id: `s-${s.id}`, group: "Sessions", label: s.title, hint: s.project_name ?? "~", tool: s.tool, run: go(`/s/${s.id}`), extra: <StatusPill s={s} compact /> });
    for (const p of projects) all.push({ id: `p-${p.id}`, group: "Projects", label: p.name, hint: shortPath(p.path), icon: p.pinned ? "star" : "folder", folder: true, run: go(`/p/${p.id}`) });
    for (const t of tasks.filter((t) => t.status !== "done"))
      all.push({ id: `t-${t.id}`, group: "Tasks", label: t.title, hint: t.project_name ?? "Inbox", icon: "list", run: () => (close(), openSheet({ kind: "task", taskId: t.id })) });

    if (!query) {
      const recentSessions = all.filter((i) => i.group === "Sessions").slice(0, 5);
      const pinned = all.filter((i) => i.group === "Projects" && i.icon === "star");
      const recentProjects = projects
        .filter((p) => !p.pinned && p.last_used_at)
        .slice(0, 5)
        .map((p) => all.find((i) => i.id === `p-${p.id}`)!);
      return [...actions.slice(0, 2), ...recentSessions, ...pinned, ...recentProjects, ...actions.slice(2)];
    }
    const ranked = all
      .map((i) => ({ i, s: Math.max(score(query, i.label), score(query, `${i.label} ${i.hint ?? ""}`) * 0.8) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((x) => x.i);
    return [...startIn.slice(0, 6), ...ranked];
  }, [q, sessions, projects, tasks]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") (e.preventDefault(), setSel((i) => Math.min(items.length - 1, i + 1)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setSel((i) => Math.max(0, i - 1)));
    else if (e.key === "Enter") (e.preventDefault(), items[sel]?.run());
    else if (e.key === "Escape") close();
  };

  let lastGroup = "";
  return (
    <div class="scrim palette-scrim" onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="palette" role="dialog" aria-label="Search">
        <div class="palette-input">
          <Icon name="search" size={18} />
          <input ref={input} value={q} placeholder="Search sessions, projects, tasks — or “claude myproject”" onInput={(e) => setQ((e.target as HTMLInputElement).value)} onKeyDown={onKey} />
          <button class="icon-btn sm" onClick={close} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div class="palette-list" ref={list} role="listbox">
          {items.length === 0 && <p class="hint pad">Nothing matches “{q}”.</p>}
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <>
                {head && <div class="palette-group">{head}</div>}
                <button data-i={i} role="option" aria-selected={i === sel} class={`palette-item ${i === sel ? "sel" : ""}`} onMouseMove={() => setSel(i)} onClick={() => it.run()}>
                  {it.tool ? (
                    <ToolBadge tool={it.tool} size={24} />
                  ) : it.folder ? (
                    <FolderIcon size={24} pinned={it.icon === "star"} />
                  ) : (
                    <span class="pi-icon">
                      <Icon name={it.icon ?? "dot"} size={16} />
                    </span>
                  )}
                  <span class="pi-main">
                    <span class="pi-label">{it.label}</span>
                    {it.hint && <span class="pi-hint">{it.hint}</span>}
                  </span>
                  {typeof it.extra === "object" && it.extra}
                  {i === sel && <kbd>↵</kbd>}
                </button>
              </>
            );
          })}
        </div>
      </div>
    </div>
  );
}
