import { useEffect, useMemo, useState } from "preact/hooks";
import { useStore } from "../store";
import { Icon, goBack } from "../ui";
import { Board, QuickAdd, TaskList } from "./tasks";

function useWide(query = "(min-width: 1100px)") {
  const [wide, setWide] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const f = () => setWide(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, [query]);
  return wide;
}

const FILTER_KEY = "ansai.backlogFilter";

export function BacklogPane() {
  const tasks = useStore((s) => s.tasks);
  const projects = useStore((s) => s.projects);
  const wide = useWide();
  const [filter, setFilter] = useState<string>(() => {
    try {
      return localStorage.getItem(FILTER_KEY) ?? "all";
    } catch {
      return "all";
    }
  });
  const [q, setQ] = useState("");
  useEffect(() => {
    try {
      localStorage.setItem(FILTER_KEY, filter);
    } catch {}
  }, [filter]);

  // Projects that have tasks first, so the filter is useful with 80+ repos.
  const withTasks = useMemo(() => {
    const ids = new Set(tasks.map((t) => t.project_id).filter(Boolean) as string[]);
    return projects.filter((p) => ids.has(p.id));
  }, [tasks, projects]);

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return tasks.filter((t) => {
      if (filter === "inbox" && t.project_id) return false;
      if (filter !== "all" && filter !== "inbox" && t.project_id !== filter) return false;
      if (n && !t.title.toLowerCase().includes(n) && !t.body.toLowerCase().includes(n)) return false;
      return true;
    });
  }, [tasks, filter, q]);

  const addTo = filter === "all" || filter === "inbox" ? null : filter;
  const addLabel = addTo ? projects.find((p) => p.id === addTo)?.name : "Inbox";

  return (
    <div class="pane">
      <header class="topbar">
        <button class="icon-btn mobile-only" onClick={() => goBack()} aria-label="Back">
          <Icon name="back" />
        </button>
        <div class="topbar-title">
          <h1>Backlog</h1>
          <div class="sub">
            {tasks.filter((t) => t.status !== "done").length} open across {withTasks.length} project{withTasks.length === 1 ? "" : "s"}
          </div>
        </div>
      </header>
      <div class="filters">
        <select value={filter} onChange={(e) => setFilter((e.target as HTMLSelectElement).value)} aria-label="Project filter">
          <option value="all">All projects</option>
          <option value="inbox">Inbox (no project)</option>
          {withTasks.length > 0 && (
            <optgroup label="With tasks">
              {withTasks.map((p) => (
                <option value={p.id}>{p.name}</option>
              ))}
            </optgroup>
          )}
          <optgroup label="All projects">
            {projects.map((p) => (
              <option value={p.id}>{p.name}</option>
            ))}
          </optgroup>
        </select>
        <label class="search inline">
          <Icon name="search" size={15} />
          <input placeholder="Search tasks" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </label>
      </div>
      {wide ? (
        <div class="board-wrap">
          <Board tasks={shown} showProject={filter === "all"} addProjectId={addTo} />
        </div>
      ) : (
        <div class="scroll">
          <QuickAdd projectId={addTo} placeholder={`Add to ${addLabel}…`} />
          <TaskList tasks={shown} showProject={filter === "all"} emptyText="No open tasks here." />
        </div>
      )}
    </div>
  );
}
