import { useEffect, useState } from "preact/hooks";
import { api, type Changes, type FileChange } from "./api";
import { confirmDialog, openSheet, toast, toastError, useStore } from "./store";
import { Icon, Sheet, ago } from "./ui";

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

function Hunks({ patch }: { patch: string }) {
  return (
    <pre class="diff">
      {patch.split("\n").map((l) => {
        if (l.startsWith("@@")) {
          const where = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)?.[1];
          const ctx = l.replace(/^@@[^@]*@@ ?/, "");
          return <div class="d-hunk">{where ? `Line ${where}${ctx ? " · " + ctx : ""}` : l}</div>;
        }
        if (l.startsWith("\\")) return null; // "\ No newline at end of file"
        const t = l[0];
        return (
          <div class={t === "+" ? "d-add" : t === "-" ? "d-del" : "d-ctx"}>
            <span>{t === "+" || t === "-" ? t : " "}</span>
            {l.slice(1) || " "}
          </div>
        );
      })}
    </pre>
  );
}

function FileRow({ f, open, onToggle }: { f: FileChange; open: boolean; onToggle: () => void }) {
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
            <Hunks patch={f.patch} />
          ) : (
            <div class="tool-none">{f.truncated ? "Too large to show here." : "No text changes (mode or empty file)."}</div>
          )}
          {f.truncated && f.patch && <div class="tool-none">Cut short — the rest is in the file.</div>}
        </div>
      )}
    </div>
  );
}

export function ChangesView({ load, actions }: { load: () => Promise<Changes>; actions?: (c: Changes, reload: () => void) => preact.ComponentChildren }) {
  const [c, setC] = useState<Changes | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const reload = () => {
    setBusy(true);
    load()
      .then((x) => {
        setC(x);
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
          <ul class="chg-commits">
            {c.commits.slice(0, 8).map((k) => (
              <li>
                <code>{k.sha.slice(0, 7)}</code> {k.subject} <span class="muted">{ago(k.at)}</span>
              </li>
            ))}
          </ul>
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
  const agentBusy = useStore((s) => !!p.taskId && s.sessions.some((x) => x.task_id === p.taskId && x.status === "running" && x.agent_state === "working"));
  const agentOpen = useStore((s) => !!p.taskId && s.sessions.some((x) => x.task_id === p.taskId && x.status === "running"));
  const [busy, setBusy] = useState(false);
  const title = task ? `Changes · ${task.title}` : session ? `Changes · ${session.title}` : "Changes";
  const load = () => (p.taskId ? api.taskChanges(p.taskId) : api.sessionChanges(p.sessionId!));

  const merge = async (c: Changes) => {
    const n = c.files.length;
    const ok = await confirmDialog({
      title: `Merge into ${c.base.label}?`,
      body: `${n} file${n === 1 ? "" : "s"} land on ${c.base.label} as one commit, “${task!.title}”. Anything the agent didn't commit is included. The worktree and branch are removed afterwards, and the task moves to Done.`,
      confirm: "Merge",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.mergeTask(task!.id);
      toast(`Merged ${r.files} file${r.files === 1 ? "" : "s"} into ${r.into} (${r.sha.slice(0, 7)})`);
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
      body: `The worktree folder and branch ${task!.worktree_branch} are deleted, including commits that were never merged. This can't be undone.`,
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
        <button class="btn primary" disabled={busy || agentBusy || !c.files.length} onClick={() => merge(c)}>
          <Icon name="check" size={15} stroke={2.4} /> Merge into {c.base.label}
        </button>
        <button class="btn ghost danger-text" disabled={busy || agentOpen} onClick={discard}>
          Discard
        </button>
        {agentBusy ? (
          <p class="chg-note">The agent is still working. Merge when it's done.</p>
        ) : agentOpen ? (
          <p class="chg-note">Close the agent's session before discarding its worktree.</p>
        ) : null}
      </div>
    ) : null;

  return (
    <Sheet title={title} full onClose={p.onClose}>
      <ChangesView load={load} actions={actions} />
    </Sheet>
  );
}
