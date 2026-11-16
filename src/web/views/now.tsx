import { useMemo } from "preact/hooks";
import type { Account, Session, ToolId } from "../api";
import { openPalette, openSheet, useStore } from "../store";
import { AGENTS, Empty, FolderIcon, Icon, Link, TOOL_SHORT, ToolBadge, ago, modelLabel, sessionOrder, sessionState, useTick } from "../ui";
import { TaskRow } from "./tasks";
import { ShiftTag } from "../shift";
import { AwayDigest } from "../digest";
import { SystemRow } from "../system";

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
  const model = modelLabel(s);
  return (
    <Link href={`/s/${s.id}`} class={`cell ${st.cls}`}>
      <ToolBadge tool={s.tool} size={38} />
      <span class="cell-main">
        <span class="cell-title">{s.title}</span>
        <span class="cell-sub">
          {showMsg
            ? s.agent_message
            : `${s.project_name ?? "~"}${acc && !acc.is_default ? ` · ${acc.name}` : ""} · ${ago(s.activity_at ?? s.created_at)}${model ? ` · ${model}` : ""}`}
        </span>
      </span>
      <ShiftTag shift={s.shift} />
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

const REVIEW_SHOWN = 5;

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
  // "Doing" is an agent working on it now; "Review" is finished work waiting for you.
  const newest = (a: { updated_at: number }, b: { updated_at: number }) => b.updated_at - a.updated_at;
  const working = tasks.filter((t) => t.status === "doing").sort(newest);
  const toReview = tasks.filter((t) => t.status === "review").sort(newest);
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
            <Icon name="gear" size={19} />
          </button>
        </div>
      </header>

      <div class="now-body">
        <div class="now-main">
          {!sessions.length && !projects.length && (
            <section class="welcome-card">
              <span class="welcome-mark"><Icon name="terminal" size={19} /></span>
              <div class="welcome-copy">
                <h2>Your workspace is ready</h2>
                <p>Start an agent for a quick task, or add a project to keep related sessions and work together.</p>
              </div>
              <div class="welcome-actions">
                <button class="btn primary" onClick={() => openSheet({ kind: "new", tool: "claude" })}>Start an agent</button>
                <button class="btn" onClick={() => openSheet({ kind: "add-project" })}>Add a project</button>
              </div>
            </section>
          )}

          {attn.length > 0 && (
            <section class="sec">
              <h2 class="sec-title attn">Needs you</h2>
              <div class="panel attn-panel" style={{ "--sep": "66px" }}>
                {attn.map((s) => (
                  <SessionCell key={s.id} s={s} />
                ))}
              </div>
            </section>
          )}

          <AwayDigest />

          {others.length > 0 && (
            <section class="sec">
              <h2 class="sec-title">Sessions</h2>
              <div class="panel" style={{ "--sep": "66px" }}>
                {others.map((s) => (
                  <SessionCell key={s.id} s={s} />
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
          <SystemRow />

          {working.length > 0 && (
            <section class="sec">
              <div class="sec-head">
                <h2 class="sec-title">Agents working on</h2>
                <Link href="/backlog" class="sec-link">
                  Backlog
                </Link>
              </div>
              <div class="panel" style={{ "--sep": "48px" }}>
                {working.map((t) => (
                  <TaskRow task={t} showProject />
                ))}
              </div>
            </section>
          )}

          {toReview.length > 0 && (
            <section class="sec">
              <div class="sec-head">
                <h2 class="sec-title">Ready for your review · {toReview.length}</h2>
                <Link href="/backlog" class="sec-link">
                  {toReview.length > REVIEW_SHOWN ? "See all" : "Backlog"}
                </Link>
              </div>
              <div class="panel" style={{ "--sep": "48px" }}>
                {toReview.slice(0, REVIEW_SHOWN).map((t) => (
                  <TaskRow task={t} showProject />
                ))}
              </div>
              <p class="sec-foot">Agents finished these. Open one to check the work, then mark it Done.</p>
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
                    <FolderIcon size={32} pinned={!!p.pinned} />
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
