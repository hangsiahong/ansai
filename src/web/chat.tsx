import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, wsUrl, type ChatItem, type Message, type Session } from "./api";
import { toastError } from "./store";
import { haptic, Icon, TOOL_LABEL, TOOL_SHORT, ToolBadge, compact, sessionState, useTick } from "./ui";
import { Markdown } from "./md";
import { elapsed } from "./elapsed";
import { TeamBubble, useSessionMessages } from "./team";

type ToolItem = Extract<ChatItem, { k: "tool" }>;

// ------------------------------------------------------------------ helpers

/** Line diff (LCS) for Edit previews; falls back to before/after for huge edits. */
function lineDiff(a: string, b: string): { t: " " | "-" | "+"; s: string }[] {
  const A = a.split("\n");
  const B = b.split("\n");
  if (A.length * B.length > 160_000) return [...A.map((s) => ({ t: "-" as const, s })), ...B.map((s) => ({ t: "+" as const, s }))];
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: { t: " " | "-" | "+"; s: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) (out.push({ t: " ", s: A[i]! }), i++, j++);
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ t: "-", s: A[i++]! });
    else out.push({ t: "+", s: B[j++]! });
  }
  while (i < n) out.push({ t: "-", s: A[i++]! });
  while (j < m) out.push({ t: "+", s: B[j++]! });
  return out;
}

function Diff({ a, b }: { a: string; b: string }) {
  const rows = lineDiff(a, b);
  // keep 2 lines of context around changes
  const keep = new Set<number>();
  rows.forEach((r, i) => {
    if (r.t !== " ") for (let k = i - 2; k <= i + 2; k++) keep.add(k);
  });
  let skipped = false;
  return (
    <pre class="diff">
      {rows.map((r, i) => {
        if (r.t === " " && !keep.has(i)) {
          if (skipped) return null;
          skipped = true;
          return <div class="d-skip">⋯</div>;
        }
        skipped = false;
        return (
          <div class={r.t === "-" ? "d-del" : r.t === "+" ? "d-add" : "d-ctx"}>
            <span>{r.t}</span>
            {r.s || " "}
          </div>
        );
      })}
    </pre>
  );
}

function Patch({ text }: { text: string }) {
  return (
    <pre class="diff">
      {text.split("\n").map((l) => (
        <div class={l.startsWith("+") && !l.startsWith("+++") ? "d-add" : l.startsWith("-") && !l.startsWith("---") ? "d-del" : l.startsWith("***") || l.startsWith("@@") ? "d-hunk" : "d-ctx"}>{l || " "}</div>
      ))}
    </pre>
  );
}

