import { useEffect, useRef, useState } from "preact/hooks";
import { api, STATUS_LABEL, TASK_STATUSES, type DeviceList, type Settings, type ToolId } from "./api";
import { confirmDialog, getState, openSheet, patchTaskLocal, refreshProjects, setTheme, toast, toastError, useStore, type ThemePref } from "./store";
import { AGENTS, Icon, Sheet, StatusPill, TOOL_LABEL, TOOL_SHORT, ToolBadge, ago, nav, shortPath } from "./ui";
import { AccountPicker } from "./accounts";
import { NotifyPanel } from "./notify";

export function Sheets() {
  const sheet = useStore((s) => s.sheet);
  const close = () => openSheet(null);
  if (!sheet) return null;
  if (sheet.kind === "new") return <NewSessionSheet projectId={sheet.projectId} tool={sheet.tool} accountId={sheet.accountId} onClose={close} />;
  if (sheet.kind === "history") return <HistorySheet sessionId={sheet.sessionId} onClose={close} />;
  if (sheet.kind === "add-project") return <AddProjectSheet onClose={close} />;
  if (sheet.kind === "task") return <TaskSheet key={sheet.taskId} taskId={sheet.taskId} onClose={close} />;
  if (sheet.kind === "new-task") return <NewTaskSheet projectId={sheet.projectId ?? null} onClose={close} />;
  if (sheet.kind === "settings") return <SettingsSheet onClose={close} />;
  return null;
}

function ProjectSelect(p: { value: string; onChange: (v: string) => void; emptyLabel: string }) {
  const projects = useStore((s) => s.projects);
  return (
    <select class="select" value={p.value} onChange={(e) => p.onChange((e.target as HTMLSelectElement).value)}>
      <option value="">{p.emptyLabel}</option>
      {projects.filter((x) => x.pinned).length > 0 && (
        <optgroup label="Pinned">
          {projects
            .filter((x) => x.pinned)
            .map((pr) => (
              <option value={pr.id}>{pr.name}</option>
            ))}
        </optgroup>
      )}
      <optgroup label="All projects">
        {projects.map((pr) => (
          <option value={pr.id}>
            {pr.name} — {shortPath(pr.path)}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

function AgentPicker(p: { value: ToolId; onChange: (t: ToolId) => void; withShell?: boolean }) {
  const tools = useStore((s) => s.tools);
  const list: ToolId[] = p.withShell ? ["claude", "codex", "agy", "shell"] : AGENTS;
  return (
    <div class={`agent-pick n${list.length}`} role="radiogroup" aria-label="Agent">
      {list.map((t) => {
        const installed = tools.find((x) => x.id === t)?.installed !== false;
        return (
          <button
            type="button"
            role="radio"
            aria-checked={p.value === t}
            aria-label={TOOL_LABEL[t]}
            title={TOOL_LABEL[t]}
            class={`agent-opt ${p.value === t ? "on" : ""}`}
            disabled={!installed}
            onClick={() => p.onChange(t)}
          >
            <ToolBadge tool={t} size={52} />
          </button>
        );
      })}
    </div>
  );
}

function YoloSwitch(p: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label class="switch-row">
      <span>
        <b>Auto-approve</b>
        <em>Runs commands and edits files without asking</em>
      </span>
      <input type="checkbox" class="switch" checked={p.value} onChange={(e) => p.onChange((e.target as HTMLInputElement).checked)} />
    </label>
  );
}

function NewSessionSheet(p: { projectId?: string; tool?: ToolId; accountId?: string; onClose: () => void }) {
  const [projectId, setProjectId] = useState(p.projectId ?? getState().projects.find((x) => x.pinned)?.id ?? getState().projects[0]?.id ?? "");
  const [tool, setTool] = useState<ToolId>(p.tool ?? "claude");
  const [accountId, setAccountId] = useState<string | null>(p.accountId ?? null);
  const [prompt, setPrompt] = useState("");
  const [yolo, setYolo] = useState(false);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      const s = await api.createSession({ tool, projectId: projectId || undefined, prompt, yolo, accountId });
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
        <AgentPicker value={tool} onChange={(t) => (setTool(t), setAccountId(null))} withShell />
        <label class="field">
          <span>Project</span>
          <ProjectSelect value={projectId} onChange={setProjectId} emptyLabel="Home folder (~)" />
        </label>
        {tool !== "shell" && <AccountPicker tool={tool} value={accountId} onChange={setAccountId} />}
        {tool !== "shell" && (
          <label class="field">
            <span>First message</span>
            <textarea
              class="input"
              rows={3}
              placeholder="Optional — what should it work on?"
              value={prompt}
              onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
              }}
            />
          </label>
        )}
        {tool !== "shell" && <YoloSwitch value={yolo} onChange={setYolo} />}
        <button class="btn primary lg" disabled={busy} onClick={start}>
          <Icon name="play" size={16} /> {busy ? "Starting…" : `Start ${TOOL_LABEL[tool]}`}
        </button>
      </div>
    </Sheet>
  );
}

function HistorySheet(p: { sessionId: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const pre = useRef<HTMLPreElement>(null);
  const load = () => api.history(p.sessionId).then(setText).catch(toastError);
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
            class="btn sm"
            onClick={() =>
              navigator.clipboard
                ?.writeText(text ?? "")
                .then(() => toast("Copied"))
                .catch(() => toast("Clipboard blocked — select the text instead", "error"))
            }
          >
            Copy all
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
    <Sheet title="Add a folder" onClose={p.onClose} size="sm">
      <form
        class="form"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <label class="field">
          <span>Path on this laptop</span>
          <input class="input mono" value={path} onInput={(e) => setPath((e.target as HTMLInputElement).value)} autoFocus />
        </label>
        <button class="btn primary lg">Add project</button>
      </form>
    </Sheet>
  );
}

function NewTaskSheet(p: { projectId: string | null; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState(p.projectId ?? "");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api.createTask({ title: title.trim(), projectId: projectId || null });
      toast("Task added");
      p.onClose();
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };
  return (
    <Sheet title="New task" onClose={p.onClose} size="sm">
      <form
        class="form"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input class="input" placeholder="What needs doing?" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} autoFocus />
        <label class="field">
          <span>Project</span>
          <ProjectSelect value={projectId} onChange={setProjectId} emptyLabel="Inbox (decide later)" />
        </label>
        <button class="btn primary lg" disabled={busy || !title.trim()}>
          Add task
        </button>
      </form>
    </Sheet>
  );
}

