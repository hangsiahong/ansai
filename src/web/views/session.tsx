import { useEffect, useRef, useState } from "preact/hooks";
import { api, type Session } from "../api";
import { confirmDialog, openSheet, promptDialog, toast, toastError, useStore } from "../store";
import { TerminalView, type TermHandle, type TermStatus } from "../Terminal";
import { compact, haptic, Icon, Link, StatusPill, TOOL_LABEL, ToolBadge, goBack, isTouch, modelLabel, nav, until, useTick } from "../ui";
import { ChatView } from "../chat";
import { ShiftBar, canShift } from "../shift";
import { addFiles, carriesFiles, readClipboard, transferFiles } from "../paste";

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
  const [attachMenu, setAttachMenu] = useState(false);
  const [dropping, setDropping] = useState(false);
  const pane = useRef<HTMLDivElement>(null);
  const onPaste = useRef<(e: ClipboardEvent) => void>(() => {});
  const onFiles = useRef<(files: File[]) => void>(() => {});
  const [ctx, setCtx] = useState<number | null>(null);
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

  // A paste counts wherever the focus is on this screen: the message box, the terminal, or nothing.
  useEffect(() => {
    const fn = (e: ClipboardEvent) => onPaste.current(e);
    document.addEventListener("paste", fn, true);
    return () => document.removeEventListener("paste", fn, true);
  }, []);
  onPaste.current = onFiles.current = () => {};

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
      haptic();
      if (files.length) setAttachments([]);
    } catch (e) {
      setCompose(text);
      toastError(e);
    } finally {
      setUploading(false);
    }
  };

  // The message box is on screen and this agent reads attached files.
  const composing = canChat && !closed && (showDock || view === "chat");

  const attach = (picked: File[]) => {
    if (!picked.length) return;
    const r = addFiles(attachments, picked);
    if (r.note) toast(r.note, "error");
    setAttachments(r.files);
  };

  /** Files that were pasted or dropped: onto the message when its box is showing, else into the terminal. */
  const takeFiles = async (picked: File[]) => {
    if (composing) return attach(picked);
    // A terminal on its own: save the files and type where they are, as dropping a file on a terminal does.
    const h = handle.current;
    if (!h || uploading) return;
    const r = addFiles([], picked);
    if (r.note) toast(r.note, "error");
    if (!r.files.length) return;
    setUploading(true);
    try {
      const uploaded = await api.uploadAttachments(id, r.files);
      h.paste(uploaded.files.map((f) => f.path).join(" ") + " ");
      h.focus();
      toast(uploaded.files.length === 1 ? "Saved — its path is typed in the terminal" : `Saved — ${uploaded.files.length} paths are typed in the terminal`);
    } catch (e) {
      toastError(e);
    } finally {
      setUploading(false);
    }
  };

  onFiles.current = takeFiles;

  onPaste.current = (e) => {
    if (closed) return;
    const el = e.target instanceof Element ? e.target : null;
    // Not while a sheet, a dialog or the search is open over this screen.
    if (document.querySelector(".scrim")) return;
    if (el && el !== document.body && el !== document.documentElement && !pane.current?.contains(el)) return;
    if (el?.closest(".term")) return; // the terminal sorts out its own pastes (Ctrl+V is also its key)
    const files = transferFiles(e.clipboardData, "paste");
    if (!files.length) return; // text: the box or the terminal pastes it as before
    e.preventDefault();
    e.stopPropagation();
    takeFiles(files);
  };

  const pasteFromClipboard = async () => {
    setAttachMenu(false);
    try {
      const got = await readClipboard(navigator.clipboard);
      if (got.files.length) attach(got.files);
      else if (got.text) {
        const t = ta.current;
        const at = t ? [t.selectionStart, t.selectionEnd] : [compose.length, compose.length];
        setCompose(compose.slice(0, at[0]) + got.text + compose.slice(at[1]));
        t?.focus();
        if (t) requestAnimationFrame(() => grow(t));
      } else toast("Nothing to paste: the clipboard has no picture or text");
    } catch {
      toast("The browser did not let ansai read the clipboard. Allow it for this page, or use Photos and files.", "error");
    }
  };
  const canReadClipboard = typeof navigator !== "undefined" && typeof navigator.clipboard?.read === "function";

  const openModel = () => openSheet({ kind: "model", sessionId: id, showTerminal: () => chooseView("terminal") });

  const act = async (what: "restart" | "close" | "rename") => {
    setMenu(false);
    try {
      if (what === "restart") {
        const r = await api.restartSession(id);
        toast(r.argv.includes("resume") || r.argv.includes("--resume") ? "Restarted, picking the conversation back up" : "Restarted with a fresh conversation");
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
    <div
      class={`pane session ${dropping ? "dropping" : ""}`}
      ref={pane}
      onDragOver={(e) => {
        if (closed || !carriesFiles(e.dataTransfer)) return;
        e.preventDefault();
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setDropping(false);
      }}
      onDrop={(e) => {
        setDropping(false);
        if (closed || !carriesFiles(e.dataTransfer)) return;
        e.preventDefault();
        takeFiles(transferFiles(e.dataTransfer, "drop"));
      }}
    >
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
            {ctx !== null && ctx > 0 && (
              <span class={ctx >= 150_000 ? "danger-text" : ctx >= 100_000 ? "warn-text" : ""} title="How much the agent re-reads on every reply">
                {" · "}
                {compact(ctx)} context
              </span>
            )}
            {s.tokens && (
              <span title={`${s.tokens.fresh.toLocaleString()} fresh tokens (input, cache writes, output) and ${s.tokens.cached.toLocaleString()} cache reads so far`}>
                {" · "}
                {compact(s.tokens.fresh)} tok
              </span>
            )}
            {s.deadline && (
              <span class={s.deadline - Date.now() < 5 * 60_000 ? "warn-text" : ""} title="Autopilot stops this run at the project's time limit">
                {" · "}
                {until(s.deadline)} left
              </span>
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
        <ChatView s={s} onCtx={setCtx} />
      ) : (
        <div class="term-wrap">
          <TerminalView sessionId={id} handle={handle} onStatus={setTstatus} onCtrlUsed={() => setCtrl(false)} onFiles={(files) => onFiles.current(files)} />
        </div>
      )}

      {(showDock || view === "chat") && !closed && (
        <div class="dock">
          {view === "chat" ? (
            <div class="chips-row">
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
                attach(Array.from((e.target as HTMLInputElement).files ?? []));
                (e.target as HTMLInputElement).value = "";
              }}
            />
            {canChat && (
              <div class="menu-wrap">
                <button
                  class="attach-btn"
                  onClick={() => (canReadClipboard ? setAttachMenu(!attachMenu) : fileInput.current?.click())}
                  aria-label="Attach files or photos"
                  aria-expanded={canReadClipboard ? attachMenu : undefined}
                  title="Attach files or photos (you can also paste or drop them here)"
                  disabled={uploading}
                >
                  <Icon name="plus" size={19} />
                </button>
                {attachMenu && (
                  <>
                    <div class="menu-scrim" onClick={() => setAttachMenu(false)} />
                    <div class="menu up">
                      <button onClick={() => (setAttachMenu(false), fileInput.current?.click())}>Photos and files</button>
                      <button onClick={pasteFromClipboard}>Paste from clipboard</button>
                    </div>
                  </>
                )}
              </div>
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
                grow(t);
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
                  <Thumb file={f} />
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

/** The message box grows with what is typed, up to a few lines. */
function grow(t: HTMLTextAreaElement) {
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 160) + "px";
}

/** A small look at an attached picture, so a pasted screenshot is more than a file name. */
function Thumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith("image/")) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url ? <img src={url} alt="" /> : null;
}
