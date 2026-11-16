import { useEffect, useRef, useState } from "preact/hooks";
import { api, type Message, type Session } from "./api";
import { loadTeam, toastError, useStore } from "./store";
import { Empty, haptic, Icon, Link, TOOL_SHORT, ToolBadge, ago, sessionState } from "./ui";

/** Direct messages: has the agent been given it yet (between steps, typed in, or on its next turn)? */
function Delivery({ m }: { m: Message }) {
  if (!m.to_session) return null;
  return m.delivered_at ? (
    <span class="team-dlv ok" title={`Delivered ${ago(m.delivered_at)} ago`}>
      <Icon name="check" size={11} stroke={2.8} /> Delivered
    </span>
  ) : (
    <span class="team-dlv" title="The agent gets it between steps, or when it's next idle">
      Waiting
    </span>
  );
}

/** Who sent it, as a short name: the agent's tool + session title, or "You". */
function Sender({ m, sessions }: { m: Message; sessions: Session[] }) {
  const s = m.from_session ? sessions.find((x) => x.id === m.from_session) : null;
  if (!m.from_session) return <b>You</b>;
  return s ? (
    <Link href={`/s/${s.id}`} class="team-who">
      {TOOL_SHORT[s.tool]} · {s.title}
    </Link>
  ) : (
    <b>{m.from_label}</b>
  );
}

function Recipient({ m, sessions, me }: { m: Message; sessions: Session[]; me?: string }) {
  if (!m.to_session) return <span>everyone</span>;
  if (m.to_session === me) return <span>this agent</span>;
  const s = sessions.find((x) => x.id === m.to_session);
  return s ? (
    <Link href={`/s/${s.id}`} class="team-who">
      {TOOL_SHORT[s.tool]} · {s.title}
    </Link>
  ) : (
    <span>{m.to_label}</span>
  );
}

function senderTool(m: Message, sessions: Session[]) {
  return m.from_session ? sessions.find((x) => x.id === m.from_session)?.tool ?? "claude" : null;
}

/** A team message inside one agent's chat: what other agents (or you) told it, and what it told them. */
export function TeamBubble({ m, me }: { m: Message; me: string }) {
  const sessions = useStore((s) => s.sessions);
  const outgoing = m.from_session === me;
  const tool = senderTool(m, sessions);
  return (
    <div class={`team-msg ${outgoing ? "out" : "in"}`}>
      <div class="team-meta">
        {tool ? <ToolBadge tool={tool} size={16} /> : <Icon name="chat" size={13} />}
        <span>
          {outgoing ? (
            <>
              Sent to <Recipient m={m} sessions={sessions} me={me} />
            </>
          ) : (
            <>
              <Sender m={m} sessions={sessions} /> → <Recipient m={m} sessions={sessions} me={me} />
            </>
          )}
        </span>
        <Delivery m={m} />
        <time>{ago(m.created_at)}</time>
      </div>
      <div class="team-body">{m.body}</div>
    </div>
  );
}

/** Messages that belong in this session's chat: to it, from it, or to everyone in its project. */
export function useSessionMessages(s: Session): Message[] {
  return useStore((st) =>
    st.messages.filter((m) => m.from_session === s.id || m.to_session === s.id || (!m.to_session && m.project_id && m.project_id === s.project_id && m.created_at >= s.created_at)),
  );
}

/**
 * Who's on what: each running agent here, the files it edited or claimed, and files two of them touch.
 * Polled while open, into the store, so this project's task cards show the same overlaps.
 */