const PRIORITIES = ["None", "Low", "Medium", "High"];

function TaskSheet(p: { taskId: string; onClose: () => void }) {
  const task = useStore((s) => s.tasks.find((t) => t.id === p.taskId));
  const autopilot = useStore((s) => s.projects.find((x) => x.id === task?.project_id)?.autopilot ?? null);
  const sessions = useStore((s) => s.sessions.filter((x) => x.task_id === p.taskId));
  const [title, setTitle] = useState(task?.title ?? "");
  const [body, setBody] = useState(task?.body ?? "");
  const [yolo, setYolo] = useState(false);
  const [accountByTool, setAccountByTool] = useState<Record<string, string | null>>({});
  const [agent, setAgent] = useState<ToolId>(() => getState().projects.find((x) => x.id === task?.project_id)?.autopilot?.tool ?? "claude");
  const [busy, setBusy] = useState(false);
  const dirty = useRef(false);

  const save = async (patch: Parameters<typeof api.updateTask>[1]) => {
    const local: Record<string, unknown> = { ...patch };
    if (patch.projectId !== undefined) local.project_id = patch.projectId;
    patchTaskLocal(p.taskId, local);
    try {
      await api.updateTask(p.taskId, patch);
    } catch (e) {
      toastError(e);
    }
  };

  useEffect(() => {
    if (!task || !dirty.current) return;
    const h = setTimeout(() => {
      if (title.trim() && (title !== task.title || body !== task.body)) {
        dirty.current = false;
        save({ title, body });
      }
    }, 600);
    return () => clearTimeout(h);
  }, [title, body]);

  const close = () => {
    if (task && dirty.current && title.trim() && (title !== task.title || body !== task.body)) save({ title, body });
    p.onClose();
  };

  if (!task) {
    return (
      <Sheet title="Task" onClose={p.onClose} size="sm">
        <div class="form">
          <p class="muted">This task no longer exists.</p>
        </div>
      </Sheet>
    );
  }

  const run = async () => {
    setBusy(true);
    try {
      if (dirty.current) await save({ title, body });
      const s = await api.runTask(task.id, { tool: agent, yolo, accountId: accountByTool[agent] ?? null });
      p.onClose();
      nav(`/s/${s.id}`);
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!(await confirmDialog({ title: "Delete this task?", body: task.title, confirm: "Delete", danger: true }))) return;
    try {
      await api.deleteTask(task.id);
      p.onClose();
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <Sheet
      title={task.project_name ?? "Inbox"}
      onClose={close}
      actions={
        <button class="icon-btn" onClick={remove} title="Delete task" aria-label="Delete task">
          <Icon name="trash" />
        </button>
      }
    >
      <div class="form">
        <textarea
          class="title-input"
          rows={1}
          value={title}
          placeholder="Task title"
          onInput={(e) => {
            dirty.current = true;
            const t = e.target as HTMLTextAreaElement;
            setTitle(t.value.replace(/\n/g, " "));
            t.style.height = "auto";
            t.style.height = t.scrollHeight + "px";
          }}
        />
        <div class="segmented" role="radiogroup" aria-label="Status">
          {TASK_STATUSES.map((st) => (
            <button role="radio" aria-checked={task.status === st} class={`seg s-${st} ${task.status === st ? "on" : ""}`} onClick={() => save({ status: st })}>
              {STATUS_LABEL[st]}
            </button>
          ))}
        </div>
        <textarea
          class="input notes"
          rows={4}
          value={body}
          placeholder="Details — context, acceptance criteria, links. Sent to the agent with the title."
          onInput={(e) => {
            dirty.current = true;
            setBody((e.target as HTMLTextAreaElement).value);
          }}
        />
        <div class="grid2">
          <label class="field">
            <span>Project</span>
            <ProjectSelect value={task.project_id ?? ""} onChange={(v) => save({ projectId: v || null })} emptyLabel="Inbox" />
          </label>
          <label class="field">
            <span>Priority</span>
            <select class="select" value={task.priority} onChange={(e) => save({ priority: Number((e.target as HTMLSelectElement).value) })}>
              {PRIORITIES.map((x, i) => (
                <option value={i}>{x}</option>
              ))}
            </select>
          </label>
        </div>

        {task.summary && (
          <div class="summary-card">
            <div class="summary-head">
              <Icon name="check" size={14} stroke={2.6} /> Agent's summary
            </div>
            <p>{task.summary}</p>
          </div>
        )}

        {task.worktree_path && (
          <div class="field">
            <span>Task worktree · {task.worktree_branch}</span>
            <div class="muted small">{task.worktree_path}</div>
          </div>
        )}

        {task.plan && task.plan.total > 0 && (
          <div class="field">
            <span>
              Agent's plan · {task.plan.done}/{task.plan.total}
            </span>
            <div class="panel plan-panel">
              <ul class="todos">
                {task.plan.items.map((it) => (
                  <li class={it.status}>
                    <span class="todo-box">{it.status === "completed" ? <Icon name="check" size={12} stroke={3} /> : it.status === "in_progress" ? <i /> : null}</span>
                    {it.content}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <div class="runbox">
          <div class="runbox-head">
            <Icon name="play" size={14} /> Hand it to an agent
          </div>
          {!task.project_id ? (
            <p class="muted small">Pick a project first — the agent works inside it.</p>
          ) : (
            <>
              <label class="switch-row">
                <span>
                  <b>Queue for an agent</b>
                  <em>Starts on its own when this project is free{autopilot?.on ? " (autopilot is on here)" : ""}</em>
                </span>
                <input
                  type="checkbox"
                  class="switch"
                  checked={!!task.queued}
                  disabled={task.status !== "todo"}
                  onChange={(e) => save({ queued: (e.target as HTMLInputElement).checked })}
                />
              </label>
              <div class="or-sep">or start it now</div>
              <AgentPicker value={agent} onChange={setAgent} />
              <AccountPicker tool={agent} value={accountByTool[agent] ?? null} onChange={(v) => setAccountByTool({ ...accountByTool, [agent]: v })} />
              <YoloSwitch value={yolo} onChange={setYolo} />
              <button class="btn primary lg" disabled={busy} onClick={run}>
                {busy ? "Starting…" : `Run now with ${TOOL_LABEL[agent]}`}
              </button>
            </>
          )}
        </div>

        {sessions.length > 0 && (
          <div class="field">
            <span>Agent sessions</span>
            <div class="panel">
              {sessions.map((s) => (
                <button
                  class="prow"
                  onClick={() => {
                    p.onClose();
                    nav(`/s/${s.id}`);
                  }}
                >
                  <ToolBadge tool={s.tool} size={22} />
                  <span class="prow-main">
                    <span class="prow-name">{TOOL_LABEL[s.tool]}</span>
                    <span class="prow-path">started {ago(s.created_at)} ago</span>
                  </span>
                  <StatusPill s={s} compact />
                </button>
              ))}
            </div>
          </div>
        )}
        <p class="muted small">Created {ago(task.created_at)} ago</p>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ settings

function DevicesPanel() {
  const me = useStore((s) => s.me);
  const [list, setList] = useState<DeviceList | null>(null);
  useEffect(() => {
    api.devices().then(setList).catch(toastError);
  }, []);
  if (!list) return <p class="muted small">Loading devices…</p>;

  const toggle = async (id: string, allow: boolean) => {
    const current = list.devices.filter((d) => d.allowed && !d.self).map((d) => d.id);
    const next = allow ? [...current, id] : current.filter((x) => x !== id);
    if (!allow) {
      const d = list.devices.find((x) => x.id === id)!;
      const ok = await confirmDialog({ title: `Block ${d.name}?`, body: "It can't open ansai until you allow it again from an allowed device.", confirm: "Block", danger: true });
      if (!ok) return;
    }
    try {
      setList(await api.setDevices(next));
    } catch (e) {
      toastError(e);
    }
  };

  const devices = [...list.devices].sort((a, b) => Number(b.self) - Number(a.self) || Number(b.allowed) - Number(a.allowed) || a.name.localeCompare(b.name));
  return (
    <div class="devices">
      <p class="muted small">
        Only allowed devices on your Tailscale network can open ansai. This laptop is always allowed.
        {!list.configured && " Right now every device on your account is allowed."}
      </p>
      {list.blocked.length > 0 && (
        <div class="blocked-note">
          <Icon name="lock" size={14} /> Recently blocked: {list.blocked.map((b) => `${b.name} (${ago(b.at)} ago)`).join(", ")}
        </div>
      )}
      <div class="panel">
        {devices.map((d) => (
          <div class="prow">
            <span class={`prow-icon ${d.online ? "online" : "muted-tile"}`}>
              <Icon name={/ios|android/i.test(d.os) ? "phone" : "laptop"} size={16} />
            </span>
            <span class="prow-main">
              <span class="prow-name">
                {d.name}
                {me?.device === d.name && <em class="you">this device</em>}
              </span>
              <span class="prow-path">
                {d.self ? "the laptop running ansai" : `${d.os || "device"} · ${d.online ? "online" : d.lastSeen ? `seen ${ago(Date.parse(d.lastSeen))} ago` : "offline"}`}
              </span>
            </span>
            {d.self ? (
              <span class="mini-stat">always</span>
            ) : (
              <input type="checkbox" class="switch" checked={d.allowed} aria-label={`Allow ${d.name}`} onChange={(e) => toggle(d.id, (e.target as HTMLInputElement).checked)} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function BacklogSettings() {
  const [st, setSt] = useState<Settings | null>(null);
  useEffect(() => {
    api.settings().then(setSt).catch(toastError);
  }, []);
  if (!st) return null;
  const save = (patch: Partial<Settings>) => {
    setSt({ ...st, ...patch });
    api.updateSettings(patch).then(setSt).catch(toastError);
  };
  return (
    <div class="panel">
      <label class="switch-row">
        <span>
          <b>Record agent sessions</b>
          <em>Sessions you start by hand show up as tasks</em>
        </span>
        <input type="checkbox" class="switch" checked={st.trackSessions} onChange={(e) => save({ trackSessions: (e.target as HTMLInputElement).checked })} />
      </label>
      <div class="switch-row">
        <span>
          <b>Autopilot agents at once</b>
          <em>Across all projects · one per project</em>
        </span>
        <div class="stepper">
          <button onClick={() => save({ autopilotMax: Math.max(1, st.autopilotMax - 1) })} aria-label="Fewer">
            −
          </button>
          <b>{st.autopilotMax}</b>
          <button onClick={() => save({ autopilotMax: Math.min(6, st.autopilotMax + 1) })} aria-label="More">
            +
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsSheet(p: { onClose: () => void }) {
  const theme = useStore((s) => s.theme);
  const me = useStore((s) => s.me);
  const options: { v: ThemePref; icon: string; label: string }[] = [
    { v: "system", icon: "monitor", label: "System" },
    { v: "dark", icon: "moon", label: "Dark" },
    { v: "light", icon: "sun", label: "Light" },
  ];
  return (
    <Sheet title="Settings" onClose={p.onClose}>
      <div class="form settings">
        <section>
          <h3 class="set-title">Appearance</h3>
          <div class="segmented" role="radiogroup" aria-label="Theme">
            {options.map((o) => (
              <button role="radio" aria-checked={theme === o.v} class={`seg ${theme === o.v ? "on" : ""}`} onClick={() => setTheme(o.v)}>
                <Icon name={o.icon} size={15} /> {o.label}
              </button>
            ))}
          </div>
        </section>
        <section>
          <h3 class="set-title">Backlog</h3>
          <BacklogSettings />
        </section>
        <section>
          <h3 class="set-title">Notifications</h3>
          <NotifyPanel />
        </section>
        <section>
          <h3 class="set-title">Devices</h3>
          <DevicesPanel />
        </section>
        {me && (
          <p class="muted small fineprint">
            {me.user === "local" ? "Opened on this laptop" : `Signed in as ${me.user} on ${me.device}`} · {me.tailscale.url ?? "local only"}
          </p>
        )}
      </div>
    </Sheet>
  );
}
