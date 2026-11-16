import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, type SystemHistory, type SystemNow, type SystemPoint, type SystemProcs, type SystemRange, type SystemSample } from "./api";
import { useStore } from "./store";
import { Empty, Icon, Link, ToolBadge, goBack } from "./ui";

// ------------------------------------------------------------------ helpers

/** Polls while the page is visible (a hidden tab or backgrounded phone app costs nothing); keeps the last good answer if a request fails. */
function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      if (!alive || running) return;
      running = true;
      try {
        if (!document.hidden) {
          const d = await fn();
          if (alive) {
            setData(d);
            setFailed(false);
          }
        }
      } catch {
        if (alive) setFailed(true);
      } finally {
        running = false;
      }
      if (alive) {
        clearTimeout(timer);
        timer = setTimeout(run, ms);
      }
    };
    const wake = () => {
      if (!document.hidden) run();
    };
    document.addEventListener("visibilitychange", wake);
    run();
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, deps);
  return { data, failed };
}

const GB = 1024 ** 3;
const bytes = (n: number) => (n >= GB ? `${n >= 100 * GB ? Math.round(n / GB) : (n / GB).toFixed(1)} GB` : `${Math.round(n / 1048576)} MB`);
const uptime = (s: number) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
const duration = (min: number) => (min >= 90 ? `${(min / 60).toFixed(1)} h` : `${min} min`);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const level = (pct: number, warm: number, hot: number) => (pct >= hot ? "hot" : pct >= warm ? "warm" : "ok");

type Sample = SystemSample;

