import { useEffect, useRef, useState } from "preact/hooks";
import { api, type Session } from "../api";
import { confirmDialog, openSheet, promptDialog, toast, toastError, useStore } from "../store";
import { TerminalView, type TermHandle, type TermStatus } from "../Terminal";
import { Icon, Link, StatusPill, TOOL_LABEL, ToolBadge, goBack, isTouch, modelLabel, nav, sessionState, useTick } from "../ui";
import { ChatView } from "../chat";
import { ShiftBar, canShift } from "../shift";

type View = "chat" | "terminal";
const VIEW_KEY = "ansai.view";
function savedView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === "chat" || v === "terminal") return v;
  } catch {}
  return isTouch() ? "chat" : "terminal"; // phones default to chat
}

type Key = { label: string; seq?: string; act?: "ctrl" | "kbd" | "up" | "down" | "more"; title?: string; wide?: boolean };

const MAIN: Key[] = [
  { label: "esc", seq: "\x1b" },
  { label: "tab", seq: "\t" },
  { label: "⇧tab", seq: "\x1b[Z", title: "Shift+Tab (Claude: cycle mode)" },
  { label: "^C", seq: "\x03", title: "Interrupt" },
  { label: "↑", seq: "\x1b[A" },
  { label: "↓", seq: "\x1b[B" },
  { label: "⏎", seq: "\r", title: "Enter" },
  { label: "•••", act: "more", title: "More keys" },
];
const MORE: Key[] = [
  { label: "ctrl", act: "ctrl", title: "Ctrl + next key" },
  { label: "←", seq: "\x1b[D" },
  { label: "→", seq: "\x1b[C" },
  { label: "1", seq: "1" },
  { label: "2", seq: "2" },
  { label: "3", seq: "3" },
  { label: "/", seq: "/" },
  { label: "⇞", act: "up", title: "Scroll back" },
  { label: "⇟", act: "down", title: "Scroll forward" },
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
  const [more, setMore] = useState(false);
  const [compose, setCompose] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [showDock, setShowDock] = useState(isTouch());
  const [menu, setMenu] = useState(false);
  const touch = isTouch();
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [viewPref, setViewPref] = useState<View>(savedView);
  const chooseView = (v: View) => {
    setViewPref(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
  };

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
          Back to Now
        </button>
      </div>
    );
  }
  if (!s) return <div class="pane center muted">Loading…</div>;

  const closed = s.status === "closed";
  const canChat = s.tool === "claude" || s.tool === "codex";
  const view: View = canChat ? viewPref : "terminal";
  const working = sessionState(s).cls === "working";
  const task = s.task_id ? tasks.find((t) => t.id === s.task_id) : null;
  const account = s.account_id ? accounts.find((a) => a.id === s.account_id) : null;

  const key = (k: Key) => {
    const h = handle.current;
    if (k.act === "more") return setMore(!more);
    if (!h) return;
    if (k.seq) h.send(k.seq);
    else if (k.act === "ctrl") {
      const on = !ctrl;
      setCtrl(on);
      h.armCtrl(on);
      if (on && !kbd && touch) toast("Ctrl is armed — tap ⌨ and type a letter");
    } else if (k.act === "kbd") {
      const on = !kbd;
      setKbd(on);
      h.setKeyboard(on);
    } else if (k.act === "up" || k.act === "down") {
      h.send(k.act === "up" ? "\x1b[<64;2;2M".repeat(8) : "\x1b[<65;2;2M".repeat(8));
    }
  };

  const sendCompose = async () => {
    if (uploading) return; // Enter while files upload would send them twice
    const text = compose;
    const files = attachments;
    setCompose("");
    if (ta.current) ta.current.style.height = "";
    try {
      // With nothing typed this still presses Enter in the terminal (the "Press Enter" button).
      let message = text;
      if (files.length) {
        setUploading(true);
        const uploaded = await api.uploadAttachments(id, files);
        const refs = uploaded.files.map((f) => `- ${f.name}: ${f.path}`).join("\n");
        message = [text.trim(), `Attached files (read these files):\n${refs}`].filter(Boolean).join("\n\n");
      }
      await api.send(id, message, true);
      if (files.length) setAttachments([]);
    } catch (e) {
      setCompose(text);
      toastError(e);
    } finally {
      setUploading(false);
    }
  };

  const openModel = () => openSheet({ kind: "model", sessionId: id, showTerminal: () => chooseView("terminal") });

  const act = async (what: "restart" | "close" | "rename") => {
    setMenu(false);
    try {
      if (what === "restart") {
        await api.restartSession(id);
        toast("Restarted");
      }
      if (what === "close") {
        const ok = await confirmDialog({ title: `Close "${s.title}"?`, body: "The agent is stopped. Its history in this session is lost.", confirm: "Close session", danger: true });
        if (!ok) return;
        await api.closeSession(id);
        nav("/", true);
      }
      if (what === "rename") {
        const t = await promptDialog({ title: "Rename session", value: s.title });
        if (t) await api.renameSession(id, t);
      }
    } catch (e) {
      toastError(e);
    }
  };

  const keyBtn = (k: Key) => (
    <button
      class={`key ${(k.act === "ctrl" && ctrl) || (k.act === "kbd" && kbd) || (k.act === "more" && more) ? "on" : ""}`}
      title={k.title ?? k.label}
      aria-label={k.title ?? k.label}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => key(k)}
    >
      {k.label}
    </button>
  );

  return (
    <div class="pane session">
      <header class="topbar session-bar">
        <button class="icon-btn" onClick={() => goBack()} aria-label="Back">
          <Icon name="back" />
        </button>
        <ToolBadge tool={s.tool} size={26} />
        <div class="topbar-title">
          <h1>{s.title}</h1>
          <div class="sub">
            {s.project_id ? <Link href={`/p/${s.project_id}`}>{s.project_name}</Link> : "~"}
            {account && !account.is_default && <> · {account.name}</>}
            {s.model && (
              <>
                {" · "}
                <button
                  class="model"
                  onClick={openModel}
                  disabled={s.tool === "shell"}
                  title={`Model ${s.model}${s.effort ? ` · effort ${s.effort}` : " · effort shows after the first reply"} — tap to change`}
                >
                  {modelLabel(s)}
                </button>
              </>
            )}
            {view === "terminal" && tstatus !== "live" && !closed && <span class="warn-text"> · {tstatus}</span>}
          </div>
        </div>
        <StatusPill s={s} />
        {canChat && (
          <div class="viewtoggle" role="radiogroup" aria-label="View">
            <button role="radio" aria-checked={view === "chat"} class={view === "chat" ? "on" : ""} onClick={() => chooseView("chat")} title="Chat">
              <Icon name="chat" size={16} />
            </button>
            <button role="radio" aria-checked={view === "terminal"} class={view === "terminal" ? "on" : ""} onClick={() => chooseView("terminal")} title="Terminal">
              <Icon name="terminal" size={16} />
            </button>
          </div>
        )}
        {task && (
          <button class="icon-btn" onClick={() => openSheet({ kind: "task", taskId: task.id })} title={`Task: ${task.title}`} aria-label="Open task">
            <Icon name="list" />
          </button>
        )}
        <button class="icon-btn hide-phone" onClick={() => openSheet({ kind: "history", sessionId: id })} title="History as text" aria-label="History">
          <Icon name="history" />
        </button>
        {!touch && view === "terminal" && (
          <button class={`icon-btn ${showDock ? "on" : ""}`} onClick={() => setShowDock(!showDock)} title="Compose box and keys" aria-label="Compose box">
            <Icon name="keyboard" />
          </button>
        )}
        <div class="menu-wrap">
          <button class="icon-btn" onClick={() => setMenu(!menu)} aria-label="More" aria-expanded={menu}>
            <Icon name="more" />
          </button>
          {menu && (
            <>
              <div class="menu-scrim" onClick={() => setMenu(false)} />
              <div class="menu">
                <button onClick={() => (setMenu(false), openSheet({ kind: "history", sessionId: id }))}>History as text</button>
                <button onClick={() => (setMenu(false), openSheet(task ? { kind: "changes", taskId: task.id } : { kind: "changes", sessionId: id }))}>Code changes</button>
                {(canShift(s) || s.shift) && (
                  <button onClick={() => (setMenu(false), openSheet({ kind: "shift", sessionId: id }))}>{s.shift?.active ? "Shift…" : "Keep working until…"}</button>
                )}
                <button onClick={() => act("rename")}>Rename</button>
                {s.tool !== "shell" && s.status === "running" && <button onClick={() => (setMenu(false), openModel())}>Change model</button>}
                <button onClick={() => act("restart")}>Restart {TOOL_LABEL[s.tool]}</button>
                <div class="menu-row">
                  <span>Text size</span>
                  <button class="icon-btn sm" onClick={() => handle.current?.bumpFont(-1)} aria-label="Smaller text">
                    −
                  </button>
                  <button class="icon-btn sm" onClick={() => handle.current?.bumpFont(1)} aria-label="Bigger text">
                    +
                  </button>
                </div>
                <hr />
                <button class="danger" onClick={() => act("close")}>
                  Close session
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      <ShiftBar s={s} />

      {view === "terminal" && s.status === "running" && s.agent_state === "needs-input" && (
        <div class="banner attn">
          <Icon name="bell" size={16} />
          <span class="banner-text">{s.agent_message || "The agent is waiting for an answer"}</span>
          <div class="banner-actions">
            {(s.startup?.message
              ? ([
                  ...(s.startup.accept ? [[s.startup.acceptKeys, s.startup.accept]] : []),
                  ...(s.startup.decline ? [[s.startup.declineKeys, s.startup.decline]] : []),
                ] as [string[], string][])
              : ([
                  [["Enter"], "Allow"],
                  [["Down", "Enter"], "Always"],
                  [["Escape"], "Deny"],
                ] as [string[], string][])
            ).map(([keys, label]) => (
              <button class="btn sm" onClick={() => api.keys(id, keys).catch(toastError)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {s.status === "exited" && (
        <div class="banner">
          <span class="banner-text">
            {TOOL_LABEL[s.tool]} exited{s.exit_code ? ` with code ${s.exit_code}` : ""}.
          </span>
          <div class="banner-actions">
            <button class="btn sm primary" onClick={() => act("restart")}>
              Restart
            </button>
            <button class="btn sm" onClick={() => act("close")}>
              Close
            </button>
          </div>
        </div>
      )}

      {closed ? (
        <div class="pane center muted">Session closed.</div>
      ) : view === "chat" ? (
        <ChatView s={s} />
      ) : (
        <div class="term-wrap">
          <TerminalView sessionId={id} handle={handle} onStatus={setTstatus} onCtrlUsed={() => setCtrl(false)} />
        </div>
      )}

      {(showDock || view === "chat") && !closed && (
        <div class="dock">
          {view === "chat" ? (
            <div class="chips-row">
              {working && (
                <button class="chip-btn danger" onClick={() => api.keys(id, ["Escape"]).catch(toastError)}>
                  <Icon name="stop" size={12} /> Stop
                </button>
              )}
              {s.tool === "claude" && (
                <button class="chip-btn" onClick={() => api.keys(id, ["BTab"]).catch(toastError)} title="Shift+Tab: cycle Claude's mode (normal → accept edits → plan)">
                  Mode ⇧⇥
                </button>
              )}
              <button class="chip-btn" onClick={() => api.keys(id, ["Escape"]).catch(toastError)}>
                Esc
              </button>
              <button class="chip-btn" onClick={() => chooseView("terminal")}>
                <Icon name="terminal" size={12} /> Terminal
              </button>
            </div>
          ) : (
            <div class="keys" role="toolbar" aria-label="Terminal keys">
              {MAIN.map(keyBtn)}
            </div>
          )}
          {view === "terminal" && more && (
            <div class="keys more" role="toolbar" aria-label="More keys">
              {MORE.map(keyBtn)}
            </div>
          )}
          <div class="compose">
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const picked = Array.from((e.target as HTMLInputElement).files ?? []);
                setAttachments((old) => [...old, ...picked].slice(0, 5));
                (e.target as HTMLInputElement).value = "";
              }}
            />
            {canChat && (
              <button class="attach-btn" onClick={() => fileInput.current?.click()} aria-label="Attach files or photos" title="Attach files or photos" disabled={uploading}>
                <Icon name="plus" size={19} />
              </button>
            )}
            <textarea
              ref={ta}
              rows={1}
              placeholder={s.tool === "shell" ? "Run a command" : `Message ${TOOL_LABEL[s.tool]}`}
              value={compose}
              enterkeyhint="send"
              onInput={(e) => {
                const t = e.target as HTMLTextAreaElement;
                setCompose(t.value);
                t.style.height = "auto";
                t.style.height = Math.min(t.scrollHeight, 160) + "px";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !touch) {
                  e.preventDefault();
                  sendCompose();
                }
              }}
            />
            <button class={`send ${compose.trim() || attachments.length ? "ready" : ""}`} onClick={sendCompose} aria-label={uploading ? "Attaching" : compose.trim() || attachments.length ? "Send" : "Press Enter"} title={uploading ? "Attaching files…" : compose.trim() || attachments.length ? "Send" : "Press Enter"} disabled={uploading}>
              <Icon name="send" size={18} stroke={2.4} />
            </button>
          </div>
          {attachments.length > 0 && (
            <div class="attachment-list" aria-label="Attachments">
              {attachments.map((f, i) => (
                <span class="attachment-chip" key={`${f.name}-${i}`}>
                  <span>{f.name}</span>
                  <button onClick={() => setAttachments((old) => old.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}><Icon name="x" size={13} /></button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
