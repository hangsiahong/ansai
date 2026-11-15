import { useEffect, useState } from "preact/hooks";
import { api, type Project, type ToolId } from "../api";
import { openSheet, refreshProjects, toast, toastError, useStore } from "../store";
import { Icon, TOOL_LABEL, ToolDot, nav, shortPath, useTick } from "../ui";
import { SessionRow } from "./home";
import { QuickAdd, TaskList } from "./tasks";

export function ProjectPane({ id }: { id: string }) {
  useTick();
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const tools = useStore((s) => s.tools);
  const allTasks = useStore((s) => s.tasks);
  const [fetched, setFetched] = useState<Project | null>(null);
  const project = projects.find((p) => p.id === id) ?? fetched;
  useEffect(() => {
    if (!projects.find((p) => p.id === id)) api.project(id).then(setFetched).catch(toastError);
  }, [id]);
  if (!project) return <div class="pane center muted">Loading…</div>;
  const mine = sessions.filter((s) => s.project_id === id);
  const tasks = allTasks.filter((t) => t.project_id === id);

  const update = async (patch: { pinned?: boolean; hidden?: boolean }) => {
    try {
      await api.updateProject(id, patch);
      await refreshProjects();
      if (patch.hidden) {
        toast(`${project.name} hidden from the list`);
        nav("/", true);
      }
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
          <div class="sub mono">{shortPath(project.path)}</div>
        </div>
        <button class={`icon-btn ${project.pinned ? "pinned" : ""}`} onClick={() => update({ pinned: !project.pinned })} title={project.pinned ? "Unpin" : "Pin to top"} aria-label={project.pinned ? "Unpin" : "Pin"}>
          <Icon name="star" />
        </button>
        <button class="icon-btn" onClick={() => update({ hidden: true })} title="Hide from the project list" aria-label="Hide project">
          <Icon name="eyeoff" />
        </button>
      </header>
      <div class="scroll">
        <div class="project-grid">
          <div>
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
          </div>
          <section class="block">
            <h3>Backlog</h3>
            <QuickAdd projectId={id} placeholder={`Add a task to ${project.name}…`} />
            <TaskList tasks={tasks} emptyText="No open tasks. Add one above, then start an agent on it." />
          </section>
        </div>
      </div>
    </div>
  );
}