function Bar({ pct, tone }: { pct: number; tone: string }) {
  return (
    <div class={`bar ${tone}`} role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${clamp(pct, 0, 100)}%` }} />
    </div>
  );
}

function Card(p: { icon: string; title: string; sub?: string; tone: string; children: ComponentChildren }) {
  return (
    <article class="sys-card">
      <header>
        <span class={`tile sm ${p.tone}`}>
          <Icon name={p.icon} size={14} />
        </span>
        <h3>{p.title}</h3>
        {p.sub && <span class="sys-sub">{p.sub}</span>}
      </header>
      {p.children}
    </article>
  );
}

const Big = ({ value, unit, tone = "" }: { value: string; unit: string; tone?: string }) => (
  <div class={`sys-big ${tone}`}>
    {value}
    <small>{unit}</small>
  </div>
);

const Fact = ({ k, v, tone = "" }: { k: string; v: ComponentChildren; tone?: string }) => (
  <div>
    <dt>{k}</dt>
    <dd class={tone}>{v}</dd>
  </div>
);

// -------------------------------------------------------------------- cards

function CpuCard({ s }: { s: Sample }) {
  const c = s.cpu;
  const model = c.model.replace(/\((R|TM)\)/g, "").replace(/\s+/g, " ").trim();
  return (
    <Card icon="cpu" title="Processor" sub={model} tone="blue">
      <Big value={c.pct == null ? "–" : String(Math.round(c.pct))} unit="%" />
      {c.cores.length > 0 && (
        <div class="sys-cores" role="img" aria-label="Load on each thread">
          {c.cores.map((p, i) => (
            <i title={`Thread ${i + 1}: ${Math.round(p)}%`} class={p >= 90 ? "hot" : ""} style={{ height: `${Math.max(5, p)}%` }} />
          ))}
        </div>
      )}
      <dl class="sys-facts">
        <Fact k="Load average" v={c.load.map((x) => x.toFixed(2)).join(" · ")} />
        <Fact k="Threads" v={c.threads} />
        {c.pressure && <Fact k="Waiting for a CPU" v={`${c.pressure.avg10.toFixed(1)}%`} tone={c.pressure.avg10 >= 25 ? "warn-text" : ""} />}
      </dl>
    </Card>
  );
}

function MemoryCard({ s }: { s: Sample }) {
  const m = s.mem;
  return (
    <Card icon="memory" title="Memory" sub={bytes(m.total)} tone="indigo">
      <Big value={String(Math.round(m.pct))} unit="%" tone={m.pct >= 90 ? "hot" : m.pct >= 75 ? "warn" : ""} />
      <Bar pct={m.pct} tone={level(m.pct, 75, 90)} />
      <dl class="sys-facts">
        <Fact k="In use" v={bytes(m.used)} />
        <Fact k="Available" v={bytes(m.available)} />
        <Fact k="Swap" v={m.swapTotal ? `${bytes(m.swapUsed)} of ${bytes(m.swapTotal)}` : "off"} />
        {m.pressure && <Fact k="Waiting for memory" v={`${m.pressure.avg10.toFixed(1)}%`} tone={m.pressure.avg10 >= 10 ? "warn-text" : ""} />}
      </dl>
    </Card>
  );
}

function TempCard({ s }: { s: Sample }) {
  const main = s.temps.filter((t) => t.kind === "cpu" || t.kind === "gpu");
  const pool = main.length ? main : s.temps;
  const top = pool.length ? Math.max(...pool.map((t) => t.c)) : null;
  const hot = pool.find((t) => t.c === top);
  const tone = hot ? (hot.c >= hot.crit ? "hot" : hot.c >= hot.warn ? "warn" : "") : "";
  return (
    <Card icon="thermo" title="Temperature" tone="orange">
      {top == null ? (
        <p class="muted small">No temperature sensors found on this machine.</p>
      ) : (
        <>
          <Big value={String(Math.round(top))} unit="°C" tone={tone} />
          <div class="sys-rows">
            {s.temps.map((t) => (
              <div class="sys-row">
                <span>{t.label}</span>
                <Bar pct={((t.c - 20) / (t.crit - 20)) * 100} tone={t.c >= t.crit ? "hot" : t.c >= t.warn ? "warm" : "ok"} />
                <b>{Math.round(t.c)}°</b>
              </div>
            ))}
          </div>
        </>
      )}
      {s.fans.length > 0 && (
        <dl class="sys-facts">
          {s.fans.map((f) => (
            <Fact k={f.label} v={f.rpm ? `${f.rpm} rpm` : "off"} />
          ))}
        </dl>
      )}
    </Card>
  );
}

function StorageCard({ s }: { s: Sample }) {
  return (
    <Card icon="drive" title="Storage" tone="teal">
      {s.disks.length === 0 && <p class="muted small">No disks found.</p>}
      {s.disks.map((d) => (
        <div class="sys-disk">
          <div class="sys-disk-top">
            <b>{d.mount}</b>
            <span class="muted">{d.device.replace("/dev/", "")}</span>
            <em>{Math.round(d.pct)}%</em>
          </div>
          <Bar pct={d.pct} tone={level(d.pct, 80, 90)} />
          <div class="muted small">
            {bytes(d.avail)} free of {bytes(d.total)}
          </div>
        </div>
      ))}
    </Card>
  );
}

function BatteryCard({ b }: { b: NonNullable<Sample["battery"]> }) {
  const state = b.charging ? "Charging" : b.discharging ? "On battery" : b.plugged && b.limit ? `Plugged in, held at ${b.limit}%` : b.plugged ? "Plugged in" : b.status;
  return (
    <Card icon="battery" title="Battery" tone="green">
      <Big value={String(b.pct)} unit="%" tone={b.discharging && b.pct <= 7 ? "hot" : b.discharging && b.pct <= 15 ? "warn" : ""} />
      <Bar pct={b.pct} tone={b.discharging ? level(100 - b.pct, 85, 93) : "ok"} />
      <dl class="sys-facts">
        <Fact k="State" v={state} />
        {b.watts != null && b.watts > 0 && <Fact k={b.charging ? "Charging at" : "Drawing"} v={`${b.watts} W`} />}
        {b.etaMin != null && <Fact k={b.charging ? "Full in" : "Time left"} v={duration(b.etaMin)} />}
      </dl>
    </Card>
  );
}

function Status({ now }: { now: SystemNow }) {
  if (!now.issues.length)
    return (
      <div class="sys-status ok">
        <Icon name="check" size={15} stroke={2.6} /> Everything looks fine
      </div>
    );
  return (
    <div class="sys-issues">
      {now.issues.map((i) => (
        <div class={`sys-issue ${i.level}`}>
          <Icon name="alert" size={19} />
          <div>
            <b>{i.title}</b>
            <span>{i.detail}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------- charts

const RANGES: { id: SystemRange; label: string; span: number; ago: string }[] = [
  { id: "1h", label: "1 h", span: 3600_000, ago: "1 hour ago" },
  { id: "6h", label: "6 h", span: 6 * 3600_000, ago: "6 hours ago" },
  { id: "24h", label: "24 h", span: 24 * 3600_000, ago: "24 hours ago" },
  { id: "7d", label: "7 d", span: 7 * 24 * 3600_000, ago: "7 days ago" },
];

const savedRange = (): SystemRange => {
  try {
    const r = localStorage.getItem("ansai.sysRange");
    if (RANGES.some((x) => x.id === r)) return r as SystemRange;
  } catch {}
  return "1h";
};

type Pt = { t: number; v: number | null; peak?: number | null };

/**
 * One line chart: a line and soft area for the value, an optional thin line for its peak.
 * The line breaks where data is missing (ansai wasn't running, or the laptop slept) instead of
 * drawing a false slope across the gap. Touch or hover shows the value at that moment.
 */
function Chart(p: { title: string; color: string; pts: Pt[]; from: number; to: number; step: number; domain: [number, number]; fmt: (n: number) => string; mark?: number; long: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 300;
  const H = 76;
  const [lo, hi] = p.domain;
  const x = (t: number) => clamp(((t - p.from) / (p.to - p.from)) * W, 0, W);
  const y = (v: number) => H - ((clamp(v, lo, hi) - lo) / (hi - lo)) * H;

  const segs = (pick: (pt: Pt) => number | null | undefined) => {
    const out: [number, number][][] = [];
    let cur: [number, number][] = [];
    let prev: number | null = null;
    for (const pt of p.pts) {
      const v = pick(pt);
      if (v == null || (prev != null && pt.t - prev > p.step * 2.5)) {
        if (cur.length) out.push(cur);
        cur = [];
        prev = null;
      }
      if (v != null) {
        cur.push([x(pt.t + p.step / 2), y(v)]);
        prev = pt.t;
      }
    }
    if (cur.length) out.push(cur);
    return out;
  };
  const line = (s: [number, number][]) => s.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");
  const main = segs((pt) => pt.v);
  const peak = segs((pt) => pt.peak);
  const have = p.pts.some((pt) => pt.v != null);
  const latest = [...p.pts].reverse().find((pt) => pt.v != null);
  const hov = hover != null ? p.pts[hover] : null;

  const at = (e: PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const t = p.from + ((e.clientX - r.left) / r.width) * (p.to - p.from);
    let best = -1;
    let d = Infinity;
    p.pts.forEach((pt, i) => {
      const dist = Math.abs(pt.t + p.step / 2 - t);
      if (pt.v != null && dist < d) {
        d = dist;
        best = i;
      }
    });
    setHover(best >= 0 && d <= p.step * 2 ? best : null);
  };
  const when = (t: number) => new Date(t).toLocaleString([], p.long ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" });

  return (
    <div class="sys-chart" style={{ "--c": p.color }}>
      <div class="sys-chart-head">
        <b>{p.title}</b>
        <span>{hov && hov.v != null ? `${p.fmt(hov.v)} · ${when(hov.t)}` : latest ? p.fmt(latest.v!) : ""}</span>
      </div>
      <div class="sys-plot" onPointerMove={at} onPointerDown={at} onPointerLeave={() => setHover(null)} onPointerCancel={() => setHover(null)}>
        <svg class="sys-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${p.title} history`}>
          {[0.25, 0.5, 0.75].map((f) => (
            <line class="grid" x1="0" x2={W} y1={H * f} y2={H * f} />
          ))}
          {p.mark != null && p.mark > lo && p.mark < hi && <line class="mark" x1="0" x2={W} y1={y(p.mark)} y2={y(p.mark)} />}
          {main.map((s) =>
            s.length === 1 ? (
              <path class="dot" d={`M${s[0]![0]} ${s[0]![1]}h0`} />
            ) : (
              <>
                <path class="area" d={`${line(s)} L${s[s.length - 1]![0].toFixed(1)} ${H} L${s[0]![0].toFixed(1)} ${H} Z`} />
                <path class="line" d={line(s)} />
              </>
            ),
          )}
          {peak.map((s) => s.length > 1 && <path class="peak" d={line(s)} />)}
          {hov && hov.v != null && <line class="cursor" x1={x(hov.t + p.step / 2)} x2={x(hov.t + p.step / 2)} y1="0" y2={H} />}
        </svg>
        <span class="sys-y hi">{p.fmt(hi)}</span>
        <span class="sys-y lo">{p.fmt(lo)}</span>
        {!have && <div class="sys-empty">Collecting history… the first minute lands shortly</div>}
      </div>
      <div class="sys-axis">
        <span>{RANGES.find((r) => r.span === p.to - p.from)?.ago}</span>
        <span>now</span>
      </div>
    </div>
  );
}