function WhoBoard({ projectId }: { projectId: string }) {
  const sessions = useStore((s) => s.sessions);
  const b = useStore((s) => s.teams[projectId] ?? null);
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  useEffect(() => {
    loadTeam(projectId);
    const t = setInterval(() => document.visibilityState === "visible" && loadTeam(projectId), 5000);
    return () => clearInterval(t);
  }, [projectId]);
  if (!b?.agents.length) return null;
  const hot = new Set(b.overlaps.map((o) => o.path));
  const name = (id: string) => {
    const s = sessions.find((x) => x.id === id);
    return s ? `${TOOL_SHORT[s.tool]} · ${s.title.slice(0, 28)}` : id;
  };
  return (
    <div class="who">
      {b.overlaps.length > 0 && (
        <div class="who-warn">
          <Icon name="bell" size={14} />
          <span>
            {b.overlaps.slice(0, 3).map((o) => (
              <span class="who-clash">
                <code>{o.path}</code> — {o.agents.map(name).join(" & ")}
              </span>
            ))}
            {b.overlaps.length > 3 && <span class="muted"> and {b.overlaps.length - 3} more files</span>}
          </span>
        </div>
      )}
      {b.agents.map((a) => {
        const s = sessions.find((x) => x.id === a.id);
        const files = [...new Set([...a.claims, ...a.files])];
        const all = showAll.has(a.id);
        return (
          <div class="who-row">
            <ToolBadge tool={a.tool} size={26} />
            <div class="who-main">
              <div class="who-head">
                <Link href={`/s/${a.id}`} class="who-title">
                  {a.title}
                </Link>
                {s && <span class={`who-state ${sessionState(s).cls}`}>{sessionState(s).label}</span>}
              </div>
              {(a.task || a.branch) && (
                <div class="who-sub">
                  {a.task && <span>{a.task}</span>}
                  {a.branch && (
                    <span class="mono">
                      <Icon name="branch" size={11} /> {a.branch}
                    </span>
                  )}
                </div>
              )}
              {files.length > 0 ? (
                <div class="who-files">
                  {(all ? files : files.slice(0, 6)).map((f) => (
                    <code class={`${hot.has(f) ? "hot" : ""} ${a.claims.includes(f) ? "claimed" : ""}`} title={a.claims.includes(f) ? "Claimed" : "Edited"}>
                      {a.claims.includes(f) && <Icon name="lock" size={10} />}
                      {f.split("/").pop()}
                    </code>
                  ))}
                  {files.length > 6 && !all && (
                    <button class="who-more" onClick={() => setShowAll(new Set([...showAll, a.id]))}>
                      +{files.length - 6}
                    </button>
                  )}
                </div>
              ) : (
                <div class="who-sub muted">No files edited yet</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The project's team room: every agent-to-agent message, and a box to talk to them. */
export function TeamPanel({ projectId }: { projectId: string }) {
  const all = useStore((s) => s.messages);
  const sessions = useStore((s) => s.sessions);
  const msgs = all.filter((m) => m.project_id === projectId).slice(-60);
  const agents = sessions.filter((s) => s.project_id === projectId && s.status === "running" && (s.tool === "claude" || s.tool === "codex"));
  const tasks = useStore((s) => s.tasks);
  // null = not chosen yet: default to one agent, so a stray message doesn't wake everyone.
  const [picked, setPicked] = useState<string | null>(null);
  const to = picked ?? agents[0]?.id ?? "";
  const setTo = (v: string) => setPicked(v);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const feed = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (picked && !agents.some((a) => a.id === picked)) setPicked(null);
  }, [agents.map((a) => a.id).join()]);

  // Same rules as the server (team.ts): finished agents aren't woken; busy ones read between steps.
  const finished = (a: Session) => {
    const t = a.task_id ? tasks.find((x) => x.id === a.task_id) : null;
    return !!t && (t.status === "done" || (t.status === "review" && !!t.summary));
  };
  const idle = (a: Session) => ["turn", "idle"].includes(sessionState(a).cls);
  const note = (() => {
    if (!agents.length) return "";
    if (!to) {
      const wake = agents.filter((a) => idle(a) && !finished(a)).length;
      const busy = agents.filter((a) => !idle(a)).length;
      return [wake ? `Wakes ${wake} idle agent${wake === 1 ? "" : "s"}` : "", busy ? `${busy} busy one${busy === 1 ? "" : "s"} read it between steps` : ""]
        .filter(Boolean)
        .join("; ")
        .concat(wake || busy ? "." : "Every agent here is finished; they read it on their next turn.");
    }
    const a = agents.find((x) => x.id === to);
    if (!a) return "";
    if (sessionState(a).cls === "attn") return "It's waiting for your approval; it reads this after.";
    if (!idle(a)) return "It's working, so it reads this between steps.";
    return "It's idle, so this is typed in now and starts a turn.";
  })();
  useEffect(() => {
    const el = feed.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length]);

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await api.postMessage({ body, to: to || null, projectId });
      haptic();
      setText("");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="sec">
      <div class="sec-head">
        <h2 class="sec-title">Team</h2>
        {agents.length > 0 && (
          <span class="sec-count">
            {agents.length} agent{agents.length === 1 ? "" : "s"} running
          </span>
        )}
      </div>
      <div class="panel team-panel">
        <WhoBoard projectId={projectId} />
        {msgs.length ? (
          <div class="team-feed" ref={feed}>
            {msgs.map((m) => (
              <div class="team-row">
                <span class="team-av">{m.from_session ? <ToolBadge tool={senderTool(m, sessions)!} size={26} /> : <span class="you-av">You</span>}</span>
                <div class="team-row-main">
                  <div class="team-meta">
                    <Sender m={m} sessions={sessions} />
                    <span class="muted">→</span>
                    <Recipient m={m} sessions={sessions} />
                    <Delivery m={m} />
                    <time>{ago(m.created_at)}</time>
                  </div>
                  <div class="team-body">{m.body}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty icon="chat" title="No team messages yet">
            Agents here can see each other, message one another, and hear from you. Their conversation shows up here.
          </Empty>
        )}
        <form
          class="team-compose"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <select class="team-to" value={to} onChange={(e) => setTo((e.target as HTMLSelectElement).value)} aria-label="Send to">
            <option value="">Everyone{agents.length ? ` (${agents.length})` : ""}</option>
            {agents.map((a) => (
              <option value={a.id}>
                {TOOL_SHORT[a.tool]} · {a.title.slice(0, 40)} · {sessionState(a).label}
              </option>
            ))}
          </select>
          <div class="compose">
            <textarea
              rows={1}
              placeholder={agents.length ? (to ? "Message this agent" : "Message every agent here") : "No agents running here yet"}
              value={text}
              disabled={!agents.length}
              onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button type="submit" class={`send ${text.trim() ? "ready" : ""}`} disabled={busy || !agents.length} aria-label="Send">
              <Icon name="send" size={18} stroke={2.4} />
            </button>
          </div>
          {note && <p class="team-hint">{note}</p>}
        </form>
      </div>
    </section>
  );
}