function toolIcon(t: ToolItem): string {
  const n = t.name;
  if (n === "Bash" || n === "exec" || n === "shell" || n === "exec_command" || n === "local_shell") return "terminal";
  if (n === "Read") return "file";
  if (n === "Edit" || n === "MultiEdit" || n === "Write" || n === "apply_patch" || t.title.startsWith("Edit ")) return "pencil";
  if (n === "Grep" || n === "Glob" || n === "WebSearch" || n === "ToolSearch") return "search";
  if (n === "WebFetch") return "globe";
  if (n === "TodoWrite") return "list";
  if (n === "Task" || n === "Agent") return "sparkle";
  if (n === "AskUserQuestion") return "question";
  if (n.startsWith("mcp__")) return "plug";
  return "terminal";
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

function Todos({ todos }: { todos: { content: string; status: string }[] }) {
  return (
    <ul class="todos">
      {todos.map((t) => (
        <li class={t.status}>
          <span class="todo-box">{t.status === "completed" ? <Icon name="check" size={12} stroke={3} /> : t.status === "in_progress" ? <i /> : null}</span>
          {t.content}
        </li>
      ))}
    </ul>
  );
}

function ToolDetail({ t }: { t: ToolItem }) {
  const inp = (t.input ?? {}) as Record<string, any>;
  const result = t.result ? <pre class={`tool-out ${t.error ? "err" : ""}`}>{t.result}</pre> : null;
  if (inp.old_string !== undefined || inp.new_string !== undefined)
    return (
      <>
        <div class="tool-path">{str(inp.file_path)}</div>
        <Diff a={str(inp.old_string)} b={str(inp.new_string)} />
        {t.error && result}
      </>
    );
  if (Array.isArray(inp.edits))
    return (
      <>
        <div class="tool-path">{str(inp.file_path)}</div>
        {inp.edits.map((e: any) => (
          <Diff a={str(e.old_string)} b={str(e.new_string)} />
        ))}
        {t.error && result}
      </>
    );
  if (inp.content !== undefined)
    return (
      <>
        <div class="tool-path">{str(inp.file_path)}</div>
        <pre class="tool-out">{str(inp.content)}</pre>
      </>
    );
  if (inp.patch) return <Patch text={str(inp.patch)} />;
  if (inp.command)
    return (
      <>
        <pre class="tool-cmd">
          <span>$ </span>
          {str(inp.command)}
        </pre>
        {result ?? (t.done ? <div class="tool-none">No output</div> : null)}
      </>
    );
  return (
    <>
      {inp.file_path && <div class="tool-path">{str(inp.file_path)}</div>}
      {inp.code && <pre class="tool-cmd">{str(inp.code)}</pre>}
      {inp.json && <pre class="tool-cmd">{str(inp.json)}</pre>}
      {result}
    </>
  );
}

function ToolRow({ t, live }: { t: ToolItem; live: boolean }) {
  const [open, setOpen] = useState(false);
  const inp = (t.input ?? {}) as Record<string, any>;
  if (t.name === "TodoWrite" && Array.isArray(inp.todos)) {
    return (
      <div class="tool plan">
        <div class="tool-head static">
          <span class="tool-icon">
            <Icon name="list" size={14} />
          </span>
          <span class="tool-title">Plan</span>
        </div>
        <Todos todos={inp.todos} />
      </div>
    );
  }
  const state = t.done ? (t.error ? "err" : "ok") : live ? "run" : "idle";
  return (
    <div class={`tool ${open ? "open" : ""}`}>
      <button class="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class={`tool-icon ${state}`}>
          <Icon name={toolIcon(t)} size={14} />
        </span>
        <span class="tool-title">{t.title}</span>
        <span class={`tool-state ${state}`}>{state === "run" ? <i class="spin" /> : state === "err" ? <Icon name="x" size={13} stroke={2.6} /> : null}</span>
        <Icon name={open ? "chevD" : "chevR"} size={14} />
      </button>
      {open && (
        <div class="tool-body">
          <ToolDetail t={t} />
        </div>
      )}
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  const long = text.split("\n").length > 14 || text.length > 1200;
  return (
    <div class="msg user">
      <div class={`bubble ${long && !full ? "clamped" : ""}`}>{text}</div>
      {long && (
        <button class="more-link" onClick={() => setFull(!full)}>
          {full ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div class={`thinking ${open ? "open" : ""}`}>
      <button onClick={() => setOpen(!open)}>
        <Icon name="bulb" size={14} /> Thinking <Icon name={open ? "chevD" : "chevR"} size={13} />
      </button>
      {open && <div class="thinking-text">{text}</div>}
    </div>
  );
}

// -------------------------------------------------------------- live cards

const press = (id: string, keys: string[]) => api.keys(id, keys).catch(toastError);

function ApprovalCard({ s }: { s: Session }) {
  return (
    <div class="live-card attn">
      <div class="lc-head">
        <Icon name="bell" size={16} /> Needs your approval
      </div>
      <div class="lc-body">{s.agent_message || `${TOOL_LABEL[s.tool]} is waiting for an answer.`}</div>
      <div class="lc-actions">
        <button class="btn primary" onClick={() => (haptic(), press(s.id, ["Enter"]))}>
          Allow
        </button>
        <button class="btn" onClick={() => (haptic(), press(s.id, ["Down", "Enter"]))}>
          Always allow
        </button>
        <button class="btn ghost" onClick={() => (haptic(), press(s.id, ["Escape"]))}>
          Deny
        </button>
      </div>
      <p class="lc-hint">Deny lets you tell the agent what to do instead.</p>
    </div>
  );
}

/** Claude's pre-start dialogs (trust this folder, bypass warning): their menus open on "No, exit", so plain Enter would quit. */
function StartupCard({ s }: { s: Session }) {
  const p = s.startup!;
  return (
    <div class="live-card attn">
      <div class="lc-head">
        <Icon name="lock" size={16} /> Before {TOOL_SHORT[s.tool]} starts
      </div>
      <div class="lc-body strong">{p.message}</div>
      <div class="lc-hint mono-path">{s.cwd}</div>
      {p.accept ? (
        <div class="lc-actions two">
          <button class="btn primary" onClick={() => (haptic(), press(s.id, p.acceptKeys))}>
            {p.accept}
          </button>
          {p.decline && (
            <button class="btn ghost" onClick={() => (haptic(), press(s.id, p.declineKeys))}>
              {p.decline}
            </button>
          )}
        </div>
      ) : (
        <p class="lc-hint">Switch to Terminal to answer it.</p>
      )}
    </div>
  );
}

function QuestionCard({ s, t }: { s: Session; t: ToolItem }) {
  const q = ((t.input?.questions as any[]) ?? [])[0];
  if (!q) return null;
  return (
    <div class="live-card">
      <div class="lc-head">
        <Icon name="question" size={16} /> {TOOL_SHORT[s.tool]} is asking
      </div>
      <div class="lc-body strong">{q.question}</div>
      <div class="lc-options">
        {(q.options as { label: string; description: string }[]).map((o, i) => (
          <button class="lc-option" onClick={() => press(s.id, [...Array(i).fill("Down"), "Enter"])}>
            <b>{o.label}</b>
            {o.description && <span>{o.description}</span>}
          </button>
        ))}
      </div>
      <p class="lc-hint">Or type your own answer below.</p>
    </div>
  );
}

function WorkingRow({ s }: { s: Session }) {
  // Counted from when it set to work: the start of the turn, or your answer to its last question.
  const since = s.agent_state === "working" ? s.agent_state_at : null;
  useTick(1000);
  const ms = since ? Date.now() - since : 0;
  return (
    <div class="working-row">
      <span class="working-badge">
        <ToolBadge tool={s.tool} size={24} />
      </span>
      <span class="working-text">
        <span>{s.agent_message ? `${TOOL_SHORT[s.tool]} · ${s.agent_message}` : `${TOOL_SHORT[s.tool]} is working`}</span>
        <span class="dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </span>
      {ms >= 1000 && (
        <span class="working-time" role="timer" title="Working for this long">
          {elapsed(ms)}
        </span>
      )}
      <button class="btn sm stop-btn" onClick={() => press(s.id, ["Escape"])} title="Stop what it is doing (Esc)">
        <i class="stop-glyph" /> Stop
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- the view

type Steps = { k: "steps"; id: string; tools: ToolItem[] };
const SOLO = new Set(["TodoWrite", "AskUserQuestion"]); // plans and questions always stand alone

/**
 * Runs of 3+ tool calls between messages fold into one "N steps" row, so a
 * busy agent's chat reads as conversation rather than a wall of commands.
 * The step running right now stays outside the fold, with its spinner.
 */
function groupSteps(list: (ChatItem | Message)[], liveId?: string): (ChatItem | Message | Steps)[] {
  const out: (ChatItem | Message | Steps)[] = [];
  let run: ToolItem[] = [];
  const flush = () => {
    const tail = run.length && run[run.length - 1]!.id === liveId ? run.pop()! : null;
    if (run.length >= 3) out.push({ k: "steps", id: `steps:${run[0]!.id}`, tools: run });
    else out.push(...run);
    if (tail) out.push(tail);
    run = [];
  };
  for (const it of list) {
    if (!("body" in it) && it.k === "tool" && !SOLO.has(it.name)) run.push(it);
    else {
      flush();
      out.push(it);
    }
  }
  flush();
  return out;
}

const KIND: Record<string, [string, string]> = {
  pencil: ["edit", "edits"],
  terminal: ["command", "commands"],
  file: ["read", "reads"],
  search: ["search", "searches"],
  globe: ["fetch", "fetches"],
  sparkle: ["sub-agent", "sub-agents"],
  plug: ["tool call", "tool calls"],
};

function StepGroup({ tools }: { tools: ToolItem[] }) {
  const [open, setOpen] = useState(false);
  const counts = new Map<string, number>();
  for (const t of tools) {
    const k = toolIcon(t);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${(KIND[k] ?? ["step", "steps"])[n === 1 ? 0 : 1]}`);
  const failed = tools.filter((t) => t.error).length;
  return (
    <div class={`steps ${open ? "open" : ""}`}>
      <button class="steps-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="steps-icons" aria-hidden="true">
          {[...counts.keys()].slice(0, 4).map((k) => (
            <Icon name={k} size={13} />
          ))}
        </span>
        <span class="steps-title">
          {tools.length} steps <span>· {parts.join(", ")}</span>
        </span>
        {failed > 0 && <span class="steps-err">{failed} failed</span>}
        <Icon name={open ? "chevD" : "chevR"} size={14} />
      </button>
      {open && (
        <div class="steps-body">
          {tools.map((t) => (
            <ToolRow key={t.id} t={t} live={false} />
          ))}
        </div>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const copy = () =>
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      })
      .catch(() => toastError(new Error("Clipboard blocked — use History to select the text")));
  return (
    <button class={`msg-copy ${done ? "done" : ""}`} onClick={copy} aria-label="Copy message">
      <Icon name={done ? "check" : "copy"} size={13} /> {done ? "Copied" : "Copy"}
    </button>
  );
}

const CTX_LONG = 150_000;

/**
 * Every reply re-reads the whole conversation, so a long one costs more per turn
 * the longer it gets. Claude Code compacts on its own only near the model's full
 * window (far past 150k on the big models), so past ~150k offer to do it sooner. A compaction
 * takes about a minute and shows nothing in between, so say it's running until the
 * transcript reports the smaller size.
 */
function CompactCard({ s, ctx, busy, onCompact, onDismiss }: { s: Session; ctx: number; busy: boolean; onCompact: () => void; onDismiss: () => void }) {
  if (busy)
    return (
      <div class="live-card">
        <div class="lc-head">
          <i class="spin" /> Compacting · {compact(ctx)} tokens
        </div>
        <p class="lc-hint">Claude is summarizing the conversation. This takes about a minute; the size above drops when it's done.</p>
      </div>
    );
  return (
    <div class="live-card">
      <div class="lc-head">
        <Icon name="layers" size={16} /> Long conversation · {compact(ctx)} tokens
      </div>
      <div class="lc-body strong">Every reply re-reads all of it, so each turn costs more than the last.</div>
      <p class="lc-hint">
        ansai tells the agent when it's this long, and the agent compacts itself at a good stopping point, so autopilot runs keep going without you. Compact now if you'd rather not wait, or start a new session for unrelated work.
      </p>
      <div class="lc-actions two">
        <button class="btn primary" onClick={() => api.send(s.id, "/compact", true).then(onCompact).catch(toastError)}>
          Compact
        </button>
        <button class="btn ghost" onClick={onDismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}

/** Team messages slot into the conversation by time; the log's own order is kept. */
function interleave(items: ChatItem[], team: Message[]): (ChatItem | Message)[] {
  if (!team.length) return items;
  const out: (ChatItem | Message)[] = [];
  let j = 0;
  for (const it of items) {
    while (j < team.length && team[j]!.created_at <= it.ts) out.push(team[j++]!);
    out.push(it);
  }
  while (j < team.length) out.push(team[j++]!);
  return out;
}

/** `onCtx` hears the conversation's context size, for the session header. */
export function ChatView({ s, onCtx }: { s: Session; onCtx?: (tokens: number | null) => void }) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [phase, setPhase] = useState<"loading" | "live" | "nofile" | "reconnecting">("loading");
  const [more, setMore] = useState(false);
  const [ctx, setCtx] = useState<number | null>(null);
  const [nudgeOff, setNudgeOff] = useState(false);
  const [compacting, setCompacting] = useState<number | null>(null); // context size when you asked
  useEffect(() => onCtx?.(ctx), [ctx]);
  // Done when the size drops (the transcript's compact marker), or give up after 3 minutes.
  useEffect(() => {
    if (compacting === null) return;
    if (ctx !== null && ctx < compacting * 0.7) return void setCompacting(null);
    const t = setTimeout(() => setCompacting(null), 180_000);
    return () => clearTimeout(t);
  }, [compacting, ctx]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let disposed = false;
    let retry = 400;
    const vis = () => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ v: document.visibilityState === "visible" }));
    const connect = () => {
      if (disposed) return;
      const sock = new WebSocket(wsUrl(`/ws/chat/${s.id}`));
      ws = sock;
      sock.onopen = () => {
        retry = 400;
        vis();
      };
      sock.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.t === "init") {
          stick.current = true;
          setItems(m.items);
          setMore(!!m.more);
          setCtx(m.ctx ?? null);
          setPhase(m.found ? "live" : "nofile");
        } else if (m.t === "ctx") {
          setCtx(m.tokens ?? null);
        } else if (m.t === "reset") {
          setCtx(null);
          setItems([]);
          setPhase("live");
        } else if (m.t === "items") {
          setPhase("live");
          setItems((prev) => {
            const next = prev.slice();
            const at = new Map(next.map((x, i) => [x.id, i]));
            for (const it of m.items as ChatItem[]) {
              const i = at.get(it.id);
              if (i === undefined) (at.set(it.id, next.length), next.push(it));
              else next[i] = it;
            }
            return next;
          });
        }
      };
      sock.onclose = () => {
        if (disposed || ws !== sock) return;
        setPhase((p) => (p === "loading" ? p : "reconnecting"));
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 8000);
      };
    };
    connect();
    document.addEventListener("visibilitychange", vis);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", vis);
      ws?.close();
    };
  }, [s.id]);

  // Follow new output while you're at the bottom; otherwise offer a jump button.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else setShowJump(true);
  }, [items, s.agent_state]);

  const onScroll = () => {
    const el = scroller.current!;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = near;
    if (near) setShowJump(false);
  };
  const jump = () => {
    const el = scroller.current!;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    stick.current = true;
    setShowJump(false);
  };

  const team = useSessionMessages(s);
  const st = sessionState(s);
  const running = s.status === "running";
  const lastTool = [...items].reverse().find((x) => x.k === "tool") as ToolItem | undefined;
  const pendingQuestion = running && lastTool && lastTool.name === "AskUserQuestion" && !lastTool.done ? lastTool : null;
  const lastToolId = lastTool?.id;

  return (
    <div class="chat">
      <div class="chat-scroll" ref={scroller} onScroll={onScroll}>
        <div class="chat-inner">
          {more && <div class="chat-note">Earlier messages are in the terminal history.</div>}
          {phase === "loading" && <div class="chat-note">Loading conversation…</div>}
          {phase !== "loading" && items.length === 0 && (
            <div class="chat-empty">
              <ToolBadge tool={s.tool} size={44} />
              <h3>{s.startup?.message ? `${TOOL_LABEL[s.tool]} hasn't started yet` : phase === "nofile" ? `${TOOL_LABEL[s.tool]} is ready` : "No messages yet"}</h3>
              <p>
                {s.startup?.message
                  ? "It's waiting for an answer before it starts. Use the buttons below."
                  : "Send a message below. The conversation shows up here as the agent works — switch to Terminal any time for the full screen."}
              </p>
            </div>
          )}
          {groupSteps(interleave(items, team), running && st.cls === "working" ? lastToolId : undefined).map((it) => {
            if ("body" in it) return <TeamBubble key={`m${it.id}`} m={it} me={s.id} />;
            if (it.k === "steps") return <StepGroup key={it.id} tools={it.tools} />;
            if (it.k === "user") return <UserBubble key={it.id} text={it.text} />;
            if (it.k === "assistant")
              return (
                <div class="msg agent" key={it.id}>
                  <Markdown text={it.text} />
                  <CopyButton text={it.text} />
                </div>
              );
            if (it.k === "thinking") return <Thinking key={it.id} text={it.text} />;
            if (it.k === "note") return <div class="chat-note" key={it.id}>{it.text}</div>;
            return <ToolRow key={it.id} t={it} live={running && st.cls === "working" && it.id === lastToolId} />;
          })}
          {running && s.startup?.message && <StartupCard s={s} />}
          {running && st.cls === "attn" && !pendingQuestion && !s.startup?.message && <ApprovalCard s={s} />}
          {pendingQuestion && <QuestionCard s={s} t={pendingQuestion} />}
          {running && st.cls === "working" && <WorkingRow s={s} />}
          {running && ctx !== null && ((compacting !== null && st.cls !== "working") || (compacting === null && st.cls === "turn" && ctx >= CTX_LONG && !nudgeOff)) && (
            <CompactCard s={s} ctx={ctx} busy={compacting !== null} onCompact={() => setCompacting(ctx)} onDismiss={() => setNudgeOff(true)} />
          )}
          {s.status === "exited" && <div class="chat-note">{TOOL_LABEL[s.tool]} exited.</div>}
          {phase === "reconnecting" && <div class="chat-note warn-text">Reconnecting…</div>}
        </div>
      </div>
      {showJump && (
        <button class="jump" onClick={jump}>
          <Icon name="chevD" size={16} /> Latest
        </button>
      )}
    </div>
  );
}
