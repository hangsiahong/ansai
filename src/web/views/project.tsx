import { useEffect, useState } from "preact/hooks";
import { api, type Project } from "../api";
import { confirmDialog, openSheet, refreshProjects, toast, toastError, useStore } from "../store";
import { Empty, Icon, goBack, nav, shortPath, useTick } from "../ui";
import { Launchers, SessionCell } from "./now";
import { QuickAdd, TaskList } from "./tasks";

export function ProjectPane({ id }: { id: string }) {
  useTick();
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
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
    if (patch.hidden && !(await confirmDialog({ title: `Hide ${project.name}?`, body: "It disappears from lists and search. You can show it again from Projects.", confirm: "Hide" })))
      return;
    try {
      await api.updateProject(id, patch);
      await refreshProjects();
      if (patch.hidden) {
        toast(`${project.name} hidden`);
        nav("/projects", true);
      }
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div class="pane">
      <header class="topbar">
        <button class="icon-btn" onClick={() => goBack("/projects")} aria-label="Back">
          <Icon name="back" />
        </button>
        <div class="topbar-title">
          <h1>{project.name}</h1>
          <div class="sub mono">{shortPath(project.path)}</div>
        </div>
        <button class={`icon-btn ${project.pinned ? "starred" : ""}`} onClick={() => update({ pinned: !project.pinned })} title={project.pinned ? "Unpin" : "Pin"} aria-label={project.pinned ? "Unpin" : "Pin"}>
          <Icon name="star" />
        </button>
        <button class="icon-btn" onClick={() => update({ hidden: true })} title="Hide project" aria-label="Hide project">
          <Icon name="eyeoff" />
        </button>
      </header>
      <div class="scroll">
        <section class="sec">
          <h2 class="sec-title">Start an agent here</h2>
          <Launchers projectId={id} />
        </section>

        <div class="split">
          <section class="sec">
            <div class="sec-head">
              <h2 class="sec-title">Backlog</h2>
              {tasks.filter((t) => t.status !== "done").length > 0 && <span class="sec-count">{tasks.filter((t) => t.status !== "done").length} open</span>}
            </div>
            <QuickAdd projectId={id} placeholder={`Add a task to ${project.name}`} />
            <TaskList tasks={tasks} emptyText="No open tasks. Add one, then start an agent on it." />
          </section>
          <section class={`sec ${mine.length ? "first-narrow" : ""}`}>
            <h2 class="sec-title">Sessions</h2>
            {mine.length ? (
              <div class="panel" style={{ "--sep": "66px" }}>
                {mine.map((s) => (
                  <SessionCell s={s} />
                ))}
              </div>
            ) : (
              <Empty icon="terminal" title="No sessions here yet">
                Start one with the buttons above.
              </Empty>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
