import { useEffect, useState } from "preact/hooks";
import { toast, toastError } from "./store";

/**
 * A project's playbook: standing instructions every agent here gets when it starts
 * (as system-level instructions, see withHooks), e.g. "run bun test before finishing".
 */
export function PlaybookCard({ projectId }: { projectId: string }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch(`/api/projects/${projectId}/playbook`)
      .then((r) => (r.ok ? r.json() : { text: "" }))
      .then((d: { text: string }) => {
        setSaved(d.text);
        setText(d.text);
      })
      .catch(() => setSaved(""));
  }, [projectId]);
  const save = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/playbook`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      setSaved(d.text);
      toast("Playbook saved: agents started or restarted from now on get it");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  if (saved === null) return null;
  return (
    <section class="sec">
      <h2 class="sec-title">Playbook</h2>
      <div class="panel autopilot">
        <button class="switch-row playbook-toggle" onClick={() => setOpen(!open)}>
          <span>
            <b>{saved ? `Playbook · ${saved.split("\n").filter(Boolean).length} lines` : "Playbook · Not set"}</b>
            <em>{saved ? "Instructions every agent here follows" : "Tap to add instructions for every agent"}</em>
          </span>
        </button>
        {open && (
          <div class="ap-body playbook-body">
            <textarea
              class="input playbook-input"
              rows={6}
              placeholder={"- Run `bun run test` and `bun run typecheck` before finishing\n- Commit with clear messages on your branch"}
              value={text}
              onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            />
            <button class="btn sm primary" disabled={busy || text.trim() === saved} onClick={save}>
              {busy ? "Saving…" : "Save playbook"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

export function ChecksCard({ projectId }: { projectId: string }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [cmd, setCmd] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch(`/api/projects/${projectId}/checks`)
      .then((r) => (r.ok ? r.json() : { cmd: "" }))
      .then((d: { cmd: string }) => {
        setSaved(d.cmd);
        setCmd(d.cmd);
      })
      .catch(() => setSaved(""));
  }, [projectId]);
  const save = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/checks`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      setSaved(d.cmd);
      toast(d.cmd ? "Checks saved: they run when an agent says a task is done" : "Checks off");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  if (saved === null) return null;
  return (
    <section class="sec">
      <h2 class="sec-title">Checks</h2>
      <div class="panel autopilot">
        <button class="switch-row playbook-toggle" onClick={() => setOpen(!open)}>
          <span>
            <b>{saved ? "Checks · On" : "Checks · Not set"}</b>
            <em>{saved ? <code>{saved}</code> : "A command that must pass before a task goes to Review"}</em>
          </span>
        </button>
        {open && (
          <div class="ap-body playbook-body">
            <input
              class="input checks-input"
              placeholder="bun run typecheck && bun test"
              value={cmd}
              onInput={(e) => setCmd((e.target as HTMLInputElement).value)}
            />
            <p class="muted small">Runs in the task's worktree when its agent calls finish_task. If it fails, the task stays in Doing and the agent gets the output to fix.</p>
            <button class="btn sm primary" disabled={busy || cmd.trim() === saved} onClick={save}>
              {busy ? "Saving…" : "Save checks"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
