import { openSheet, useStore } from "../store";
import { Link, TOOL_LABEL, ToolDot, ago, sessionState, useTick } from "../ui";
import { TaskRow } from "./tasks";

export function Overview() {
  useTick();
  const sessions = useStore((s) => s.sessions);
  const tasks = useStore((s) => s.tasks);
  const me = useStore((s) => s.me);
  const doing = tasks.filter((t) => t.status === "doing" || t.status === "review").sort((a, b) => b.updated_at - a.updated_at);
  const next = tasks
    .filter((t) => t.status === "todo")
    .sort((a, b) => b.priority - a.priority || a.position - b.position)
    .slice(0, 6);

  return (
    <div class="pane overview">
      <div class="hero">
        <h1>Your agents, from anywhere.</h1>
        <p>
          {me?.tailscale.url ? (
            <>
              Private URL: <code>{me.tailscale.url}</code>
            </>
          ) : (
            <>Local only — log in to Tailscale to reach this from your phone.</>
          )}
        </p>
        <div class="row">
          {(["claude", "codex", "agy", "shell"] as const).map((t, i) => (
            <button class={`btn ${i === 0 ? "primary" : ""}`} onClick={() => openSheet({ kind: "new", tool: t })}>
              <ToolDot tool={t} /> {TOOL_LABEL[t]}
            </button>
          ))}
        </div>
      </div>

      {sessions.length > 0 && (
        <>
          <h3 class="section-title">Sessions</h3>
          <div class="cards">
            {sessions.map((s) => {
              const st = sessionState(s);
              return (
                <Link href={`/s/${s.id}`} class="card">
                  <div class="card-top">
                    <ToolDot tool={s.tool} />
                    <span class="card-tool">{TOOL_LABEL[s.tool]}</span>
                    <span class={`badge ${st.cls}`}>{st.label}</span>
                  </div>
                  <div class="card-title">{s.title}</div>
                  <div class="card-sub">
                    {s.project_name ?? "~"} · started {ago(s.created_at)} ago
                  </div>
                </Link>
              );
            })}
          </div>
        </>
      )}

      {(doing.length > 0 || next.length > 0) && (
        <div class="two-col">
          {doing.length > 0 && (
            <section>
              <h3 class="section-title">In progress</h3>
              {doing.map((t) => (
                <TaskRow task={t} showProject />
              ))}
            </section>
          )}
          {next.length > 0 && (
            <section>
              <h3 class="section-title">
                Up next <Link href="/backlog" class="see-all">see all</Link>
              </h3>
              {next.map((t) => (
                <TaskRow task={t} showProject />
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
