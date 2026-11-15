import { useEffect, useRef, useState } from "preact/hooks";
import { api, type Session } from "../api";
import { openSheet, toast, toastError, useStore } from "../store";
import { TerminalView, type TermHandle, type TermStatus } from "../Terminal";
import { Icon, Link, TOOL_LABEL, ToolDot, goBack, isTouch, nav, sessionState, useTick } from "../ui";

const KEYS: { label: string; seq?: string; act?: "ctrl" | "kbd" | "up" | "down"; title?: string }[] = [
  { label: "esc", seq: "\x1b" },
  { label: "tab", seq: "\t" },
  { label: "⇧tab", seq: "\x1b[Z", title: "Shift+Tab (Claude: cycle mode)" },
  { label: "ctrl", act: "ctrl" },
  { label: "^C", seq: "\x03" },
  { label: "↑", seq: "\x1b[A" },
  { label: "↓", seq: "\x1b[B" },
  { label: "←", seq: "\x1b[D" },
  { label: "→", seq: "\x1b[C" },
  { label: "⏎", seq: "\r" },
  { label: "1", seq: "1" },
  { label: "2", seq: "2" },
  { label: "3", seq: "3" },
  { label: "/", seq: "/" },
  { label: "⇞", act: "up", title: "Scroll up" },
  { label: "⇟", act: "down", title: "Scroll down" },
  { label: "⌨", act: "kbd", title: "Type directly in the terminal" },
];

