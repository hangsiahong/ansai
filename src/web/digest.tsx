import { useEffect, useState } from "preact/hooks";
import type { Shift } from "./api";
import { toastError, useStore } from "./store";
import { Icon, Link } from "./ui";
import { TaskRow } from "./views/tasks";

/**
 * "While you were away" on the Now page: what the agents got done since you
 * last cleared it (on any device). Hidden when there's nothing new.
 */

export type Digest = {
  since: number;
  finished: string[];
  filed: string[];
  shifts: (Shift & { title: string })[];
  messages: number;
  projects: { projectId: string; name: string; branch: string | null; count: number; commits: { sha: string; subject: string; at: number }[]; unmerged: number }[];
};

async function req<T>(method: "GET" | "POST", path: string): Promise<T> {
  const res = await fetch(path, { method });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data as T;
}
const fetchDigest = () => req<Digest>("GET", "/api/digest");
const markSeen = () => req<{ ok: true }>("POST", "/api/digest/seen");

const clock = (ts: number) => {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return (sameDay ? "" : d.toLocaleDateString([], { weekday: "short" }) + " ") + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

const END: Record<string, string> = {
  time: "time was up",
  agent: "done",
  idle: "ran out of work",
  you: "ended by you",
  exited: "agent stopped",
  cap: "hit the nudge limit",
};

type Tab = "review" | "done" | "code" | "shifts" | "filed";

export function AwayDigest() {
  const tasks = useStore((s) => s.tasks);
  const [d, setD] = useState<Digest | null>(null);
  const [tab, setTab] = useState<Tab | null | undefined>(undefined); // undefined = pick the first that has something
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  // Refetch when tasks change (an agent finished or filed one) and every couple of minutes for commits.
  const signal = tasks.map((t) => `${t.id}:${t.status}`).join(",");
  useEffect(() => {
    let alive = true;
    const load = () => fetchDigest().then((x) => alive && setD(x)).catch(() => {});
    const t = setTimeout(load, 300);
    const iv = setInterval(load, 120_000);
    return () => {
      alive = false;
      clearTimeout(t);
      clearInterval(iv);
    };
  }, [signal]);

  if (!d) return null;
  const finished = d.finished.map((id) => tasks.find((t) => t.id === id)).filter((t) => !!t);
  const review = finished.filter((t) => t.status === "review");
  const done = finished.filter((t) => t.status === "done");
  const filed = d.filed.map((id) => tasks.find((t) => t.id === id)).filter((t) => !!t);
  const commits = d.projects.reduce((n, p) => n + p.count, 0);
  const tiles: { id: Tab; n: number; label: string }[] = (
    [
      { id: "review", n: review.length, label: "to review" },
      { id: "done", n: done.length, label: "done" },
      { id: "code", n: commits || d.projects.reduce((n, p) => n + p.unmerged, 0), label: commits === 1 ? "commit" : commits ? "commits" : "unmerged" },
      { id: "shifts", n: d.shifts.length, label: d.shifts.length === 1 ? "shift" : "shifts" },
      { id: "filed", n: filed.length, label: "filed" },
    ] as { id: Tab; n: number; label: string }[]
  ).filter((t) => t.n > 0);
  if (!tiles.length) return null;
  const current: Tab | null = tab === undefined ? tiles[0]!.id : tab && tiles.some((t) => t.id === tab) ? tab : null;

  const clear = async () => {
    try {
      await markSeen();
      setD({ ...d, finished: [], filed: [], shifts: [], projects: [], messages: 0 });
    } catch (e) {
      toastError(e);
    }
  };

  const taskList = (list: typeof finished, key: string) => {
    const shown = open[key] ? list : list.slice(0, 4);
    return (
      <div class="panel" style={{ "--sep": "48px" }}>
        {shown.map((t) => (
          <TaskRow task={t} showProject />
        ))}
        {list.length > shown.length && (
          <button class="digest-more" onClick={() => toggle(key)}>
            {plural(list.length - shown.length, "more task")}
          </button>
        )}
      </div>
    );
  };

  return (
    <section class="sec digest">
      <div class="sec-head">
        <h2 class="sec-title">While you were away</h2>
        <span class="sec-count">since {clock(d.since)}</span>
        <button class="sec-link" onClick={clear} title="Mark all of this as seen, on every device">
          Clear
        </button>
      </div>
      <div class="digest-stats" role="tablist" aria-label="While you were away" style={{ "--n": tiles.length }}>
        {tiles.map((t) => (
          <button role="tab" aria-selected={current === t.id} class={current === t.id ? "on" : ""} onClick={() => setTab(current === t.id ? null : t.id)}>
            <b>{t.n}</b>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {current === "review" && taskList(review, "review")}
      {current === "done" && taskList(done, "done")}
      {current === "filed" && taskList(filed, "filed")}

      {current === "code" && (
        <div class="panel">
          {d.projects.map((p) => (
            <div class="digest-proj">
              <button class="digest-row" onClick={() => toggle(`p:${p.projectId}`)} aria-expanded={!!open[`p:${p.projectId}`]}>
                <Icon name="branch" size={17} />
                <span class="digest-row-main">
                  <b>{p.name}</b>
                  <em>
                    {p.count > 0 && `${plural(p.count, "commit")}${p.branch ? ` on ${p.branch}` : ""}`}
                    {p.count > 0 && p.unmerged > 0 && " · "}
                    {p.unmerged > 0 && `${p.unmerged} on task branches, not merged`}
                  </em>
                </span>
                <Icon name={open[`p:${p.projectId}`] ? "chevD" : "chevR"} size={15} stroke={2.2} />
              </button>
              {open[`p:${p.projectId}`] && (
                <div class="digest-commits">
                  {p.commits.map((c) => (
                    <div class="shift-commit">
                      <code>{c.sha}</code>
                      <span>{c.subject}</span>
                    </div>
                  ))}
                  {p.count > p.commits.length && <div class="shift-commit muted">and {p.count - p.commits.length} more</div>}
                  <Link href={`/p/${p.projectId}`} class="digest-link">
                    Open {p.name}
                  </Link>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {current === "shifts" && (
        <div class="panel">
          {d.shifts.map((sh) => {
            const n = (sh.report?.commits.length ?? 0) + (sh.report?.moreCommits ?? 0);
            return (
              <Link href={`/s/${sh.session_id}`} class="digest-row">
                <Icon name="moon" size={17} />
                <span class="digest-row-main">
                  <b>{sh.title}</b>
                  <em>
                    Ended {clock(sh.ended_at!)} · {END[sh.end_reason ?? ""] ?? "ended"} · {plural(sh.nudges, "nudge")}
                    {sh.report ? ` · ${plural(n, "commit")}` : ""}
                  </em>
                  {sh.summary && <span class="digest-summary">{sh.summary}</span>}
                </span>
                <Icon name="chevR" size={15} stroke={2.2} />
              </Link>
            );
          })}
        </div>
      )}
      {d.messages > 0 && <p class="digest-foot">{plural(d.messages, "team message")} between agents meanwhile. Each project's Team panel has them.</p>}
    </section>
  );
}
