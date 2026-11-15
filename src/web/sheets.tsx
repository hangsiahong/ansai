import { useEffect, useRef, useState } from "preact/hooks";
import { api, STATUS_LABEL, TASK_STATUSES, type ToolId } from "./api";
import { getState, openSheet, patchTaskLocal, refreshProjects, toast, toastError, useStore } from "./store";
import { AGENTS, Icon, Sheet, TOOL_LABEL, ToolDot, ago, nav, sessionState, shortPath } from "./ui";
import { AccountPicker } from "./accounts";

export function Sheets() {
  const sheet = useStore((s) => s.sheet);
  const close = () => openSheet(null);
  if (!sheet) return null;
  if (sheet.kind === "new") return <NewSessionSheet projectId={sheet.projectId} tool={sheet.tool} onClose={close} />;
  if (sheet.kind === "history") return <HistorySheet sessionId={sheet.sessionId} onClose={close} />;
  if (sheet.kind === "add-project") return <AddProjectSheet onClose={close} />;
  if (sheet.kind === "task") return <TaskSheet key={sheet.taskId} taskId={sheet.taskId} onClose={close} />;
  return null;
}

function ProjectSelect(p: { value: string; onChange: (v: string) => void; emptyLabel: string }) {
  const projects = useStore((s) => s.projects);
  return (
    <select value={p.value} onChange={(e) => p.onChange((e.target as HTMLSelectElement).value)}>
      <option value="">{p.emptyLabel}</option>
      {projects.map((pr) => (
        <option value={pr.id}>
          {pr.name} — {shortPath(pr.path)}
        </option>
      ))}
    </select>
  );
}

function YoloCheck(p: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label class="check">
      <input type="checkbox" checked={p.value} onChange={(e) => p.onChange((e.target as HTMLInputElement).checked)} />
      <span>
        Auto-approve everything <em>— the agent won't ask before running commands or editing files</em>
      </span>
    </label>
  );
}

function NewSessionSheet(p: { projectId?: string; tool?: ToolId; onClose: () => void }) {
  const tools = useStore((s) => s.tools);
  const [projectId, setProjectId] = useState(p.projectId ?? getState().projects[0]?.id ?? "");
  const [tool, setTool] = useState<ToolId>(p.tool ?? "claude");
  const [accountId, setAccountId] = useState<string | null>(null);
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
        <label class="field">
          <span>Project</span>
          <ProjectSelect value={projectId} onChange={setProjectId} emptyLabel="~ (home folder)" />
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
        {tool !== "shell" && <AccountPicker tool={tool} value={accountId} onChange={setAccountId} />}
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
        {tool !== "shell" && <YoloCheck value={yolo} onChange={setYolo} />}
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

const PRIORITIES = [
  { v: 0, label: "None" },
  { v: 1, label: "Low" },
  { v: 2, label: "Medium" },
  { v: 3, label: "High" },
];

function TaskSheet(p: { taskId: string; onClose: () => void }) {
  const task = useStore((s) => s.tasks.find((t) => t.id === p.taskId));
  const sessions = useStore((s) => s.sessions.filter((x) => x.task_id === p.taskId));
  const [title, setTitle] = useState(task?.title ?? "");
  const [body, setBody] = useState(task?.body ?? "");
  const [yolo, setYolo] = useState(false);
  const [accountByTool, setAccountByTool] = useState<Record<string, string | null>>({});
  const [agent, setAgent] = useState<ToolId>("claude");
  const [busy, setBusy] = useState(false);
  const dirty = useRef(false);

  const save = async (patch: Parameters<typeof api.updateTask>[1]) => {
    patchTaskLocal(p.taskId, { ...patch, project_id: patch.projectId !== undefined ? patch.projectId : task?.project_id } as never);
    try {
      await api.updateTask(p.taskId, patch);
    } catch (e) {
      toastError(e);
    }
  };

  // Text fields autosave shortly after typing stops.
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
      <Sheet title="Task" onClose={p.onClose}>
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
    if (!confirm(`Delete "${task.title}"?`)) return;
    try {
      await api.deleteTask(task.id);
      p.onClose();
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <Sheet
      title={task.project_name ? `Task · ${task.project_name}` : "Task · Inbox"}
      onClose={close}
      actions={
        <button class="icon-btn" onClick={remove} title="Delete task" aria-label="Delete task">
          <Icon name="trash" />
        </button>
      }
    >
      <div class="form">
        <input
          class="title-input"
          value={title}
          placeholder="Task title"
          onInput={(e) => {
            dirty.current = true;
            setTitle((e.target as HTMLInputElement).value);
          }}
        />
        <div class="chips" role="group" aria-label="Status">
          {TASK_STATUSES.map((st) => (
            <button class={`chip s-${st} ${task.status === st ? "on" : ""}`} onClick={() => save({ status: st })}>
              {STATUS_LABEL[st]}
            </button>
          ))}
        </div>
        <div class="grid2">
          <label class="field">
            <span>Project</span>
            <ProjectSelect value={task.project_id ?? ""} onChange={(v) => save({ projectId: v || null })} emptyLabel="Inbox (no project)" />
          </label>
          <label class="field">
            <span>Priority</span>
            <select value={task.priority} onChange={(e) => save({ priority: Number((e.target as HTMLSelectElement).value) })}>
              {PRIORITIES.map((x) => (
                <option value={x.v}>{x.label}</option>
              ))}
            </select>
          </label>
        </div>
        <label class="field">
          <span>Details — sent to the agent together with the title</span>
          <textarea
            rows={5}
            value={body}
            placeholder="Context, acceptance criteria, links…"
            onInput={(e) => {
              dirty.current = true;
              setBody((e.target as HTMLTextAreaElement).value);
            }}
          />
        </label>

        <div class="runbox">
          <div class="runbox-head">Start an agent on this task</div>
          {!task.project_id ? (
            <p class="muted small">Pick a project first — the agent runs inside it.</p>
          ) : (
            <>
              <div class="seg three">
                {AGENTS.map((t) => (
                  <button type="button" class={`seg-btn ${agent === t ? "on" : ""}`} onClick={() => setAgent(t)}>
                    <ToolDot tool={t} /> {TOOL_LABEL[t]}
                  </button>
                ))}
              </div>
              <AccountPicker tool={agent} value={accountByTool[agent] ?? null} onChange={(v) => setAccountByTool({ ...accountByTool, [agent]: v })} />
              <YoloCheck value={yolo} onChange={setYolo} />
              <button class="btn primary big" disabled={busy} onClick={run}>
                <Icon name="play" size={16} /> {busy ? "Starting…" : `Run with ${TOOL_LABEL[agent]}`}
              </button>
            </>
          )}
        </div>

        {sessions.length > 0 && (
          <div class="field">
            <span>Sessions for this task</span>
            <div class="list">
              {sessions.map((s) => {
                const st = sessionState(s);
                return (
                  <button
                    class="srow plain"
                    onClick={() => {
                      p.onClose();
                      nav(`/s/${s.id}`);
                    }}
                  >
                    <ToolDot tool={s.tool} />
                    <div class="srow-main">
                      <div class="srow-title">{TOOL_LABEL[s.tool]}</div>
                      <div class="srow-sub">started {ago(s.created_at)} ago</div>
                    </div>
                    <span class={`badge ${st.cls}`}>{st.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <p class="muted small">Created {ago(task.created_at)} ago</p>
      </div>
    </Sheet>
  );
}