export function SessionPane({ id }: { id: string }) {
  useTick();
  const sessions = useStore((s) => s.sessions);
  const tasks = useStore((s) => s.tasks);
  const accounts = useStore((s) => s.accounts);
  const [fetched, setFetched] = useState<Session | null>(null);
  const [missing, setMissing] = useState(false);
  const s = sessions.find((x) => x.id === id) ?? fetched;
  const handle = useRef<TermHandle | null>(null);
  const [tstatus, setTstatus] = useState<TermStatus>("connecting");
  const [ctrl, setCtrl] = useState(false);
  const [kbd, setKbd] = useState(false);
  const [compose, setCompose] = useState("");
  const [showTools, setShowTools] = useState(isTouch());
  const [menu, setMenu] = useState(false);
  const touch = isTouch();

  useEffect(() => {
    setMissing(false);
    if (!sessions.find((x) => x.id === id))
      api
        .session(id)
        .then(setFetched)
        .catch(() => setMissing(true));
  }, [id]);

  if (missing) {
    return (
      <div class="pane center">
        <p class="muted">This session is gone.</p>
        <button class="btn" onClick={() => nav("/")}>
          Back
        </button>
      </div>
    );
  }
  if (!s) return <div class="pane center muted">Loading…</div>;

  const st = sessionState(s);
  const closed = s.status === "closed";
  const task = s.task_id ? tasks.find((t) => t.id === s.task_id) : null;
  const account = s.account_id ? accounts.find((a) => a.id === s.account_id) : null;

  const key = (k: (typeof KEYS)[number]) => {
    const h = handle.current;
    if (!h) return;
    if (k.seq) h.send(k.seq);
    else if (k.act === "ctrl") {
      const on = !ctrl;
      setCtrl(on);
      h.armCtrl(on);
      if (on && !kbd && touch) toast("Ctrl armed — type a letter in the terminal (⌨) or tap a key");
    } else if (k.act === "kbd") {
      const on = !kbd;
      setKbd(on);
      h.setKeyboard(on);
    } else if (k.act === "up" || k.act === "down") {
      h.send(k.act === "up" ? "\x1b[<64;2;2M".repeat(8) : "\x1b[<65;2;2M".repeat(8));
    }
  };

  const sendCompose = async () => {
    const text = compose;
    setCompose("");
    try {
      await api.send(id, text, true);
    } catch (e) {
      setCompose(text);
      toastError(e);
    }
  };

  const act = async (what: "restart" | "close" | "rename") => {
    setMenu(false);
    try {
      if (what === "restart") await api.restartSession(id);
      if (what === "close") {
        if (!confirm(`Close "${s.title}"? This stops the agent.`)) return;
        await api.closeSession(id);
        nav("/", true);
      }
      if (what === "rename") {
        const t = prompt("Session name", s.title);
        if (t) await api.renameSession(id, t);
      }
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div class="pane session">
      <header class="topbar">
        <button class="icon-btn mobile-only" onClick={() => goBack()} aria-label="Back">
          <Icon name="back" />
        </button>
        <ToolDot tool={s.tool} />
        <div class="topbar-title">
          <h1 onClick={() => act("rename")}>{s.title}</h1>
          <div class="sub">
            {s.project_id ? <Link href={`/p/${s.project_id}`}>{s.project_name}</Link> : "~"}
            {account && !account.is_default && <> · {account.name}</>}
            {" · "}
            <span class={`st ${st.cls}`}>{st.label}</span>
            {tstatus !== "live" && !closed && <span class="st warn"> · {tstatus}</span>}
          </div>
        </div>
        {task && (
          <button class="btn small ghost task-chip" onClick={() => openSheet({ kind: "task", taskId: task.id })} title="Open the task">
            <Icon name="list" size={14} /> Task
          </button>
        )}
        <button class="icon-btn" onClick={() => openSheet({ kind: "history", sessionId: id })} title="History (scrollback as text)" aria-label="History">
          <Icon name="history" />
        </button>
        {!touch && (
          <button class={`icon-btn ${showTools ? "pinned" : ""}`} onClick={() => setShowTools(!showTools)} title="Compose box & keys" aria-label="Toggle compose">
            <Icon name="type" />
          </button>
        )}
        <div class="menu-wrap">
          <button class="icon-btn" onClick={() => setMenu(!menu)} aria-label="More">
            <Icon name="more" />
          </button>
          {menu && (
            <div class="menu" onMouseLeave={() => setMenu(false)}>
              <button onClick={() => (handle.current?.bumpFont(1), setMenu(false))}>Bigger text</button>
              <button onClick={() => (handle.current?.bumpFont(-1), setMenu(false))}>Smaller text</button>
              <button onClick={() => act("rename")}>Rename</button>
              <button onClick={() => act("restart")}>Restart agent</button>
              <button class="danger" onClick={() => act("close")}>
                Close session
              </button>
            </div>
          )}
        </div>
      </header>

      {s.status === "running" && s.agent_state === "needs-input" && (
        <div class="banner attn">
          <span>
            <b>Needs you:</b> {s.agent_message || "the agent is waiting for an answer"}
          </span>
          {[
            ["1", "Yes"],
            ["2", "Always"],
            ["3", "No"],
          ].map(([k, label]) => (
            <button class="btn small" onClick={() => handle.current?.send(k!)} title={`Press ${k}`}>
              {k} · {label}
            </button>
          ))}
        </div>
      )}

      {s.status === "exited" && (
        <div class="banner">
          <span>
            {TOOL_LABEL[s.tool]} exited{s.exit_code ? ` with code ${s.exit_code}` : ""}.
          </span>
          <button class="btn small" onClick={() => act("restart")}>
            Restart
          </button>
          <button class="btn small ghost" onClick={() => act("close")}>
            Close
          </button>
        </div>
      )}

      {closed ? (
        <div class="pane center muted">Session closed.</div>
      ) : (
        <TerminalView sessionId={id} handle={handle} onStatus={setTstatus} onCtrlUsed={() => setCtrl(false)} />
      )}

      {showTools && !closed && (
        <div class="dock">
          <div class="keys" role="toolbar" aria-label="Terminal keys">
            {KEYS.map((k) => (
              <button
                class={`key ${(k.act === "ctrl" && ctrl) || (k.act === "kbd" && kbd) ? "on" : ""}`}
                title={k.title ?? k.label}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => key(k)}
              >
                {k.label}
              </button>
            ))}
          </div>
          <div class="compose">
            <textarea
              rows={1}
              placeholder={s.tool === "shell" ? "Command…" : "Message the agent…"}
              value={compose}
              onInput={(e) => {
                const t = e.target as HTMLTextAreaElement;
                setCompose(t.value);
                t.style.height = "auto";
                t.style.height = Math.min(t.scrollHeight, 140) + "px";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !touch) {
                  e.preventDefault();
                  sendCompose();
                }
              }}
            />
            <button class="btn primary send" onClick={sendCompose} aria-label="Send">
              <Icon name="send" size={17} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
