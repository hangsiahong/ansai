import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, STATUS_LABEL, TASK_STATUSES, type Session, type Task, type TaskChecks, type TaskStatus, type TeamBoard } from "../api";
import { overlapsByTask, overlapText, overlapTitle, type TaskOverlap } from "../overlaps";
import { liveSessionsOf } from "../live";
import { getState, loadTeam, openSheet, patchTaskLocal, toastCleanup, toastError, useStore } from "../store";
import { Icon, Link, ToolBadge } from "../ui";

const byPos = (a: Task, b: Task) => a.position - b.position;

/**
 * A summary of a project's running agents, "" when fewer than two (nothing to overlap).
 * It moves when one starts, stops or changes state, or spends tokens (pushed every few
 * seconds while it works), which is when its files are likely to have changed.
 */
function teamSig(sessions: Session[], projectId: string): string {
  const live = sessions.filter((s) => s.project_id === projectId && s.status === "running" && (s.tool === "claude" || s.tool === "codex"));
  return live.length < 2 ? "" : live.map((s) => `${s.id}:${s.agent_state}:${s.tokens?.fresh ?? 0}`).join();
}

const byTaskMemo = new WeakMap<TeamBoard, { sessions: Session[]; map: Map<string, TaskOverlap[]> }>();
function overlapsFor(b: TeamBoard, sessions: Session[]) {
  const m = byTaskMemo.get(b);
  if (m?.sessions === sessions) return m.map;
  const map = overlapsByTask(b.overlaps, sessions);
  byTaskMemo.set(b, { sessions, map });
  return map;
}

/** The overlap badge's text (or tooltip) for a task, "" if none. Strings, so a row only re-renders when its badge changes. */
function clashLabel(s: ReturnType<typeof getState>, taskId: string, projectId: string | null, fmt: typeof overlapText) {
  const board = projectId ? s.teams[projectId] : undefined;
  const list = board && overlapsFor(board, s.sessions).get(taskId);
  if (!list?.length) return "";
  return fmt(list, (id) => {
    const x = s.sessions.find((y) => y.id === id);
    const t = x?.task_id ? s.tasks.find((y) => y.id === x.task_id) : null;
    return t?.title ?? x?.title ?? "another agent";
  });
}

/**
 * Files this task's agent shares with another running agent's task, from the project's
 * team board. Refetched when those agents move (see teamSig), never polled; the Team
 * panel's own refresh lands in the same store.
 */
function useOverlaps(task: Task): { text: string; title: string } | null {
  const pid = task.project_id;
  const live = useStore((s) => liveSessionsOf(s.sessions, task.id).length > 0);
  const sig = useStore((s) => (pid && live ? teamSig(s.sessions, pid) : ""));
  useEffect(() => {
    if (pid && sig) loadTeam(pid, sig);
  }, [pid, sig]);
  const from = sig ? pid : null;
  const text = useStore((s) => clashLabel(s, task.id, from, overlapText));
  const title = useStore((s) => clashLabel(s, task.id, from, overlapTitle));
  return text ? { text, title } : null;
}

