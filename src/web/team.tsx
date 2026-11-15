import { useEffect, useRef, useState } from "preact/hooks";
import { api, type Message, type Session } from "./api";
import { toastError, useStore } from "./store";
import { Empty, Icon, Link, TOOL_SHORT, ToolBadge, ago, sessionState } from "./ui";

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

/** The project's team room: every agent-to-agent message, and a box to talk to them. */
export function TeamPanel({ projectId }: { projectId: string }) {
  const all = useStore((s) => s.messages);
  const sessions = useStore((s) => s.sessions);
  const msgs = all.filter((m) => m.project_id === projectId).slice(-60);
  const agents = sessions.filter((s) => s.project_id === projectId && s.status === "running" && (s.tool === "claude" || s.tool === "codex"));
  const [to, setTo] = useState<string>("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const feed = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (to && !agents.some((a) => a.id === to)) setTo("");
  }, [agents.map((a) => a.id).join()]);
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
          <p class="team-hint">Idle agents get it typed in right away; busy ones read it between steps.</p>
        </form>
      </div>
    </section>
  );
}
