import { useEffect, useState } from "preact/hooks";
import { api, type ModelChoices, type ModelPick, type ToolId } from "./api";
import { toast, toastError, useStore } from "./store";
import { Icon, Sheet, TOOL_LABEL, modelLabel, modelName } from "./ui";

// One fetch per agent + account while the page is open (agy's list takes a few seconds).
const cache = new Map<string, Promise<ModelChoices>>();

function useChoices(tool: ToolId, accountId: string | null): ModelChoices | null {
  const [c, setC] = useState<ModelChoices | null>(null);
  useEffect(() => {
    setC(null);
    if (tool === "shell") return;
    const key = `${tool}:${accountId ?? ""}`;
    let p = cache.get(key);
    if (!p) {
      p = api.models(tool, accountId);
      cache.set(key, p);
      p.catch(() => cache.delete(key));
    }
    let live = true;
    p.then((x) => live && setC(x)).catch(() => {});
    return () => {
      live = false;
    };
  }, [tool, accountId]);
  return c;
}

const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" };
const effortName = (e: string) => EFFORT_LABEL[e] ?? e;

function labelFor(c: ModelChoices | null, id: string) {
  return c?.models.find((m) => m.id === id)?.label ?? modelName(id);
}

/** Levels the chosen model takes: its own list (Codex), else the agent's general one. */
function effortsFor(c: ModelChoices | null, model: string | null) {
  const id = model ?? c?.default.model ?? null;
  return (id && c?.models.find((m) => m.id === id)?.efforts) || c?.efforts || [];
}

/**
 * Model + effort for a new agent. "Default" leaves the flag off, so the agent
 * uses its own setting; the label says what that is when its config tells us.
 */
export function ModelPicker(p: {
  tool: ToolId;
  accountId: string | null;
  value: ModelPick;
  onChange: (v: ModelPick) => void;
  /** Label for "don't change" (a running agent), instead of "Default · …". */
  keepLabel?: { model: string; effort: string };
}) {
  const c = useChoices(p.tool, p.accountId);
  if (p.tool === "shell") return null;
  const efforts = effortsFor(c, p.value.model);
  const models = c?.models ?? [];
  // Keep a saved pick visible even if the agent stopped listing it.
  const extra = p.value.model && !models.some((m) => m.id === p.value.model) ? [{ id: p.value.model, label: labelFor(c, p.value.model) }] : [];

  const defModel = p.keepLabel?.model ?? (c?.default.model ? `Default · ${labelFor(c, c.default.model)}` : "Default");
  const defEffort = p.keepLabel?.effort ?? (c?.default.effort ? `Default · ${effortName(c.default.effort)}` : "Default");

  const setModel = (model: string | null) => {
    // A level the new model doesn't take would make the agent refuse to start.
    const ok = !p.value.effort || effortsFor(c, model).includes(p.value.effort);
    p.onChange({ model, effort: ok ? p.value.effort : null });
  };

  return (
    <div class="model-pick">
      <label class="field">
        <span>Model</span>
        <select class="select" value={p.value.model ?? ""} disabled={!c} onChange={(e) => setModel((e.target as HTMLSelectElement).value || null)}>
          <option value="">{c ? defModel : "Loading…"}</option>
          {[...models, ...extra].map((m) => (
            <option value={m.id}>{m.label}</option>
          ))}
        </select>
      </label>
      <label class="field">
        <span>Effort</span>
        <select
          class="select"
          value={p.value.effort ?? ""}
          disabled={!c || efforts.length === 0}
          onChange={(e) => p.onChange({ ...p.value, effort: (e.target as HTMLSelectElement).value || null })}
        >
          <option value="">{defEffort}</option>
          {efforts.map((e) => (
            <option value={e}>{effortName(e)}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** Switch a running agent's model or effort (tap the model in the session header). */
export function ModelSheet(p: { sessionId: string; showTerminal?: () => void; onClose: () => void }) {
  const s = useStore((st) => st.sessions.find((x) => x.id === p.sessionId));
  const [pick, setPick] = useState<ModelPick>({ model: null, effort: null });
  const [busy, setBusy] = useState(false);
  if (!s) return null;
  const running = s.status === "running";
  const current = modelLabel(s);
  const codex = s.tool === "codex";

  const apply = async () => {
    setBusy(true);
    try {
      await api.switchModel(s.id, codex ? {} : { model: pick.model ?? undefined, effort: pick.effort ?? undefined });
      if (codex) {
        p.showTerminal?.();
        toast("Pick a model in Codex's menu");
      } else {
        const what = [pick.model && labelFor(null, pick.model), pick.effort && effortName(pick.effort)].filter(Boolean).join(" · ");
        toast(s.agent_state === "working" ? `Switching to ${what} once this turn ends` : `Switched to ${what}`);
      }
      p.onClose();
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };

  return (
    <Sheet title="Model" onClose={p.onClose} size="sm">
      <div class="form">
        <p class="muted small">
          {current ? (
            <>
              Running on <b>{current}</b>.
            </>
          ) : (
            "The model shows here once the agent reports it."
          )}{" "}
          {codex
            ? "Codex changes model from its own menu, in the terminal."
            : "Only this session changes; the conversation carries on."}
        </p>
        {!running ? (
          <p class="muted small">This session isn't running. Restart it to switch.</p>
        ) : codex ? (
          <button class="btn primary lg" disabled={busy} onClick={apply}>
            <Icon name="terminal" size={16} /> Open Codex's model menu
          </button>
        ) : (
          <>
            <ModelPicker tool={s.tool} accountId={s.account_id} value={pick} onChange={setPick} keepLabel={{ model: "Keep current", effort: "Keep current" }} />
            <button class="btn primary lg" disabled={busy || (!pick.model && !pick.effort)} onClick={apply}>
              {busy ? "Switching…" : `Switch ${TOOL_LABEL[s.tool]}`}
            </button>
          </>
        )}
      </div>
    </Sheet>
  );
}
