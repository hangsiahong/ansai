import { useState } from "preact/hooks";
import { api, type Session, type Shift } from "./api";
import { openSheet, toast, toastError, useStore } from "./store";
import { Icon, Sheet, ago, until as timeLeft } from "./ui";

/**
 * Shifts: "keep working until 7 AM". An agent on shift gets its next prompt
 * from ansai whenever it would otherwise stop and wait for you.
 */

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const END_LABEL: Record<NonNullable<Shift["end_reason"]>, string> = {
  time: "Time was up",
  agent: "The agent said it was done",
  idle: "The agent ran out of work",
  you: "You ended it",
  exited: "The agent stopped running",
  cap: "It hit the hourly nudge limit",
};

/** Agents ansai can keep going (it needs to know when a turn ends). */
export const canShift = (s: Session) => s.status === "running" && (s.tool === "claude" || s.tool === "codex");

/** The next time the clock shows h:00 (today, or tomorrow if that's passed or too close). */
function nextAt(hour: number): number {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() < Date.now() + 15 * 60_000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

type Preset = { label: string; at: () => number };
const PRESETS: Preset[] = [
  { label: "1 hour", at: () => Date.now() + 3600_000 },
  { label: "2 hours", at: () => Date.now() + 2 * 3600_000 },
  { label: "4 hours", at: () => Date.now() + 4 * 3600_000 },
  { label: "7 AM", at: () => nextAt(7) },
  { label: "9 AM", at: () => nextAt(9) },
];

function timeInputValue(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function fromTimeInput(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= Date.now() + 60_000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

const duration = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
};

/** Pill for headers and list cells: "until 3:25". */
export function ShiftTag({ shift }: { shift: Shift | null }) {
  if (!shift?.active) return null;
  return (
    <span class="shift-tag" title={`On shift until ${clock(shift.until)}`}>
      <Icon name="moon" size={11} stroke={2.4} />
      {clock(shift.until)}
    </span>
  );
}

/** What the shift did: shown in the sheet and on the session once it ends. */
function Report({ shift }: { shift: Shift }) {
  const end = shift.ended_at ?? Date.now();
  const commits = shift.report?.commits ?? [];
  const more = shift.report?.moreCommits ?? 0;
  return (
    <div class="shift-report">
      <div class="shift-stats">
        <div>
          <b>{duration(end - shift.started_at)}</b>
          <span>on shift</span>
        </div>
        <div>
          <b>{shift.nudges}</b>
          <span>{shift.nudges === 1 ? "nudge" : "nudges"}</span>
        </div>
        <div>
          <b>{shift.report ? commits.length + more : "…"}</b>
          <span>{commits.length + more === 1 ? "commit" : "commits"}</span>
        </div>
      </div>
      {shift.end_reason && <p class="shift-why">{END_LABEL[shift.end_reason]} at {clock(end)}.</p>}
      {shift.summary && (
        <div class="summary-card">
          <div class="summary-head">
            <Icon name="check" size={14} stroke={2.6} /> The agent's summary
          </div>
          <p>{shift.summary}</p>
        </div>
      )}
      {commits.length > 0 && (
        <div class="panel shift-commits">
          {commits.map((c) => (
            <div class="shift-commit">
              <code>{c.sha}</code>
              <span>{c.subject}</span>
            </div>
          ))}
          {more > 0 && <div class="shift-commit muted">and {more} more</div>}
        </div>
      )}
    </div>
  );
}

/** Start, extend or end a shift, for one session or for every agent in a project. */
export function ShiftSheet(p: { sessionId?: string; projectId?: string; onClose: () => void }) {
  const sessions = useStore((s) => s.sessions);
  const s = p.sessionId ? sessions.find((x) => x.id === p.sessionId) : null;
  const team = p.projectId ? sessions.filter((x) => x.project_id === p.projectId && canShift(x)) : [];
  const onShift = p.projectId ? team.filter((x) => x.shift?.active) : [];
  const cur = s?.shift?.active ? s.shift : null;
  const [at, setAt] = useState<number>(cur?.until ?? nextAt(7));
  const [preset, setPreset] = useState<string | null>(cur ? null : "7 AM");
  const [focus, setFocus] = useState(cur?.focus ?? "");
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      const body = { until: at, focus: focus.trim() || null };
      if (p.sessionId) {
        await api.startShift(p.sessionId, body);
        toast(cur ? `Shift now ends at ${clock(at)}` : `On shift until ${clock(at)}`);
      } else if (p.projectId) {
        // An empty focus leaves each agent's own focus as it is (it isn't cleared for everyone).
        const r = await api.startProjectShift(p.projectId, focus.trim() ? body : { until: at });
        toast(`${r.started} agent${r.started === 1 ? "" : "s"} on shift until ${clock(at)}`);
      }
      p.onClose();
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };
  const end = async () => {
    setBusy(true);
    try {
      if (p.sessionId) await api.endShift(p.sessionId);
      else if (p.projectId) await api.endProjectShift(p.projectId);
      toast("Shift ended");
      if (p.projectId) p.onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const ended = s?.shift && !s.shift.active ? s.shift : null;
  const blocked = p.sessionId ? !s || !canShift(s) : team.length === 0;
  return (
    <Sheet title={cur || onShift.length ? "On shift" : "Keep working"} onClose={p.onClose} size="sm">
      <div class="form shift-form">
        <p class="hint">
          {p.projectId
            ? `Every Claude and Codex agent running here keeps going until the time you pick. When one would stop and wait for you, ansai hands it the next prompt instead.`
            : `When the agent would stop and wait for you, ansai hands it the next prompt instead, until the time you pick. It stops early once there's nothing useful left.`}
        </p>

        {cur && (
          <div class="shift-now">
            <Icon name="moon" size={16} />
            <span>
              Until <b>{clock(cur.until)}</b> · {timeLeft(cur.until)} left · {cur.nudges} {cur.nudges === 1 ? "nudge" : "nudges"}
              {cur.last_nudge_at ? `, last ${ago(cur.last_nudge_at)} ago` : ""}
            </span>
          </div>
        )}
        {p.projectId && onShift.length > 0 && (
          <div class="shift-now">
            <Icon name="moon" size={16} />
            <span>
              {onShift.length} of {team.length} agents on shift, until {clock(Math.max(...onShift.map((x) => x.shift!.until)))}
            </span>
          </div>
        )}

        {blocked ? (
          <p class="hint">
            {p.projectId ? "No Claude or Codex agents are running here. Start one first." : "Shifts work with running Claude Code and Codex sessions."}
          </p>
        ) : (
          <>
            <div class="field">
              <span>{cur || onShift.length ? "Keep going until" : "Until"}</span>
              <div class="shift-presets" role="radiogroup" aria-label="Until">
                {PRESETS.map((pr) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={preset === pr.label}
                    class={`chip-btn ${preset === pr.label ? "on" : ""}`}
                    onClick={() => {
                      setPreset(pr.label);
                      setAt(pr.at());
                    }}
                  >
                    {pr.label}
                  </button>
                ))}
                <input
                  type="time"
                  class={`input shift-time ${preset === null ? "on" : ""}`}
                  aria-label="Pick a time"
                  value={timeInputValue(at)}
                  onInput={(e) => {
                    const v = fromTimeInput((e.target as HTMLInputElement).value);
                    if (v) {
                      setAt(v);
                      setPreset(null);
                    }
                  }}
                />
              </div>
              <em class="shift-when">
                Ends {new Date(at).toDateString() === new Date().toDateString() ? "today" : "tomorrow"} at {clock(at)}, in {timeLeft(at)}
              </em>
            </div>
            <label class="field">
              <span>Focus (optional)</span>
              <textarea
                class="input"
                rows={2}
                placeholder={s ? `Default: ${s.title}` : onShift.length ? "Empty keeps each agent's own focus" : "Default: whatever each agent is working on"}
                value={focus}
                onInput={(e) => setFocus((e.target as HTMLTextAreaElement).value)}
              />
            </label>
            <button class="btn primary lg" disabled={busy} onClick={start}>
              <Icon name="moon" size={16} /> {cur ? "Update shift" : p.projectId && onShift.length ? `Put all ${team.length} on shift` : "Start shift"}
            </button>
          </>
        )}
        {(cur || onShift.length > 0) && (
          <button class="btn lg danger-text" disabled={busy} onClick={end}>
            End {p.projectId ? "all shifts" : "shift"} now
          </button>
        )}
        {ended && (
          <>
            <h3 class="sec-title">Last shift</h3>
            <Report shift={ended} />
          </>
        )}
      </div>
    </Sheet>
  );
}

/** A slim bar under the session header while on shift, and a report card after one ends. */
export function ShiftBar({ s }: { s: Session }) {
  const sh = s.shift;
  if (!sh) return null;
  const open = () => openSheet({ kind: "shift", sessionId: s.id });
  if (sh.active)
    return (
      <button class="shift-bar" onClick={open}>
        <Icon name="moon" size={14} stroke={2.2} />
        <span>
          On shift until <b>{clock(sh.until)}</b>
          <em>
            {" "}
            · {timeLeft(sh.until)} left{sh.nudges ? ` · ${sh.nudges} ${sh.nudges === 1 ? "nudge" : "nudges"}` : ""}
          </em>
        </span>
        <Icon name="chevR" size={14} stroke={2.2} />
      </button>
    );
  // Show the report for a few hours after a shift ends; it stays in the sheet after that.
  if (!sh.ended_at || Date.now() - sh.ended_at > 12 * 3600_000) return null;
  const n = (sh.report?.commits.length ?? 0) + (sh.report?.moreCommits ?? 0);
  return (
    <button class="shift-bar done" onClick={open}>
      <Icon name="check" size={14} stroke={2.4} />
      <span>
        Shift over at <b>{clock(sh.ended_at)}</b>
        <em>
          {" "}
          · {duration(sh.ended_at - sh.started_at)}
          {sh.report ? ` · ${n} ${n === 1 ? "commit" : "commits"}` : ""}
        </em>
      </span>
      <Icon name="chevR" size={14} stroke={2.2} />
    </button>
  );
}
