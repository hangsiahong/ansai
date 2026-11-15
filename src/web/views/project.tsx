import { useEffect, useState } from "preact/hooks";
import { api, type Autopilot, type Project, type Schedule, type ToolId } from "../api";
import { confirmDialog, openSheet, refreshProjects, toast, toastError, useStore } from "../store";
import { AGENTS, Empty, FolderIcon, Icon, TOOL_LABEL, ToolBadge, goBack, nav, shortPath, useTick } from "../ui";
import { AccountPicker } from "../accounts";
import { ModelPicker } from "../models";
import { Launchers, SessionCell } from "./now";
import { QuickAdd, TaskList } from "./tasks";
import { TeamPanel } from "../team";
import { PlaybookCard } from "../playbook";
import { canShift } from "../shift";

const RUN_LIMITS: [number | null, string][] = [
  [null, "None"],
  [15, "15 min"],
  [30, "30 min"],
  [60, "1 hour"],
  [120, "2 hours"],
  [240, "4 hours"],
];

function Schedules({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<Schedule[]>([]);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [tool, setTool] = useState<Exclude<ToolId, "shell">>("claude");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [pick, setPick] = useState({ model: null as string | null, effort: null as string | null });
  const [cadence, setCadence] = useState<Schedule["cadence"]>("weekdays");
  const [localTime, setLocalTime] = useState("09:00");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const reload = () => api.schedules(projectId).then(setRows).catch(toastError);
  useEffect(() => { reload(); }, [projectId]);
  const clear = () => { setEditing(null); setTitle(""); setPrompt(""); setTool("claude"); setAccountId(null); setPick({ model: null, effort: null }); setCadence("weekdays"); setLocalTime("09:00"); setShowForm(false); };
  const edit = (s: Schedule) => { setEditing(s); setTitle(s.title); setPrompt(s.prompt); setTool(s.tool); setAccountId(s.account_id); setPick({ model: s.model, effort: s.effort }); setCadence(s.cadence); setLocalTime(s.local_time); setTimezone(s.timezone); setShowForm(true); };
  const save = async (e: Event) => {
    e.preventDefault(); setBusy(true);
    try { await api.saveSchedule(projectId, { ...(editing ? { id: editing.id } : {}), title, prompt, tool, account_id: accountId, ...pick, cadence, local_time: localTime, timezone }); clear(); await reload(); }
    catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const act = async (f: () => Promise<unknown>, message: string) => { try { await f(); toast(message); await reload(); } catch (e) { toastError(e); } };
  return <section class="sec">
    <div class="sec-head"><h2 class="sec-title">Scheduled tasks</h2><button class="sec-link" onClick={() => { clear(); setShowForm(true); }}>＋ Add schedule</button></div>
    {rows.map((s) => <article class="panel schedule-card" key={s.id}>
      <div class="schedule-title"><b>{s.title}</b><span class="muted small">{s.enabled ? `Next · ${new Date(s.next_at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: s.timezone })} (${s.timezone})` : "Paused"}</span></div>
      <div class="muted small">{s.cadence} · {s.local_time} · {s.tool}{s.model ? ` · ${s.model}` : ""}</div>
      {s.occurrences.slice(0, 3).map((o) => <div class="schedule-run" key={o.id}><span>{new Date(o.scheduled_for).toLocaleDateString()}</span><a href={`/p/${projectId}`} onClick={(e) => { e.preventDefault(); openSheet({ kind: "task", taskId: o.task_id }); }}>{o.status === "needs_attention" ? "Needs attention" : o.task_status === "review" ? "Review" : o.status}</a>{o.session_id && <a href={`/s/${o.session_id}`} onClick={(e) => { e.preventDefault(); nav(`/s/${o.session_id}`); }}>Session</a>}{o.outcome && <span class="muted small">{o.outcome}</span>}</div>)}
      <div class="schedule-actions"><button class="btn sm" onClick={async () => { try { const r = await api.runScheduleNow(projectId, s.id); toast(r.queued ? "Run queued — it will start when the project and run limit allow" : "Task created — turn on autopilot or start it from the backlog"); await reload(); } catch (e) { toastError(e); } }}>Run now</button><button class="btn sm" onClick={() => act(() => api.toggleSchedule(projectId, s.id, !s.enabled), s.enabled ? "Schedule paused" : "Schedule enabled")}>{s.enabled ? "Pause" : "Enable"}</button><button class="btn sm" onClick={() => edit(s)}>Edit</button><button class="btn sm" onClick={() => act(() => api.deleteSchedule(projectId, s.id), "Schedule deleted")}>Delete</button></div>
    </article>)}
    {!rows.length && <p class="muted small">Save a prompt to create a reviewable task on a schedule.</p>}
    {showForm && <form class="panel form schedule-form" onSubmit={save}>
      <h3>{editing ? "Edit schedule" : "New schedule"}</h3>
      <label class="field"><span>Task title</span><input required maxLength={300} value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} /></label>
      <label class="field"><span>Prompt</span><textarea required rows={4} value={prompt} onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)} /></label>
      <label class="field"><span>Agent</span><select class="select" value={tool} onChange={(e) => { setTool((e.target as HTMLSelectElement).value as typeof tool); setAccountId(null); setPick({ model: null, effort: null }); }}>{AGENTS.map((a: ToolId) => <option value={a}>{TOOL_LABEL[a]}</option>)}</select></label>
      <AccountPicker tool={tool} value={accountId} onChange={setAccountId} />
      <ModelPicker tool={tool} accountId={accountId} value={pick} onChange={setPick} />
      <div class="schedule-grid"><label class="field"><span>Cadence</span><select class="select" value={cadence} onChange={(e) => setCadence((e.target as HTMLSelectElement).value as Schedule["cadence"])}><option value="daily">Daily</option><option value="weekdays">Weekdays</option><option value="weekly">Weekly</option></select></label><label class="field"><span>Local time</span><input type="time" required value={localTime} onInput={(e) => setLocalTime((e.target as HTMLInputElement).value)} /></label></div>
      <label class="field"><span>Timezone</span><input required value={timezone} onInput={(e) => setTimezone((e.target as HTMLInputElement).value)} placeholder="America/New_York" /></label>
      <div class="schedule-actions"><button class="btn primary" disabled={busy}>{busy ? "Saving…" : "Save schedule"}</button><button type="button" class="btn" onClick={clear}>Cancel</button></div>
    </form>}
  </section>;
}

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
            <em>In Git projects each task gets its own branch, so several can run at once. They ask before guessing.</em>
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
            <label class="switch-row inner">
              <span>
                <b>Time limit per run</b>
                <em>Then it stops and the task waits in Review</em>
              </span>
              <select
                class="select"
                style={{ width: "auto", flex: "none" }}
                value={ap.maxMinutes ?? ""}
                onChange={(e) => set({ maxMinutes: Number((e.target as HTMLSelectElement).value) || null })}
              >
                {RUN_LIMITS.map(([m, label]) => (
                  <option value={m ?? ""}>{label}</option>
                ))}
              </select>
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
            <PlaybookCard projectId={id} />
            <Schedules projectId={id} />
            <div class="sec-head">
              <h2 class="sec-title">Backlog</h2>
              {tasks.filter((t) => t.status !== "done").length > 0 && <span class="sec-count">{tasks.filter((t) => t.status !== "done").length} open</span>}
            </div>
            <QuickAdd projectId={id} placeholder={`Add a task to ${project.name}`} autopilot={!!project.autopilot?.on} />
            <TaskList tasks={tasks} emptyText="No open tasks. Add one, then start an agent on it." />
          </section>
          <div class={mine.length ? "first-narrow" : ""}>
          <section class="sec">
            <div class="sec-head">
              <h2 class="sec-title">Sessions</h2>
              {mine.some(canShift) && (
                <button class="sec-link" onClick={() => openSheet({ kind: "shift", projectId: id })}>
                  <Icon name="moon" size={14} />
                  {mine.some((s) => s.shift?.active) ? `${mine.filter((s) => s.shift?.active).length} on shift` : "Keep working"}
                </button>
              )}
            </div>
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
