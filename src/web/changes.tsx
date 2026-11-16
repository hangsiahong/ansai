import { useEffect, useState } from "preact/hooks";
import { api, type Changes, type FileChange } from "./api";
import { confirmDialog, openSheet, toast, toastError, useStore } from "./store";
import { haptic, Icon, Sheet, ago } from "./ui";

/**
 * What an agent changed, as a reviewable diff: a task's worktree against the
 * branch it left (its commits plus uncommitted work), or a session's folder
 * against its last commit. Files collapse to one row each; tap to read hunks.
 */

const STATUS: Record<FileChange["status"], { letter: string; label: string }> = {
  added: { letter: "A", label: "Added" },
  untracked: { letter: "N", label: "New, not committed" },
  modified: { letter: "M", label: "Modified" },
  deleted: { letter: "D", label: "Deleted" },
  renamed: { letter: "R", label: "Renamed" },
};

/** A line someone wants to comment on: the file, its line number (new side, or old for removed lines) and its text. */
export type LineRef = { path: string; line: number; side: "new" | "old"; text: string };

function Hunks({ patch, path, onLine, marked }: { patch: string; path: string; onLine?: (r: LineRef) => void; marked?: Set<string> }) {
  let oldN = 0;
  let newN = 0;
  return (
    <pre class={`diff ${onLine ? "tappable" : ""}`}>
      {patch.split("\n").map((l) => {
        if (l.startsWith("@@")) {
          const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
          if (m) ((oldN = Number(m[1])), (newN = Number(m[2])));
          const ctx = l.replace(/^@@[^@]*@@ ?/, "");
          return <div class="d-hunk">{m ? `Line ${m[2]}${ctx ? " · " + ctx : ""}` : l}</div>;
        }
        if (l.startsWith("\\")) return null; // "\ No newline at end of file"
        const t = l[0];
        const ref: LineRef = t === "-" ? { path, line: oldN++, side: "old", text: l.slice(1) } : { path, line: newN++, side: "new", text: l.slice(1) };
        if (t !== "-" && t !== "+") oldN++;
        const key = `${path}:${ref.side}:${ref.line}`;
        return (
          <div class={`${t === "+" ? "d-add" : t === "-" ? "d-del" : "d-ctx"} ${marked?.has(key) ? "marked" : ""}`} onClick={onLine ? () => onLine(ref) : undefined}>
            <span>{t === "+" || t === "-" ? t : " "}</span>
            {l.slice(1) || " "}
          </div>
        );
      })}
    </pre>
  );
}

function FileRow({ f, open, onToggle, onLine, marked }: { f: FileChange; open: boolean; onToggle: () => void; onLine?: (r: LineRef) => void; marked?: Set<string> }) {
  const slash = f.path.lastIndexOf("/");
  const dir = slash >= 0 ? f.path.slice(0, slash + 1) : "";
  const name = f.path.slice(slash + 1);
  const st = STATUS[f.status];
  return (
    <div class={`chg-file ${open ? "open" : ""}`}>
      <button class="chg-head" onClick={onToggle} aria-expanded={open}>
        <span class={`chg-st ${f.status}`} title={st.label}>
          {st.letter}
        </span>
        <span class="chg-path">
          {dir && <span class="chg-dir">{dir}</span>}
          <b>{name}</b>
          {f.oldPath && <span class="chg-dir"> ← {f.oldPath}</span>}
        </span>
        <span class="chg-num">
          {f.additions > 0 && <i class="add">+{f.additions}</i>}
          {f.deletions > 0 && <i class="del">−{f.deletions}</i>}
        </span>
        <Icon name={open ? "chevD" : "chevR"} size={14} />
      </button>
      {open && (
        <div class="chg-body">
          {f.binary ? (
            <div class="tool-none">Binary file — not shown.</div>
          ) : f.patch ? (
            <Hunks patch={f.patch} path={f.path} onLine={onLine} marked={marked} />
          ) : (
            <div class="tool-none">{f.truncated ? "Too large to show here." : "No text changes (mode or empty file)."}</div>
          )}
          {f.truncated && f.patch && <div class="tool-none">Cut short — the rest is in the file.</div>}
        </div>
      )}
    </div>
  );
}

