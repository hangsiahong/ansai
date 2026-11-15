import { useEffect, useState } from "preact/hooks";
import { api, type Autopilot, type Project, type ToolId } from "../api";
import { confirmDialog, openSheet, refreshProjects, toast, toastError, useStore } from "../store";
import { AGENTS, Empty, FolderIcon, Icon, TOOL_LABEL, ToolBadge, goBack, nav, shortPath, useTick } from "../ui";
import { AccountPicker } from "../accounts";
import { ModelPicker } from "../models";
import { Launchers, SessionCell } from "./now";
import { QuickAdd, TaskList } from "./tasks";
import { TeamPanel } from "../team";

function AutopilotCard({ project, openTodo }: { project: Project; openTodo: string[] }) {
  const ap: Autopilot = project.autopilot ?? { on: false, tool: "claude", accountId: null, yolo: false };
  const set = (patch: Partial<Autopilot>) => api.setAutopilot(project.id, patch).catch(toastError);
  const queueAll = async () => {
    try {
      await Promise.all(openTodo.map((tid) => api.updateTask(tid, { queued: true })));
      toast(`Queued ${openTodo.length} task${openTodo.length === 1 ? "" : "s"}`);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <section class="sec">
      <h2 class="sec-title">Autopilot</h2>
      <div class="panel autopilot">
        <label class="switch-row">
          <span>
            <b>Agents pick up new tasks</b>
            <em>One at a time here. They ask before guessing.</em>
          </span>
          <input type="checkbox" class="switch" checked={ap.on} onChange={(e) => set({ on: (e.target as HTMLInputElement).checked })} />
        </label>
        {ap.on && (
          <div class="ap-body">
            <div class="ap-agents" role="radiogroup" aria-label="Agent">
              {AGENTS.map((t: ToolId) => (
                <button role="radio" aria-checked={ap.tool === t} aria-label={TOOL_LABEL[t]} title={TOOL_LABEL[t]} class={`ap-agent ${ap.tool === t ? "on" : ""}`} onClick={() => set({ tool: t, accountId: null })}>
                  <ToolBadge tool={t} size={44} />
                </button>
              ))}
            </div>
            <AccountPicker tool={ap.tool} value={ap.accountId} onChange={(v) => set({ accountId: v })} />
            <ModelPicker tool={ap.tool} accountId={ap.accountId} value={{ model: ap.model ?? null, effort: ap.effort ?? null }} onChange={(v) => set(v)} />
            <label class="switch-row inner">
              <span>
                <b>Auto-approve</b>
                <em>Off: approvals come to your phone</em>
              </span>
              <input type="checkbox" class="switch" checked={ap.yolo} onChange={(e) => set({ yolo: (e.target as HTMLInputElement).checked })} />
            </label>
            {openTodo.length > 0 && (
              <button class="btn sm" onClick={queueAll}>
                Queue the {openTodo.length} waiting task{openTodo.length === 1 ? "" : "s"}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

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
        <FolderIcon size={40} pinned={!!project.pinned} />
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
            <AutopilotCard project={project} openTodo={tasks.filter((t) => t.status === "todo" && !t.queued).map((t) => t.id)} />
            <div class="sec-head">
              <h2 class="sec-title">Backlog</h2>
              {tasks.filter((t) => t.status !== "done").length > 0 && <span class="sec-count">{tasks.filter((t) => t.status !== "done").length} open</span>}
            </div>
            <QuickAdd projectId={id} placeholder={`Add a task to ${project.name}`} autopilot={!!project.autopilot?.on} />
            <TaskList tasks={tasks} emptyText="No open tasks. Add one, then start an agent on it." />
          </section>
          <div class={mine.length ? "first-narrow" : ""}>
          <section class="sec">
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
          <TeamPanel projectId={id} />
          </div>
        </div>
      </div>
    </div>
  );
}