export function QuickAdd(p: { projectId: string | null; placeholder?: string; status?: TaskStatus; autopilot?: boolean }) {
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
        placeholder={p.autopilot ? "Add a task — an agent picks it up" : (p.placeholder ?? "Add a task…")}
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
        api.updateTask(task.id, { status: next }).then(toastCleanup).catch(toastError);
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
  const live = useStore((s) => liveSessionsOf(s.sessions, task.id));
  const asking = live.find((s) => s.agent_state === "needs-input");
  const plan = task.plan && task.plan.total > 0 && task.status !== "done" ? task.plan : null;
  const clash = useOverlaps(task);
  return (
    <div class="tmeta">
      {asking ? (
        <Link href={`/s/${asking.id}`} class="tchip attn" title="The agent is waiting for you">
          <Icon name="bell" size={11} stroke={2.6} /> Needs you
        </Link>
      ) : task.queued && task.status === "todo" ? (
        <span class="tchip queued" title="Starts when an agent is free in this project">
          <Icon name="history" size={11} stroke={2.6} /> Queued
        </span>
      ) : null}
      {task.last_failure && task.status !== "done" && task.status !== "doing" && (
        <span class="tchip fail" title={`The last run stopped early: ${task.last_failure}`}>
          <Icon name="x" size={11} stroke={2.8} /> {task.queued && task.status === "todo" ? `Retrying (${task.attempts})` : "Stopped early"}
        </span>
      )}
      {task.checks && task.status !== "done" && <ChecksChip checks={task.checks} />}
      {task.status !== "done" && <ReviewChip task={task} />}
      {!!task.evidence?.length && task.status !== "done" && (
        <span class="tchip proof" title="Screenshots or logs the agent attached as proof">
          <Icon name="eye" size={11} stroke={2.6} /> {task.evidence.length}
        </span>
      )}
      {!!task.blocked_by?.length && (
        <span class="tchip waiting-on" title={`Waiting for: ${task.blocked_by.map((d) => d.title).join(", ")}`}>
          Blocked by {task.blocked_by.length === 1 ? task.blocked_by[0]!.title : `${task.blocked_by.length} tasks`}
        </span>
      )}
      {plan && (
        <span class="tplan" title={plan.current ?? "Agent's plan"}>
          <span class="tplan-bar">
            <i style={{ width: `${Math.round((plan.done / plan.total) * 100)}%` }} />
          </span>
          {plan.done}/{plan.total}
        </span>
      )}
      {showProject && <span class="tproj">{task.project_name ?? "Inbox"}</span>}
      {!asking &&
        live.map((s) => (
          <Link href={`/s/${s.id}`} class="tsess" title="Open the agent session">
            <ToolBadge tool={s.tool} size={16} /> {s.agent_state === "working" ? "working" : "open"}
          </Link>
        ))}
      {task.source === "agent" && <span class="tsrc">from an agent</span>}
      {task.summary && task.status === "review" && <span class="tsrc">summary ready</span>}
      {clash && (
        <span class="tsrc tclash" title={clash.title}>
          <Icon name="branch" size={11} stroke={2.4} />
          <span>{clash.text}</span>
        </span>
      )}
      {task.body.trim() && !task.summary && <span class="tnote" title="Has details">≡</span>}
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
              <div class="panel" style={{ "--sep": "48px" }}>
                {groups[st].map((t) => (
                  <TaskRow key={t.id} task={t} showProject={p.showProject} />
                ))}
              </div>
            </div>
          ),
      )}
      {groups.done.length > 0 && (
        <div class="tgroup">
          <button class="tgroup-head s-done toggle" onClick={() => setShowDone(!showDone)}>
            Done <span>{groups.done.length}</span> <em>{showDone ? "hide" : "show"}</em>
          </button>
          {showDone && (
            <div class="panel" style={{ "--sep": "48px" }}>
              {groups.done.map((t) => (
                <TaskRow key={t.id} task={t} showProject={p.showProject} />
              ))}
            </div>
          )}
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
    api.updateTask(id, { status, position }).then(toastCleanup).catch(toastError);
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

/** Where the independent review of a task stands: queued, running, its verdict, or findings back with the agent. */
export function ReviewChip({ task }: { task: Task }) {
  const r = task.review;
  const again = task.auto_review === 2 || (r?.round === 2 && r.status === "running");
  if (task.auto_review > 0)
    return (
      <span class="tchip queued" title="Another agent will review this task's changes">
        <Icon name="eye" size={11} stroke={2.6} /> {again ? "Re-check queued" : "Review queued"}
      </span>
    );
  if (!r) return null;
  const who = r.reviewer_tool === "codex" ? "Codex" : "Claude";
  if (r.status === "running")
    return (
      <span class="tchip queued" title={`${who} is reviewing this task's changes`}>
        <Icon name="refresh" size={11} stroke={2.6} /> {again ? "Re-checking" : "Reviewing"}
      </span>
    );
  if (r.sent_back && r.round === 1 && task.status === "doing")
    return (
      <span class="tchip waiting-on" title={`${who}'s findings went back to the agent, which is working on them`}>
        Fixing review findings
      </span>
    );
  const high = r.findings.filter((f) => f.severity === "high").length;
  if (r.status === "stopped" && !r.findings.length)
    return <span class="tchip waiting-on" title={r.summary ?? "The reviewer stopped before finishing"}>Review stopped</span>;
  if (!r.findings.length)
    return (
      <span class="tchip ok" title={r.summary ?? `${who} found nothing to fix`}>
        <Icon name="check" size={11} stroke={2.8} /> Reviewed
      </span>
    );
  return (
    <span class={`tchip ${high ? "fail" : "waiting-on"}`} title={r.summary ?? `${who} reported ${r.findings.length} finding(s)`}>
      {r.findings.length} {r.findings.length === 1 ? "issue" : "issues"}
      {high ? ` · ${high} serious` : ""}
    </span>
  );
}

export function ChecksChip({ checks }: { checks: TaskChecks }) {
  if ("running" in checks)
    return (
      <span class="tchip queued" title={`Running ${checks.cmd}`}>
        <Icon name="refresh" size={11} stroke={2.6} /> Checking
      </span>
    );
  return checks.ok ? (
    <span class="tchip ok" title={`${checks.cmd} passed in ${Math.round(checks.ms / 1000)}s`}>
      <Icon name="check" size={11} stroke={2.8} /> Checks
    </span>
  ) : (
    <span class="tchip fail" title={`${checks.cmd} failed`}>
      <Icon name="x" size={11} stroke={2.8} /> Checks failed
    </span>
  );
}
