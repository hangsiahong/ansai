import { useMemo } from "preact/hooks";
import type { Account, Session, ToolId } from "../api";
import { openPalette, openSheet, useStore } from "../store";
import { AGENTS, Empty, Icon, Link, TOOL_SHORT, ToolBadge, ago, sessionOrder, sessionState, useTick } from "../ui";
import { TaskRow } from "./tasks";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Late night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** One session as an iOS list cell: logo · title / detail · status · chevron. */
export function SessionCell({ s }: { s: Session }) {
  const accounts = useStore((st) => st.accounts);
  const acc = s.account_id ? accounts.find((a) => a.id === s.account_id) : null;
  const st = sessionState(s);
  const showMsg = (st.cls === "attn" || st.cls === "turn") && s.agent_message;
  return (
    <Link href={`/s/${s.id}`} class={`cell ${st.cls}`}>
      <ToolBadge tool={s.tool} size={38} />
      <span class="cell-main">
        <span class="cell-title">{s.title}</span>
        <span class="cell-sub">
          {showMsg ? s.agent_message : `${s.project_name ?? "~"}${acc && !acc.is_default ? ` · ${acc.name}` : ""} · ${ago(s.activity_at ?? s.created_at)}`}
        </span>
      </span>
      <span class={`cell-detail ${st.cls}`}>{st.label}</span>
      <Icon name="chevR" size={17} stroke={2.2} />
    </Link>
  );
}

/** Home-screen style launchers. */
export function Launchers({ projectId }: { projectId?: string }) {
  const tools = useStore((s) => s.tools);
  return (
    <div class="launchers">
      {(["claude", "codex", "agy", "shell"] as ToolId[])
        .filter((t) => tools.find((x) => x.id === t)?.installed !== false)
        .map((t) => (
          <button class="launcher" onClick={() => openSheet({ kind: "new", tool: t, projectId })}>
            <ToolBadge tool={t} size={58} />
            <span>{TOOL_SHORT[t]}</span>
          </button>
        ))}
    </div>
  );
}

function UsageRows({ accounts }: { accounts: Account[] }) {
  const rows = AGENTS.map((t) => accounts.find((a) => a.tool === t && a.is_default)).filter((a): a is Account => !!a && !!a.usage?.limits.length);
  if (!rows.length) return null;
  return (
    <section class="sec">
      <div class="sec-head">
        <h2 class="sec-title">Usage</h2>
        <Link href="/accounts" class="sec-link">
          Accounts
        </Link>
      </div>
      <div class="panel" style={{ "--sep": "66px" }}>
        {rows.map((a) => {
          const top = [...a.usage!.limits].sort((x, y) => y.used_percent - x.used_percent)[0]!;
          const lvl = top.used_percent >= 90 ? "hot" : top.used_percent >= 70 ? "warm" : "ok";
          return (
            <Link href="/accounts" class="cell">
              <ToolBadge tool={a.tool} size={38} />
              <span class="cell-main">
                <span class="cell-title">
                  {TOOL_SHORT[a.tool]}
                  {a.plan && <span class="muted"> · {a.plan}</span>}
                </span>
                <span class={`us-bar ${lvl}`}>
                  <i style={{ width: `${top.used_percent}%` }} />
                </span>
              </span>
              <span class="cell-detail">
                {top.used_percent}% {top.label.replace("Weekly", "weekly").replace("5-hour", "5h")}
              </span>
              <Icon name="chevR" size={17} stroke={2.2} />
            </Link>
          );
        })}
      </div>
    </section>
  );
}