const tempDomain = (pts: SystemPoint[]): [number, number] => {
  const v = pts.map((p) => p.temp).filter((n): n is number => n != null);
  if (!v.length) return [20, 100];
  let lo = Math.floor((Math.min(...v) - 5) / 10) * 10;
  const hi = Math.ceil((Math.max(...v) + 5) / 10) * 10;
  if (hi - lo < 30) lo = hi - 30;
  return [Math.max(0, lo), hi];
};

function History({ range, setRange, h }: { range: SystemRange; setRange: (r: SystemRange) => void; h: SystemHistory | null }) {
  const span = RANGES.find((r) => r.id === range)!.span;
  const from = h?.from ?? Date.now() - span;
  const to = from + span;
  const step = h?.step ?? 60_000;
  const pts = h && h.range === range ? h.points : [];
  const pct = (n: number) => `${Math.round(n)}%`;
  const common = { from, to, step, long: span > 24 * 3600_000 };
  return (
    <section class="sec">
      <div class="sec-head">
        <h2 class="sec-title">History</h2>
        <div class="segmented sys-ranges" role="radiogroup" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              role="radio"
              aria-checked={range === r.id}
              class={`seg ${range === r.id ? "on" : ""}`}
              onClick={() => {
                setRange(r.id);
                try {
                  localStorage.setItem("ansai.sysRange", r.id);
                } catch {}
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div class="panel" style={{ "--sep": "16px" }}>
        <Chart {...common} title="Processor" color="var(--accent)" pts={pts.map((p) => ({ t: p.t, v: p.cpu, peak: p.cpuMax }))} domain={[0, 100]} fmt={pct} />
        <Chart {...common} title="Memory" color="var(--indigo)" pts={pts.map((p) => ({ t: p.t, v: p.mem }))} domain={[0, 100]} fmt={pct} />
        <Chart {...common} title="Temperature (hottest CPU or GPU)" color="var(--warn)" pts={pts.map((p) => ({ t: p.t, v: p.temp }))} domain={tempDomain(pts)} mark={90} fmt={(n) => `${Math.round(n)}°C`} />
      </div>
      <p class="sec-foot">Averages per step, with the processor's peak as the thin line. Gaps are times ansai wasn't running or the machine slept.</p>
    </section>
  );
}

// --------------------------------------------------------------- who is using it

function Usage({ p }: { p: SystemProcs | null }) {
  const [by, setBy] = useState<"cpu" | "mem">("cpu");
  if (!p) return null;
  const agents = [...p.agents].sort(by === "cpu" ? (a, b) => b.cpu - a.cpu || b.rss - a.rss : (a, b) => b.rss - a.rss);
  const top = by === "cpu" ? p.topCpu : p.topMem;
  return (
    <section class="sec">
      <div class="sec-head">
        <h2 class="sec-title">What's using it</h2>
        <div class="segmented sys-ranges" role="radiogroup" aria-label="Sort by">
          {(["cpu", "mem"] as const).map((k) => (
            <button role="radio" aria-checked={by === k} class={`seg ${by === k ? "on" : ""}`} onClick={() => setBy(k)}>
              {k === "cpu" ? "CPU" : "Memory"}
            </button>
          ))}
        </div>
      </div>
      {agents.length > 0 ? (
        <div class="panel" style={{ "--sep": "58px" }}>
          {agents.map((a) => (
            <Link href={`/s/${a.id}`} class="cell sys-line">
              <ToolBadge tool={a.tool as never} size={32} />
              <span class="cell-main">
                <span class="cell-title">{a.title}</span>
                <span class="cell-sub">
                  {a.project ?? "No project"} · {a.procs} {a.procs === 1 ? "process" : "processes"}
                </span>
              </span>
              <span class="sys-nums">
                <b>{Math.round(a.cpu)}%</b>
                <em>{bytes(a.rss)}</em>
              </span>
              <Icon name="chevR" size={17} stroke={2.2} />
            </Link>
          ))}
        </div>
      ) : (
        <Empty icon="terminal" title="No agents running">
          When agents are running, you'll see which one is using the CPU and memory.
        </Empty>
      )}

      <h3 class="sys-subhead">Busiest processes</h3>
      <div class="panel" style={{ "--sep": "16px" }}>
        {top.map((r) => (
          <div class="cell sys-line static">
            <span class="cell-main">
              <span class="cell-title">{r.name}</span>
              {r.agent && <span class="cell-sub">in {r.agent}</span>}
            </span>
            <span class="sys-nums">
              <b>{Math.round(r.cpu)}%</b>
              <em>{bytes(r.rss)}</em>
            </span>
          </div>
        ))}
        <div class="cell sys-line static">
          <span class="cell-main">
            <span class="cell-title">ansai itself</span>
            <span class="cell-sub">
              {p.ansai.procs} {p.ansai.procs === 1 ? "process" : "processes"}, including git and terminals it started
            </span>
          </span>
          <span class="sys-nums">
            <b>{Math.round(p.ansai.cpu)}%</b>
            <em>{bytes(p.ansai.rss)}</em>
          </span>
        </div>
      </div>
      <p class="sec-foot">
        CPU is a share of one core, like <code>top</code>: 200% is two cores busy. Memory counts pages shared between processes in each of them, so totals are approximate.
      </p>
    </section>
  );
}

// --------------------------------------------------------------------- pages

export function SystemPane() {
  const now = usePoll(() => api.system(), 3000);
  const procs = usePoll(() => api.systemProcs(), 5000);
  const [range, setRange] = useState<SystemRange>(savedRange);
  const hist = usePoll(() => api.systemHistory(range), 30_000, [range]);
  const s = now.data?.sample ?? null;
  const unsupported = now.data && !now.data.supported;

  return (
    <div class="pane">
      <header class="topbar">
        <button class="icon-btn phone-only" onClick={() => goBack()} aria-label="Back">
          <Icon name="back" />
        </button>
        <div class="topbar-title">
          <h1>System</h1>
          <div class="sub">{s ? `${s.host} · up ${uptime(s.uptime)}` : "The machine ansai runs on"}</div>
        </div>
      </header>
      <div class="scroll wide">
        {unsupported && (
          <Empty icon="cpu" title="Monitoring isn't available here">
            ansai reads CPU, memory, disk and temperature from Linux (/proc and /sys), so this page needs ansai to run on Linux.
          </Empty>
        )}
        {!now.data && !now.failed && <p class="muted">Reading the machine…</p>}
        {!now.data && now.failed && <p class="warn-text">Couldn't reach ansai. Retrying…</p>}
        {now.data && s && (
          <>
            <Status now={now.data} />
            <div class="sys-grid">
              <CpuCard s={s} />
              <MemoryCard s={s} />
              <TempCard s={s} />
              <StorageCard s={s} />
              {s.battery && <BatteryCard b={s.battery} />}
            </div>
            <History range={range} setRange={setRange} h={hist.data} />
            <Usage p={procs.data} />
          </>
        )}
      </div>
    </div>
  );
}

/** One line for the Now and Usage pages: how the machine is doing, tap for the details. */
export function SystemRow() {
  const h = useStore((s) => s.health);
  if (!h) return null;
  const top = h.issues[0];
  const tone = h.level === "crit" ? "red" : h.level === "warn" ? "orange" : "green";
  const bits = [
    h.cpu != null ? `CPU ${Math.round(h.cpu)}%` : null,
    `RAM ${Math.round(h.mem)}%`,
    h.temp != null ? `${Math.round(h.temp)}°C` : null,
    h.disk != null ? `Disk ${Math.round(h.disk)}%` : null,
    h.battery && !h.battery.plugged ? `Battery ${h.battery.pct}%` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <section class="sec">
      <div class="sec-head">
        <h2 class="sec-title">This machine</h2>
        <Link href="/system" class="sec-link">
          Details
        </Link>
      </div>
      <div class="panel" style={{ "--sep": "66px" }}>
        <Link href="/system" class="cell">
          <span class={`tile lg ${tone}`}>
            <Icon name={top ? "alert" : "cpu"} size={19} />
          </span>
          <span class="cell-main">
            <span class="cell-title">{top ? `${top.title}${h.issues.length > 1 ? ` (+${h.issues.length - 1} more)` : ""}` : "Running fine"}</span>
            <span class="cell-sub">{bits}</span>
          </span>
          <Icon name="chevR" size={17} stroke={2.2} />
        </Link>
      </div>
    </section>
  );
}
