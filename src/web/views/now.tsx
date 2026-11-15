import { useMemo } from "preact/hooks";
import type { Account, Session, ToolId } from "../api";
import { openPalette, openSheet, useStore } from "../store";
import { AGENTS, Empty, Icon, Link, StatusPill, TOOL_LABEL, TOOL_SHORT, ToolBadge, ago, sessionOrder, sessionState, useTick } from "../ui";
import { TaskRow } from "./tasks";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Late night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function SessionCard({ s }: { s: Session }) {
  const accounts = useStore((st) => st.accounts);
  const acc = s.account_id ? accounts.find((a) => a.id === s.account_id) : null;
  const st = sessionState(s);
  return (
    <Link href={`/s/${s.id}`} class={`scard ${st.cls}`}>
      <div class="scard-top">
        <ToolBadge tool={s.tool} />
        <div class="scard-id">
          <div class="scard-title">{s.title}</div>
          <div class="scard-meta">
            {s.project_name ?? "~"}
            {acc && !acc.is_default ? ` · ${acc.name}` : ""} · {ago(s.activity_at ?? s.created_at)}
          </div>
        </div>
        <StatusPill s={s} />
      </div>
      {s.agent_message && (st.cls === "attn" || st.cls === "turn") && <div class="scard-msg">{s.agent_message}</div>}
    </Link>
  );
}

function QuickStart() {
  const tools = useStore((s) => s.tools);
  return (
    <div class="quickstart">
      {(["claude", "codex", "agy", "shell"] as ToolId[])
        .filter((t) => tools.find((x) => x.id === t)?.installed !== false)
        .map((t) => (
          <button class="qs-btn" onClick={() => openSheet({ kind: "new", tool: t })}>
            <ToolBadge tool={t} size={22} />
            <span>{TOOL_SHORT[t]}</span>
          </button>
        ))}
    </div>
  );
}

function UsageStrip({ accounts }: { accounts: Account[] }) {
  const rows = AGENTS.map((t) => accounts.find((a) => a.tool === t && a.is_default)).filter((a): a is Account => !!a && !!a.usage?.limits.length);
  if (!rows.length) return null;
  return (
    <Link href="/accounts" class="usage-strip">
      {rows.map((a) => {
        const top = [...a.usage!.limits].sort((x, y) => y.used_percent - x.used_percent)[0]!;
        const lvl = top.used_percent >= 90 ? "hot" : top.used_percent >= 70 ? "warm" : "ok";
        return (
          <div class="us-row">
            <ToolBadge tool={a.tool} size={20} />
            <span class="us-name">
              {TOOL_SHORT[a.tool]}
              {a.plan && <em> · {a.plan}</em>}
            </span>
            <span class={`us-bar ${lvl}`}>
              <i style={{ width: `${top.used_percent}%` }} />
            </span>
            <span class="us-pct">
              {top.used_percent}% <em>{top.label.replace("Weekly", "wk").replace("5-hour", "5h")}</em>
            </span>
          </div>
        );
      })}
    </Link>
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
        <div class="mobile-brand phone-only">
          <img src="/icon.svg" alt="" width="26" height="26" />
          <span class={`conn ${connected ? "on" : ""}`} />
        </div>
        <div class="now-title">
          <h1>{greeting()}</h1>
          <p>
            {attn.length
              ? `${attn.length} agent${attn.length > 1 ? "s" : ""} waiting for you`
              : sessions.filter((s) => s.status === "running").length
                ? `${sessions.filter((s) => s.status === "running").length} running · nothing needs you`
                : "Nothing running right now"}
          </p>
        </div>
        <div class="row tight phone-only">
          <button class="icon-btn" onClick={() => openPalette()} aria-label="Search">
            <Icon name="search" />
          </button>
          <button class="icon-btn" onClick={() => openSheet({ kind: "settings" })} aria-label="Settings">
            <Icon name="sliders" />
          </button>
        </div>
      </header>

      <div class="now-body">
        <div class="now-main">
          {attn.length > 0 && (
            <section class="sec">
              <h2 class="sec-title attn">Needs you</h2>
              <div class="cards">
                {attn.map((s) => (
                  <SessionCard s={s} />
                ))}
              </div>
            </section>
          )}

          <section class="sec">
            <div class="sec-head">
              <h2 class="sec-title">{others.length ? "Sessions" : "Start something"}</h2>
            </div>
            {others.length > 0 ? (
              <div class="cards">
                {others.map((s) => (
                  <SessionCard s={s} />
                ))}
              </div>
            ) : (
              <p class="hint">Open an agent in any of your projects — it keeps running here even when you close the app.</p>
            )}
            <QuickStart />
          </section>
        </div>

        <aside class="now-side">
          <UsageStrip accounts={accounts} />

          {inProgress.length > 0 && (
            <section class="sec">
              <div class="sec-head">
                <h2 class="sec-title">In progress</h2>
                <Link href="/backlog" class="sec-link">
                  Backlog <Icon name="chevR" size={14} />
                </Link>
              </div>
              <div class="panel">
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
                <Icon name="plus" size={14} /> Task
              </button>
            </div>
            {upNext.length ? (
              <div class="panel">
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
                  All {projects.length} <Icon name="chevR" size={14} />
                </Link>
              </div>
              <div class="chips">
                {shortcuts.map((p) => (
                  <Link href={`/p/${p.id}`} class="pchip">
                    <Icon name={p.pinned ? "star" : "folder"} size={14} />
                    {p.name}
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

export const toolLabel = (t: ToolId) => TOOL_LABEL[t];