export function NowPane() {
  useTick();
  const sessions = useStore((s) => [...s.sessions].sort(sessionOrder));
  const tasks = useStore((s) => s.tasks);
  const projects = useStore((s) => s.projects);
  const accounts = useStore((s) => s.accounts);
  const connected = useStore((s) => s.connected);

  const attn = sessions.filter((s) => s.status === "running" && sessionState(s).cls === "attn");
  const others = sessions.filter((s) => !attn.includes(s));
  const running = sessions.filter((s) => s.status === "running").length;
  const inProgress = tasks.filter((t) => t.status === "doing" || t.status === "review").sort((a, b) => b.updated_at - a.updated_at);
  const upNext = tasks
    .filter((t) => t.status === "todo")
    .sort((a, b) => b.priority - a.priority || a.position - b.position)
    .slice(0, 5);
  const shortcuts = useMemo(() => {
    const pinned = projects.filter((p) => p.pinned);
    const recent = projects.filter((p) => !p.pinned && p.last_used_at).slice(0, Math.max(0, 6 - pinned.length));
    return [...pinned, ...recent];
  }, [projects]);

  return (
    <div class="pane now">
      <header class="now-head">
        <div class="now-title">
          <p class="now-eyebrow">
            <span class={`conn ${connected ? "on" : ""}`} /> {attn.length ? `${attn.length} waiting for you` : running ? `${running} running` : "All quiet"}
          </p>
          <h1>{greeting()}</h1>
        </div>
        <div class="row tight phone-only">
          <button class="icon-btn glass" onClick={() => openPalette()} aria-label="Search">
            <Icon name="search" size={19} />
          </button>
          <button class="icon-btn glass" onClick={() => openSheet({ kind: "settings" })} aria-label="Settings">
            <Icon name="sliders" size={19} />
          </button>
        </div>
      </header>

      <div class="now-body">
        <div class="now-main">
          {attn.length > 0 && (
            <section class="sec">
              <h2 class="sec-title attn">Needs you</h2>
              <div class="panel attn-panel" style={{ "--sep": "66px" }}>
                {attn.map((s) => (
                  <SessionCell s={s} />
                ))}
              </div>
            </section>
          )}

          {others.length > 0 && (
            <section class="sec">
              <h2 class="sec-title">Sessions</h2>
              <div class="panel" style={{ "--sep": "66px" }}>
                {others.map((s) => (
                  <SessionCell s={s} />
                ))}
              </div>
            </section>
          )}

          <section class="sec">
            <h2 class="sec-title">{sessions.length ? "Start another" : "Start an agent"}</h2>
            <Launchers />
            {!sessions.length && <p class="sec-foot">Agents keep running on your laptop even when you close this app.</p>}
          </section>
        </div>

        <aside class="now-side">
          <UsageRows accounts={accounts} />

          {inProgress.length > 0 && (
            <section class="sec">
              <div class="sec-head">
                <h2 class="sec-title">In progress</h2>
                <Link href="/backlog" class="sec-link">
                  Backlog
                </Link>
              </div>
              <div class="panel" style={{ "--sep": "48px" }}>
                {inProgress.map((t) => (
                  <TaskRow task={t} showProject />
                ))}
              </div>
            </section>
          )}

          <section class="sec">
            <div class="sec-head">
              <h2 class="sec-title">Up next</h2>
              <button class="sec-link" onClick={() => openSheet({ kind: "new-task" })}>
                Add task
              </button>
            </div>
            {upNext.length ? (
              <div class="panel" style={{ "--sep": "48px" }}>
                {upNext.map((t) => (
                  <TaskRow task={t} showProject />
                ))}
              </div>
            ) : (
              <Empty icon="list" title="Backlog is empty">
                Capture ideas as tasks, then hand them to an agent.
              </Empty>
            )}
          </section>

          {shortcuts.length > 0 && (
            <section class="sec">
              <div class="sec-head">
                <h2 class="sec-title">Projects</h2>
                <Link href="/projects" class="sec-link">
                  All {projects.length}
                </Link>
              </div>
              <div class="panel">
                {shortcuts.map((p) => (
                  <Link href={`/p/${p.id}`} class="prow">
                    <span class={`prow-icon ${p.pinned ? "pinned" : ""}`}>
                      <Icon name={p.pinned ? "star" : "folder"} size={16} stroke={2.2} />
                    </span>
                    <span class="prow-main">
                      <span class="prow-name">{p.name}</span>
                    </span>
                    <Icon name="chevR" size={17} stroke={2.2} />
                  </Link>
                ))}
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
