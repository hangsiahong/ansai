import { useMemo, useRef, useState } from "preact/hooks";
import { api, STATUS_LABEL, TASK_STATUSES, type Task, type TaskStatus } from "../api";
import { openSheet, patchTaskLocal, toastError } from "../store";
import { Icon, Link, ToolBadge } from "../ui";

const byPos = (a: Task, b: Task) => a.position - b.position;

export function QuickAdd(p: { projectId: string | null; placeholder?: string; status?: TaskStatus }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await api.createTask({ title: t, projectId: p.projectId, status: p.status });
      setTitle("");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      class="quickadd"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <Icon name="plus" size={17} />
      <input
        value={title}
        placeholder={p.placeholder ?? "Add a task…"}
        enterkeyhint="done"
        onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
      />
      {title.trim() && (
        <button class="btn sm primary" type="submit" disabled={busy}>
          Add
        </button>
      )}
    </form>
  );
}

function StatusDot({ task }: { task: Task }) {
  const next: TaskStatus = task.status === "done" ? "todo" : "done";
  return (
    <button
      class={`sdot s-${task.status}`}
      title={task.status === "done" ? "Mark not done" : "Mark done"}
      aria-label={task.status === "done" ? "Mark not done" : "Mark done"}
      onClick={(e) => {
        e.stopPropagation();
        patchTaskLocal(task.id, { status: next });
        api.updateTask(task.id, { status: next }).catch(toastError);
      }}
    >
      {task.status === "done" && <Icon name="check" size={12} />}
    </button>
  );
}

function Prio({ p }: { p: number }) {
  if (!p) return null;
  return (
    <span class={`prio p${p}`} title={["", "Low", "Medium", "High"][p] + " priority"}>
      {"!".repeat(p)}
    </span>
  );
}

function TaskMeta({ task, showProject }: { task: Task; showProject?: boolean }) {
  const live = task.sessions.filter((s) => s.status === "running");
  return (
    <div class="tmeta">
      {showProject && <span class="tproj">{task.project_name ?? "Inbox"}</span>}
      {live.map((s) => (
        <Link href={`/s/${s.id}`} class="tsess" title="Open the agent session">
          <ToolBadge tool={s.tool} size={16} /> running
        </Link>
      ))}
      {task.body.trim() && <span class="tnote" title="Has details">≡</span>}
    </div>
  );
}

export function TaskRow({ task, showProject }: { task: Task; showProject?: boolean }) {
  return (
    <div class={`trow ${task.status === "done" ? "done" : ""}`} onClick={() => openSheet({ kind: "task", taskId: task.id })} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && openSheet({ kind: "task", taskId: task.id })}>
      <StatusDot task={task} />
      <div class="trow-main">
        <div class="trow-title">
          <Prio p={task.priority} />
          {task.title}
        </div>
        <TaskMeta task={task} showProject={showProject} />
      </div>
    </div>
  );
}

/** Grouped list (phone + project page): Doing, Review, To do, then a collapsible Done. */
export function TaskList(p: { tasks: Task[]; showProject?: boolean; emptyText?: string }) {
  const [showDone, setShowDone] = useState(false);
  const groups = useMemo(() => {
    const g: Record<TaskStatus, Task[]> = { todo: [], doing: [], review: [], done: [] };
    for (const t of p.tasks) g[t.status].push(t);
    for (const k of TASK_STATUSES) g[k].sort(byPos);
    return g;
  }, [p.tasks]);
  const open = groups.todo.length + groups.doing.length + groups.review.length;

  return (
    <div class="tasklist">
      {open === 0 && <p class="empty">{p.emptyText ?? "Nothing to do. Add the first task above."}</p>}
      {(["doing", "review", "todo"] as TaskStatus[]).map(
        (st) =>
          groups[st].length > 0 && (
            <div class="tgroup">
              <div class={`tgroup-head s-${st}`}>
                {STATUS_LABEL[st]} <span>{groups[st].length}</span>
              </div>
              {groups[st].map((t) => (
                <TaskRow task={t} showProject={p.showProject} />
              ))}
            </div>
          ),
      )}
      {groups.done.length > 0 && (
        <div class="tgroup">
          <button class="tgroup-head s-done toggle" onClick={() => setShowDone(!showDone)}>
            Done <span>{groups.done.length}</span> <em>{showDone ? "hide" : "show"}</em>
          </button>
          {showDone && groups.done.map((t) => <TaskRow task={t} showProject={p.showProject} />)}
        </div>
      )}
    </div>
  );
}

/** Kanban board for wide screens, with drag and drop between and within columns. */
export function Board(p: { tasks: Task[]; showProject?: boolean; addProjectId: string | null }) {
  const [drag, setDrag] = useState<string | null>(null);
  const [hint, setHint] = useState<{ status: TaskStatus; before: string | null } | null>(null);
  const cols = useMemo(() => {
    const g: Record<TaskStatus, Task[]> = { todo: [], doing: [], review: [], done: [] };
    for (const t of p.tasks) g[t.status].push(t);
    for (const k of TASK_STATUSES) g[k].sort(byPos);
    return g;
  }, [p.tasks]);
  const lastHint = useRef(hint);
  lastHint.current = hint;

  const drop = (status: TaskStatus) => {
    const h = lastHint.current;
    const id = drag;
    setDrag(null);
    setHint(null);
    if (!id) return;
    const list = cols[status].filter((t) => t.id !== id);
    const before = h?.status === status ? h.before : null;
    let position: number;
    if (!list.length) position = 0;
    else if (before === null) position = list[list.length - 1]!.position + 1;
    else {
      const i = list.findIndex((t) => t.id === before);
      const next = list[i]!;
      const prev = list[i - 1];
      position = prev ? (prev.position + next.position) / 2 : next.position - 1;
    }
    patchTaskLocal(id, { status, position });
    api.updateTask(id, { status, position }).catch(toastError);
  };

  return (
    <div class="board">
      {TASK_STATUSES.map((st) => (
        <section
          class={`col ${hint?.status === st && drag ? "over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            if (!hint || hint.status !== st) setHint({ status: st, before: null });
          }}
          onDrop={(e) => {
            e.preventDefault();
            drop(st);
          }}
        >
          <header class={`col-head s-${st}`}>
            {STATUS_LABEL[st]} <span>{cols[st].length}</span>
          </header>
          {st === "todo" && <QuickAdd projectId={p.addProjectId} />}
          <div class="col-body">
            {cols[st].map((t) => (
              <div
                class={`card task ${drag === t.id ? "dragging" : ""} ${hint?.before === t.id && drag && drag !== t.id ? "drop-before" : ""}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer?.setData("text/plain", t.id);
                  setDrag(t.id);
                }}
                onDragEnd={() => {
                  setDrag(null);
                  setHint(null);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const idx = cols[st].indexOf(t);
                  const before = e.clientY < r.top + r.height / 2 ? t.id : (cols[st][idx + 1]?.id ?? null);
                  if (hint?.status !== st || hint.before !== before) setHint({ status: st, before });
                }}
                onClick={() => openSheet({ kind: "task", taskId: t.id })}
              >
                <div class="card-title">
                  <Prio p={t.priority} />
                  {t.title}
                </div>
                <TaskMeta task={t} showProject={p.showProject} />
              </div>
            ))}
            {drag && hint?.status === st && hint.before === null && <div class="drop-end" />}
          </div>
        </section>
      ))}
    </div>
  );
}