export function ChangesView({
  load,
  actions,
  onLine,
  marked,
  onData,
}: {
  load: () => Promise<Changes>;
  actions?: (c: Changes, reload: () => void) => preact.ComponentChildren;
  onLine?: (r: LineRef) => void;
  marked?: Set<string>;
  /** Every fresh copy of the diff (it refreshes while the agent works). */
  onData?: (c: Changes) => void;
}) {
  const [c, setC] = useState<Changes | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const reload = () => {
    setBusy(true);
    load()
      .then((x) => {
        setC(x);
        onData?.(x);
        setErr(null);
        // Small change sets open fully; big ones start collapsed.
        setOpen((prev) => (prev.size || x.files.length > 4 ? prev : new Set(x.files.map((f) => f.path))));
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  useEffect(reload, []);
  // Follow the agent: refresh while the sheet is open.
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && reload(), 15000);
    return () => clearInterval(t);
  }, []);

  if (err) return <div class="chg-empty">{err}</div>;
  if (!c) return <div class="chg-empty">Reading the changes…</div>;
  const all = c.files.length > 0 && c.files.every((f) => open.has(f.path));
  return (
    <div class="chg">
      <div class="chg-summary">
        <div class="chg-line">
          <Icon name="branch" size={14} />
          <b>{c.branch ?? "detached"}</b>
          <span class="muted">vs {c.base.label}</span>
          <button class={`icon-btn sm ${busy ? "spinning" : ""}`} onClick={reload} aria-label="Refresh" title="Refresh">
            <Icon name="refresh" size={15} />
          </button>
        </div>
        <div class="chg-stats">
          <span>
            {c.files.length} file{c.files.length === 1 ? "" : "s"}
          </span>
          <i class="add">+{c.additions}</i>
          <i class="del">−{c.deletions}</i>
          {c.uncommitted > 0 && <span class="chg-pill">{c.uncommitted} not committed</span>}
          {c.commits.length > 0 && (
            <span class="chg-pill ok">
              {c.commits.length} commit{c.commits.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        {c.commits.length > 0 && (
          <div class="chg-commits">
            {c.commits.slice(0, 8).map((k) => (
              <div>
                <code>{k.sha.slice(0, 7)}</code> {k.subject} <span class="muted">{ago(k.at)}</span>
              </div>
            ))}
          </div>
        )}
        {actions?.(c, reload)}
      </div>
      {c.files.length ? (
        <>
          <div class="chg-tools">
            <button class="sec-link" onClick={() => setOpen(all ? new Set() : new Set(c.files.map((f) => f.path)))}>
              {all ? "Collapse all" : "Expand all"}
            </button>
          </div>
          <div class="panel chg-files">
            {c.files.map((f) => (
              <FileRow
                f={f}
                onLine={onLine}
                marked={marked}
                open={open.has(f.path)}
                onToggle={() =>
                  setOpen((prev) => {
                    const next = new Set(prev);
                    next.has(f.path) ? next.delete(f.path) : next.add(f.path);
                    return next;
                  })
                }
              />
            ))}
          </div>
          {c.truncated && <p class="sec-foot">This change is very large, so some files or lines are left out.</p>}
        </>
      ) : (
        <div class="chg-empty">No changes yet{c.worktree ? " on this task's branch" : " since the last commit"}.</div>
      )}
    </div>
  );
}

export function ChangesSheet(p: { taskId?: string; sessionId?: string; onClose: () => void }) {
  const task = useStore((s) => (p.taskId ? s.tasks.find((t) => t.id === p.taskId) : undefined));
  const session = useStore((s) => (p.sessionId ? s.sessions.find((x) => x.id === p.sessionId) : undefined));
  const agentBusy = useStore(
    (s) => !!p.taskId && s.sessions.some((x) => x.task_id === p.taskId && x.status === "running" && (x.agent_state === "working" || x.agent_state === "needs-input")),
  );
  const agentOpen = useStore((s) => !!p.taskId && s.sessions.some((x) => x.task_id === p.taskId && x.status === "running"));
  // Only an agent that finished its turn ("waiting") is closed for you. One with no state yet may be
  // working (a Codex on its first turn, agy), so it has to be closed by hand, as the server insists.
  const agentUnsure = useStore((s) => !!p.taskId && s.sessions.some((x) => x.task_id === p.taskId && x.status === "running" && x.agent_state !== "waiting"));
  const [busy, setBusy] = useState(false);
  const title = task ? `Changes · ${task.title}` : session ? `Changes · ${session.title}` : "Changes";
  // Review comments go to the agent working on this (the task's running Claude/Codex, or this session).
  const agentId = useStore((s) => {
    const a = s.sessions.find((x) => (p.taskId ? x.task_id === p.taskId : x.id === p.sessionId) && x.status === "running" && (x.tool === "claude" || x.tool === "codex"));
    return a?.id ?? null;
  });
  const [diff, setDiff] = useState<Changes | null>(null);
  const review = useReview(agentId, task?.project_id ?? session?.project_id ?? null, diff);
  const load = () => (p.taskId ? api.taskChanges(p.taskId) : api.sessionChanges(p.sessionId!));

  const merge = async (c: Changes) => {
    const n = c.files.length;
    const ok = await confirmDialog({
      title: `Merge into ${c.base.label}?`,
      body: `${n} file${n === 1 ? "" : "s"} land on ${c.base.label} as one commit, “${task!.title}”. Anything the agent didn't commit is included. The worktree and branch are removed afterwards, and the task moves to Done.${agentOpen ? " The agent's session is closed too." : ""}`,
      confirm: "Merge",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.mergeTask(task!.id);
      toast(
        `Merged ${r.files} file${r.files === 1 ? "" : "s"} into ${r.into} (${r.sha.slice(0, 7)})` +
          (r.release ? ". ansai now checks it and updates itself (about 2 minutes); you'll get a notification." : ""),
      );
      openSheet({ kind: "task", taskId: task!.id });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    const ok = await confirmDialog({
      title: "Throw this work away?",
      body: `The worktree folder and branch ${task!.worktree_branch} are deleted, including commits that were never merged. This can't be undone.${agentOpen ? " The agent's session is closed too." : ""}`,
      confirm: "Delete worktree",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.discardWorktree(task!.id);
      toast("Worktree and branch deleted");
      openSheet({ kind: "task", taskId: task!.id });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const actions = (c: Changes) =>
    task?.worktree_path && c.worktree ? (
      <div class="chg-actions">
        <button class="btn primary" disabled={busy || agentUnsure || !c.files.length} onClick={() => merge(c)}>
          <Icon name="check" size={15} stroke={2.4} /> Merge into {c.base.label}
        </button>
        <button class="btn ghost danger-text" disabled={busy || agentUnsure} onClick={discard}>
          Discard
        </button>
        {agentBusy ? (
          <p class="chg-note">The agent is still working. Merge when it's done.</p>
        ) : agentUnsure ? (
          <p class="chg-note">Close the agent's session to merge or discard: both remove its worktree folder.</p>
        ) : agentOpen ? (
          <p class="chg-note">Merging or discarding also closes the agent's session.</p>
        ) : null}
      </div>
    ) : null;

  return (
    <Sheet title={title} full onClose={p.onClose}>
      <ChangesView load={load} actions={actions} onLine={review.onLine} marked={review.marked} onData={setDiff} />
      {review.panel}
    </Sheet>
  );
}

// ------------------------------------------------------------------ review

type Comment = LineRef & { body: string };

/** The message an agent gets for a review: each comment anchored by file, line and the line's text. */
/** Is this comment's line still in the current diff? It goes stale when the agent rewrites that line. */
function stillThere(c: Comment, diff: Changes | null): boolean {
  if (!diff) return true;
  const f = diff.files.find((x) => x.path === c.path);
  if (!f) return false;
  const mark = c.side === "old" ? "-" : null;
  return f.patch.split("\n").some((l) => l.slice(1) === c.text && (mark ? l[0] === mark : l[0] !== "-"));
}

function reviewMessage(comments: Comment[], diff: Changes | null): string {
  return [
    `Review of your changes (${comments.length} comment${comments.length === 1 ? "" : "s"}, from the Changes view):`,
    ...comments.map(
      (c, i) =>
        `${i + 1}. ${c.path}, line ${c.line}${c.side === "old" ? " (a removed line)" : ""}${stillThere(c, diff) ? "" : " (that line has changed since this was written)"}: \`${c.text.trim().slice(0, 160)}\`\n   ${c.body.trim().replace(/\n/g, "\n   ")}`,
    ),
    "Line numbers are from the diff you were reviewed on. If a line moved, find it by its text. Address each comment, then say what you changed.",
  ].join("\n\n");
}

/** Comment on diff lines (tap a line), collect them, and send them to the task's agent as one message. */
export function useReview(agentId: string | null, projectId: string | null, diff: Changes | null = null) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [draft, setDraft] = useState<{ ref: LineRef; body: string } | null>(null);
  const [sending, setSending] = useState(false);
  const marked = new Set(comments.map((c) => `${c.path}:${c.side}:${c.line}`));
  const stale = comments.filter((c) => !stillThere(c, diff)).length;
  const send = async () => {
    if (!agentId || !comments.length) return;
    setSending(true);
    try {
      await api.postMessage({ body: reviewMessage(comments, diff), to: agentId, projectId });
      haptic();
      toast(`Sent ${comments.length} comment${comments.length === 1 ? "" : "s"} to the agent`);
      setComments([]);
    } catch (e) {
      toastError(e);
    } finally {
      setSending(false);
    }
  };
  const panel = (
    <>
      {draft && (
        <div class="rv-compose">
          <div class="rv-anchor">
            <Icon name="pencil" size={13} /> {draft.ref.path}:{draft.ref.line}
            {draft.ref.side === "old" ? " (removed)" : ""}
            <code>{draft.ref.text.trim().slice(0, 80) || " "}</code>
          </div>
          <textarea
            class="input"
            rows={3}
            autoFocus
            placeholder="What should change here?"
            value={draft.body}
            onInput={(e) => setDraft({ ...draft, body: (e.target as HTMLTextAreaElement).value })}
          />
          <div class="rv-actions">
            <button class="btn ghost" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button
              class="btn primary"
              disabled={!draft.body.trim()}
              onClick={() => {
                setComments([...comments, { ...draft.ref, body: draft.body }]);
                setDraft(null);
              }}
            >
              Add comment
            </button>
          </div>
        </div>
      )}
      {comments.length > 0 && !draft && (
        <div class="rv-bar">
          <span>
            {comments.length} comment{comments.length === 1 ? "" : "s"}
            {stale > 0 && (
              <em class="rv-stale" style={{ color: "var(--warn)", fontStyle: "normal", fontWeight: 500 }} title="The agent changed these lines after you commented. They're sent with a note, and your text is kept.">
                {" "}· {stale} line{stale === 1 ? "" : "s"} changed since
              </em>
            )}
          </span>
          <button class="btn ghost sm" onClick={() => setComments([])}>
            Discard
          </button>
          <button class="btn primary sm" disabled={!agentId || sending} onClick={send} title={agentId ? "" : "Start or continue the task's agent to send"}>
            {agentId ? `Send review (${comments.length})` : "No agent running"}
          </button>
        </div>
      )}
    </>
  );
  return { onLine: (ref: LineRef) => setDraft({ ref, body: "" }), marked, panel };
}
