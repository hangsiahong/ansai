import { existsSync, readdirSync, readFileSync, statfsSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { cleanEnv } from "./config";
import { db, getSetting, now, setSetting } from "./db";
import { emit } from "./events";
import { notify } from "./push";
import { tmuxBase } from "./sessions";

/**
 * Watches the machine ansai runs on: CPU, memory, storage, temperature (plus fans,
 * battery and pressure stalls), straight from /proc and /sys. No packages, no root.
 *
 * - A sample is taken every 5 s and kept in memory (the live view).
 * - One row per minute goes to SQLite (health_samples) for the charts, kept 8 days.
 * - Trouble (a full disk, an overheating chip, no memory left, a dying battery) that
 *   lasts a couple of minutes is pushed to your phone, once, not repeatedly.
 * - On demand, processes are grouped by the agent session they belong to, so you can
 *   see which agent is eating the laptop.
 *
 * Linux only: elsewhere `supported` is false and the page says so.
 */

export const supported = process.platform === "linux" && existsSync("/proc/stat");

const SAMPLE_MS = 5_000;
/** Some sensors cost a real device query per read (NVMe ~4 ms, Wi-Fi ~2 ms), so they're read less often. */
const SLOW_MS = 30_000;
const DISK_MS = 30_000;
const MOUNTS_MS = 5 * 60_000;
const SENSORS_MS = 10 * 60_000;
const EMIT_MS = 15_000;
const KEEP_MS = 8 * 24 * 3600_000;

export type Level = "ok" | "warn" | "crit";
export type TempKind = "cpu" | "gpu" | "nvme" | "wifi" | "board";
export type Pressure = { avg10: number; avg60: number; avg300: number };
export type Temp = { id: string; label: string; kind: TempKind; c: number; warn: number; crit: number };
export type Disk = { mount: string; device: string; fs: string; total: number; used: number; avail: number; pct: number };
export type Battery = {
  pct: number;
  status: string;
  charging: boolean;
  discharging: boolean;
  /** On mains power. Not the same as charging: many laptops hold at a charge limit ("Not charging"). */
  plugged: boolean;
  watts: number | null;
  etaMin: number | null;
  /** The charge limit the firmware holds the battery at, when it has one. */
  limit: number | null;
};
export type Sample = {
  at: number;
  host: string;
  /** Seconds since boot. */
  uptime: number;
  cpu: { pct: number | null; cores: number[]; threads: number; model: string; load: [number, number, number]; pressure: Pressure | null };
  mem: { total: number; available: number; used: number; pct: number; swapTotal: number; swapUsed: number; pressure: Pressure | null };
  temps: Temp[];
  fans: { label: string; rpm: number }[];
  disks: Disk[];
  battery: Battery | null;
};
export type Issue = { id: string; level: "warn" | "crit"; title: string; detail: string };
export type Summary = {
  at: number;
  level: Level;
  issues: Issue[];
  cpu: number | null;
  mem: number;
  temp: number | null;
  disk: number | null;
  battery: { pct: number; plugged: boolean } | null;
};

// ------------------------------------------------------------------ helpers

const read = (p: string): string | null => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};
const num = (s: string | null): number | null => {
  if (s == null || !s.trim()) return null;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : null;
};
const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const byNumber = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

const gb = (n: number) => {
  const g = n / 1024 ** 3;
  return `${g >= 100 ? Math.round(g) : round1(g)} GB`;
};
const duration = (min: number) => (min >= 90 ? `${round1(min / 60)} h` : `${Math.round(min)} min`);

// ------------------------------------------------------------- /proc parsers

export type CpuTimes = { busy: number; total: number };

/** /proc/stat: the aggregate `cpu` line and one `cpuN` line per hardware thread. */
export function parseStat(text: string): { all: CpuTimes | null; cores: CpuTimes[] } {
  let all: CpuTimes | null = null;
  const cores: CpuTimes[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("cpu")) continue;
    const f = line.trim().split(/\s+/);
    // user nice system idle iowait irq softirq steal (guest time is already inside user/nice)
    const n = f.slice(1, 9).map(Number);
    if (n.length < 4 || n.some(Number.isNaN)) continue;
    const total = n.reduce((a, b) => a + b, 0);
    const idle = n[3]! + (n[4] ?? 0);
    const t = { busy: total - idle, total };
    if (f[0] === "cpu") all = t;
    else cores.push(t);
  }
  return { all, cores };
}

/** Busy percentage between two readings, or null when no time passed. */
export function cpuPct(prev: CpuTimes, cur: CpuTimes): number | null {
  const dt = cur.total - prev.total;
  if (dt <= 0) return null;
  return round1(clamp((100 * (cur.busy - prev.busy)) / dt, 0, 100));
}

/** /proc/meminfo in bytes. MemAvailable is what can be used without swapping; MemFree alone is misleading (the page cache is "used"). */
export function parseMeminfo(text: string) {
  const kb: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) kb[m[1]!] = Number(m[2]) * 1024;
  }
  const total = kb.MemTotal ?? 0;
  const available = clamp(kb.MemAvailable ?? (kb.MemFree ?? 0) + (kb.Buffers ?? 0) + (kb.Cached ?? 0), 0, total);
  const swapTotal = kb.SwapTotal ?? 0;
  const swapUsed = clamp(swapTotal - (kb.SwapFree ?? swapTotal), 0, swapTotal);
  return { total, available, used: total - available, swapTotal, swapUsed };
}

/** /proc/pressure/*: the share of time some task was stalled waiting for the resource. */
export function parsePressure(text: string | null): Pressure | null {
  const m = /^some avg10=([\d.]+) avg60=([\d.]+) avg300=([\d.]+)/m.exec(text ?? "");
  return m ? { avg10: Number(m[1]), avg60: Number(m[2]), avg300: Number(m[3]) } : null;
}

export type Mount = { mount: string; device: string; fs: string };
const REAL_FS = new Set(["ext2", "ext3", "ext4", "btrfs", "xfs", "f2fs", "vfat", "exfat", "ntfs", "ntfs3", "fuseblk", "zfs", "bcachefs", "jfs", "reiserfs"]);
const unescapeMount = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));

/**
 * The disks worth showing, from /proc/self/mountinfo: real filesystems only, and one row
 * per device (a btrfs volume mounted as /, /home and /var is one disk, shown as "/").
 */
export function parseMounts(text: string): Mount[] {
  const byDevice = new Map<string, Mount>();
  for (const line of text.split("\n")) {
    const sep = line.indexOf(" - ");
    if (sep < 0) continue;
    const left = line.slice(0, sep).split(" ");
    const right = line.slice(sep + 3).split(" ");
    const mount = unescapeMount(left[4] ?? "");
    const fs = right[0] ?? "";
    const device = right[1] ?? "";
    if (!mount || !REAL_FS.has(fs) || /^\/(snap|var\/lib\/(docker|containers|snapd))(\/|$)/.test(mount)) continue;
    const key = `${fs}:${device}`;
    const have = byDevice.get(key);
    const better = !have || mount === "/" || (have.mount !== "/" && mount.length < have.mount.length);
    if (better) byDevice.set(key, { mount, device, fs });
  }
  return [...byDevice.values()].sort((a, b) => (a.mount === "/" ? -1 : b.mount === "/" ? 1 : a.mount.localeCompare(b.mount)));
}

function diskOf(m: Mount): Disk | null {
  try {
    const s = statfsSync(m.mount);
    const bsize = Number(s.bsize);
    const total = Number(s.blocks) * bsize;
    const avail = Number(s.bavail) * bsize;
    const used = total - Number(s.bfree) * bsize;
    if (total < 100 * 1024 * 1024) return null; // tiny boot/firmware partitions are noise
    return { ...m, total, used, avail, pct: round1((100 * used) / Math.max(1, used + avail)) };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- sensors

export type SensorDef = {
  id: string;
  label: string;
  kind: TempKind;
  path: string;
  warn: number;
  crit: number;
  slow: boolean;
  /** hwmon runtime-PM status file: a suspended GPU must not be woken just to read its temperature. */
  pm: string | null;
  chip: string;
  raw: string;
};

const TEMP_DEFAULTS: Record<TempKind, [warn: number, crit: number]> = {
  cpu: [90, 97],
  gpu: [90, 100],
  nvme: [75, 85],
  wifi: [85, 100],
  board: [80, 95],
};

/** Which hwmon temperature is worth showing (null = skip it: per-core clutter, junk or duplicate sensors). */
export function classifySensor(chip: string, label: string, idx: number): { name: string; kind: TempKind } | null {
  const l = label.toLowerCase();
  if (chip === "k10temp" || chip === "zenpower") return l === "tctl" || l === "tdie" ? { name: "CPU", kind: "cpu" } : null;
  if (chip === "coretemp") return l.startsWith("package id") ? { name: "CPU", kind: "cpu" } : null;
  if (chip === "cpu_thermal" || chip === "cpu-thermal" || chip === "x86_pkg_temp") return idx === 1 ? { name: "CPU", kind: "cpu" } : null;
  if (chip === "amdgpu") return l === "edge" ? { name: "GPU", kind: "gpu" } : l === "junction" ? { name: "GPU hotspot", kind: "gpu" } : null;
  if (chip === "nouveau" || chip.startsWith("nvidia")) return idx === 1 ? { name: "GPU", kind: "gpu" } : null;
  if (chip === "nvme") return l === "composite" ? { name: "NVMe", kind: "nvme" } : null;
  if (/^(mt\d+|iwlwifi|ath\d+k?|rtw\d*|brcm)/.test(chip)) return idx === 1 ? { name: "Wi-Fi", kind: "wifi" } : null;
  if (chip === "acpitz") return idx === 1 ? { name: "Board", kind: "board" } : null; // the other zones are often a constant
  return null;
}

/** Warn/crit from what the chip itself reports (`temp_max`, `temp_crit`), else sensible defaults. */
function sensorLimits(kind: TempKind, max: number | null, crit: number | null): [number, number] {
  const sane = (x: number | null): x is number => x != null && x >= 40 && x <= 150;
  const [dw, dc] = TEMP_DEFAULTS[kind];
  const c = sane(crit) ? crit : sane(max) ? max : dc;
  let w = sane(max) ? max - 5 : sane(crit) ? crit - 10 : dw;
  if (w >= c) w = c - 5;
  return [round1(w), round1(c)];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Finds the temperature sensors under /sys/class (hwmon, then thermal zones). `root` is injectable for tests. */
export function discoverSensors(root = "/sys/class"): SensorDef[] {
  const found: Omit<SensorDef, "id">[] = [];
  const hw = join(root, "hwmon");
  let dirs: string[] = [];
  try {
    dirs = readdirSync(hw).sort(byNumber);
  } catch {}
  for (const d of dirs) {
    const base = join(hw, d);
    const chip = read(join(base, "name"))?.trim() ?? "";
    let files: string[] = [];
    try {
      files = readdirSync(base);
    } catch {
      continue;
    }
    const idxs = files.flatMap((f) => (/^temp(\d+)_input$/.exec(f) ? [Number(/^temp(\d+)_input$/.exec(f)![1])] : [])).sort((a, b) => a - b);
    for (const idx of idxs) {
      const raw = read(join(base, `temp${idx}_label`))?.trim() ?? "";
      const cls = classifySensor(chip, raw, idx);
      if (!cls) continue;
      const max = num(read(join(base, `temp${idx}_max`)));
      const crit = num(read(join(base, `temp${idx}_crit`)));
      const [warn, critC] = sensorLimits(cls.kind, max == null ? null : max / 1000, crit == null ? null : crit / 1000);
      found.push({
        label: cls.name,
        kind: cls.kind,
        path: join(base, `temp${idx}_input`),
        warn,
        crit: critC,
        slow: cls.kind === "nvme" || cls.kind === "wifi",
        pm: join(base, "device/power/runtime_status"),
        chip,
        raw,
      });
    }
  }
  // AMD reports both Tctl (control value, can carry an offset) and Tdie (real): keep the real one.
  const hasDie = (chip: string) => found.some((f) => f.chip === chip && f.raw.toLowerCase() === "tdie");
  const kept = found.filter((f) => !(f.raw.toLowerCase() === "tctl" && hasDie(f.chip)));

  // Boards without hwmon CPU sensors (Raspberry Pi, VMs…) still have thermal zones.
  if (!kept.some((f) => f.kind === "cpu")) {
    const tz = join(root, "thermal");
    let zones: string[] = [];
    try {
      zones = readdirSync(tz).filter((z) => z.startsWith("thermal_zone")).sort(byNumber);
    } catch {}
    for (const z of zones) {
      const type = read(join(tz, z, "type"))?.trim() ?? "";
      if (!/^(x86_pkg_temp|cpu[-_]thermal|soc[-_]thermal|cpu)$/.test(type)) continue;
      const [warn, crit] = sensorLimits("cpu", null, null);
      kept.push({ label: "CPU", kind: "cpu", path: join(tz, z, "temp"), warn, crit, slow: false, pm: null, chip: type, raw: type });
      break;
    }
  }

  // Unique, stable names: a second NVMe drive is "NVMe 2".
  const seen = new Map<string, number>();
  return kept.map((f) => {
    const n = (seen.get(f.label) ?? 0) + 1;
    seen.set(f.label, n);
    const label = n > 1 ? `${f.label} ${n}` : f.label;
    return { ...f, label, id: slug(label) };
  });
}

const sensorCache = new Map<string, { at: number; c: number | null }>();

/** °C, or null when unreadable, implausible or the device is asleep. */
export function readSensor(s: SensorDef, at: number): number | null {
  const hit = sensorCache.get(s.id);
  if (s.slow && hit && at - hit.at < SLOW_MS) return hit.c;
  if (s.pm && read(s.pm)?.trim() === "suspended") return null;
  const milli = num(read(s.path));
  const c = milli == null ? null : milli / 1000;
  const value = c != null && c > -30 && c < 150 ? round1(c) : null;
  sensorCache.set(s.id, { at, c: value });
  return value;
}

/** "cpu_fan" → "CPU fan", "mid_fan" → "Mid fan"; an unlabelled fan is just "Fan". */
const fanName = (raw: string | null) => {
  const t = (raw ?? "").trim().replace(/[_-]+/g, " ");
  return t ? (t[0]!.toUpperCase() + t.slice(1)).replace(/\b(cpu|gpu)\b/gi, (w) => w.toUpperCase()) : "Fan";
};

export function readFans(root = "/sys/class"): { label: string; rpm: number }[] {
  const out: { label: string; rpm: number }[] = [];
  const hw = join(root, "hwmon");
  let dirs: string[] = [];
  try {
    dirs = readdirSync(hw).sort(byNumber);
  } catch {}
  for (const d of dirs) {
    const base = join(hw, d);
    let files: string[] = [];
    try {
      files = readdirSync(base);
    } catch {
      continue;
    }
    for (const f of files.sort(byNumber)) {
      const m = /^fan(\d+)_input$/.exec(f);
      const rpm = m ? num(read(join(base, f))) : null;
      if (rpm != null) out.push({ label: fanName(read(join(base, `fan${m![1]}_label`))), rpm });
    }
  }
  return out.map((f, i) => (out.length > 1 && f.label === "Fan" ? { ...f, label: `Fan ${i + 1}` } : f));
}

export function readBattery(root = "/sys/class"): Battery | null {
  const dir = join(root, "power_supply");
  let names: string[] = [];
  try {
    names = readdirSync(dir).sort(byNumber);
  } catch {
    return null;
  }
  let bat: string | null = null;
  let mains = false;
  for (const n of names) {
    const p = join(dir, n);
    const type = read(join(p, "type"))?.trim();
    if (type === "Battery") {
      if (read(join(p, "scope"))?.trim() === "Device") continue; // a mouse or headset, not this machine
      bat ??= p;
    } else if ((type === "Mains" || (type === "USB" && !/source/i.test(n))) && num(read(join(p, "online"))) === 1) {
      mains = true;
    }
  }
  if (!bat) return null;
  const pct = num(read(join(bat, "capacity")));
  if (pct == null) return null;
  const status = read(join(bat, "status"))?.trim() || "Unknown";
  // Batteries report either energy (µWh, µW) or charge (µAh, µA) plus voltage (µV).
  const volts = (num(read(join(bat, "voltage_now"))) ?? num(read(join(bat, "voltage_min_design"))) ?? 0) / 1e6;
  const power = num(read(join(bat, "power_now")));
  const current = num(read(join(bat, "current_now")));
  const watts = power != null ? Math.abs(power) / 1e6 : current != null && volts ? (Math.abs(current) / 1e6) * volts : null;
  const wh = (energyFile: string, chargeFile: string) => {
    const e = num(read(join(bat!, energyFile)));
    if (e != null) return e / 1e6;
    const c = num(read(join(bat!, chargeFile)));
    return c != null && volts ? (c / 1e6) * volts : null;
  };
  const now = wh("energy_now", "charge_now");
  const full = wh("energy_full", "charge_full");
  const discharging = status === "Discharging";
  const charging = status === "Charging";
  let etaMin: number | null = null;
  if (watts != null && watts > 0.5 && now != null) {
    if (discharging) etaMin = (now / watts) * 60;
    else if (charging && full != null) etaMin = (Math.max(0, full - now) / watts) * 60;
  }
  const limit = num(read(join(bat, "charge_control_end_threshold")));
  return {
    pct,
    status,
    charging,
    discharging,
    plugged: mains || charging || status === "Full",
    watts: watts == null ? null : round1(watts),
    etaMin: etaMin != null && etaMin < 48 * 60 ? Math.round(etaMin) : null,
    limit: limit != null && limit < 100 ? limit : null,
  };
}

// ---------------------------------------------------------------- thresholds

/** When trouble counts as trouble. Adjustable on the System page; stored in the settings table. */
export type Thresholds = {
  /** Warn when a disk is this % full (critical 5 points higher). */
  diskPct: number;
  /** Warn when the CPU or GPU reaches this many °C (critical 7 degrees higher). */
  cpuTemp: number;
  /** Warn when less than this % of memory is available (critical at half of it). */
  memFreePct: number;
  /** Warn when the battery is at or below this % and discharging (critical at half of it). */
  batteryPct: number;
  /** A problem must last this many minutes before you're told (a critical one waits one at most). 0 = right away. */
  confirmMin: number;
};
export const DEFAULT_THRESHOLDS: Thresholds = { diskPct: 90, cpuTemp: 90, memFreePct: 10, batteryPct: 15, confirmMin: 2 };
export const THRESHOLD_LIMITS: Record<keyof Thresholds, { min: number; max: number }> = {
  diskPct: { min: 50, max: 98 },
  cpuTemp: { min: 60, max: 105 },
  memFreePct: { min: 2, max: 50 },
  batteryPct: { min: 5, max: 50 },
  confirmMin: { min: 0, max: 30 },
};

/** Whatever was stored (or sent), made safe: unknown keys dropped, bad values replaced by the default, the rest rounded and clamped. */
export function normalizeThresholds(raw: unknown): Thresholds {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_THRESHOLDS };
  for (const k of Object.keys(out) as (keyof Thresholds)[]) {
    const x = r[k];
    if (typeof x === "number" && Number.isFinite(x)) out[k] = clamp(Math.round(x), THRESHOLD_LIMITS[k].min, THRESHOLD_LIMITS[k].max);
  }
  return out;
}

let thresholds = normalizeThresholds(getSetting("health.thresholds", {}));
export const getThresholds = () => thresholds;

/** Saves a change (any subset of the fields) and re-checks the machine right away, so the page shows the effect at once. */
export function setThresholds(patch: Partial<Thresholds>): Thresholds {
  thresholds = normalizeThresholds({ ...thresholds, ...patch });
  setSetting("health.thresholds", thresholds);
  if (supported && last) {
    try {
      step(takeSample());
    } catch {}
  }
  return thresholds;
}

/** What the settings form needs: the current values, the defaults and the allowed ranges. */
export const thresholdsView = () => ({ values: thresholds, defaults: DEFAULT_THRESHOLDS, limits: THRESHOLD_LIMITS });

/** CPU and GPU limits follow the setting; every other sensor keeps what its own chip says. */
export function limitsFor(s: Pick<SensorDef, "kind" | "warn" | "crit">, th: Thresholds = thresholds): [warn: number, crit: number] {
  return s.kind === "cpu" || s.kind === "gpu" ? [th.cpuTemp, th.cpuTemp + 7] : [s.warn, s.crit];
}

// ------------------------------------------------------------------ sampling

let prevCpu: { all: CpuTimes; cores: CpuTimes[] } | null = null;
let cpuModel: string | null = null;
let last: Sample | null = null;
let lastIssues: Issue[] = [];
let sensors: SensorDef[] = [];
let sensorsAt = -Infinity;
let mounts: Mount[] = [];
let mountsAt = -Infinity;
let disks: Disk[] = [];
let disksAt = -Infinity;

/** Reads everything once. The first call only primes the CPU counters (usage needs two readings). */
export function takeSample(at = now()): Sample {
  const st = parseStat(read("/proc/stat") ?? "");
  let pct: number | null = null;
  let cores: number[] = [];
  if (st.all) {
    if (prevCpu) {
      pct = cpuPct(prevCpu.all, st.all);
      if (prevCpu.cores.length === st.cores.length) cores = st.cores.map((c, i) => cpuPct(prevCpu!.cores[i]!, c) ?? 0);
    }
    prevCpu = { all: st.all, cores: st.cores };
  }
  cpuModel ??= /^model name\s*:\s*(.+)$/m.exec(read("/proc/cpuinfo") ?? "")?.[1]?.trim() ?? "";
  const load = (read("/proc/loadavg") ?? "").split(" ").slice(0, 3).map(Number);
  const mem = parseMeminfo(read("/proc/meminfo") ?? "");

  if (at - sensorsAt >= SENSORS_MS) {
    sensors = discoverSensors();
    sensorsAt = at;
  }
  const temps: Temp[] = [];
  for (const s of sensors) {
    const c = readSensor(s, at);
    if (c != null) {
      const [warn, crit] = limitsFor(s);
      temps.push({ id: s.id, label: s.label, kind: s.kind, c, warn, crit });
    }
  }

  if (at - mountsAt >= MOUNTS_MS) {
    mounts = parseMounts(read("/proc/self/mountinfo") ?? "");
    if (!mounts.length) mounts = [{ mount: "/", device: "root", fs: "unknown" }]; // a container's overlay root, say
    mountsAt = at;
    disksAt = -Infinity;
  }
  if (at - disksAt >= DISK_MS) {
    disks = mounts.map(diskOf).filter((d): d is Disk => !!d);
    disksAt = at;
  }

  last = {
    at,
    host: hostname(),
    uptime: Math.round(num((read("/proc/uptime") ?? "").split(" ")[0] ?? null) ?? 0),
    cpu: {
      pct,
      cores,
      threads: st.cores.length,
      model: cpuModel,
      load: [load[0] || 0, load[1] || 0, load[2] || 0],
      pressure: parsePressure(read("/proc/pressure/cpu")),
    },
    mem: { ...mem, pct: mem.total ? round1((100 * mem.used) / mem.total) : 0, pressure: parsePressure(read("/proc/pressure/memory")) },
    temps,
    fans: readFans(),
    disks,
    battery: readBattery(),
  };
  return last;
}

/** The hottest CPU/GPU reading (what throttles first), else the hottest of whatever there is. */
export function hottest(temps: Temp[]): number | null {
  const main = temps.filter((t) => t.kind === "cpu" || t.kind === "gpu");
  const pool = main.length ? main : temps;
  return pool.length ? Math.max(...pool.map((t) => t.c)) : null;
}

// -------------------------------------------------------------------- issues

/** What's wrong right now. Deliberately no "CPU is busy" rule: builds and agents are meant to use the CPU. */
export function issuesOf(s: Sample, th: Thresholds = thresholds): Issue[] {
  const out: Issue[] = [];
  for (const d of s.disks) {
    const lowRoom = d.total > 50 * 1024 ** 3 && d.avail < 5 * 1024 ** 3;
    if (d.pct >= Math.min(99, th.diskPct + 5)) out.push({ id: `disk:${d.mount}`, level: "crit", title: `Disk ${d.mount} is almost full (${Math.round(d.pct)}%)`, detail: `${gb(d.avail)} left of ${gb(d.total)}. Agents and builds will start failing.` });
    else if (d.pct >= th.diskPct || lowRoom) out.push({ id: `disk:${d.mount}`, level: "warn", title: `Disk ${d.mount} is ${Math.round(d.pct)}% full`, detail: `${gb(d.avail)} left of ${gb(d.total)}.` });
  }
  for (const t of s.temps) {
    if (t.c >= t.crit) out.push({ id: `temp:${t.id}`, level: "crit", title: `${t.label} is very hot (${Math.round(t.c)}°C)`, detail: `Close to its limit of ${Math.round(t.crit)}°C. It will slow down or shut off to protect itself.` });
    else if (t.c >= t.warn) out.push({ id: `temp:${t.id}`, level: "warn", title: `${t.label} is running hot (${Math.round(t.c)}°C)`, detail: `Over ${Math.round(t.warn)}°C. It may slow down to cool off.` });
  }
  if (s.mem.total) {
    const free = (100 * s.mem.available) / s.mem.total;
    if (free < th.memFreePct / 2) out.push({ id: "mem", level: "crit", title: "Memory is nearly full", detail: `Only ${gb(s.mem.available)} of ${gb(s.mem.total)} is available. The system may start killing processes.` });
    else if (free < th.memFreePct) out.push({ id: "mem", level: "warn", title: "Memory is running low", detail: `Only ${gb(s.mem.available)} of ${gb(s.mem.total)} is available.` });
  }
  const b = s.battery;
  if (b && b.discharging && b.pct <= th.batteryPct) {
    out.push({
      id: "battery",
      level: b.pct <= Math.floor(th.batteryPct / 2) ? "crit" : "warn",
      title: `Battery at ${b.pct}%`,
      detail: `On battery${b.etaMin ? `, about ${duration(b.etaMin)} left` : ""}. Agents stop if the laptop shuts down.`,
    });
  }
  return out;
}

export const levelOf = (issues: Issue[]): Level => (issues.some((i) => i.level === "crit") ? "crit" : issues.length ? "warn" : "ok");

// -------------------------------------------------------------------- alerts

type Sent = Record<string, { at: number; level: "warn" | "crit" }>;
export type AlertStore = { load(): Sent; save(v: Sent): void };
const settingsStore: AlertStore = { load: () => getSetting<Sent>("health.alerted", {}), save: (v) => setSetting("health.alerted", v) };

/**
 * Decides which issues become a push. A condition must hold for `confirmMs` without a gap
 * (a compile heating the CPU for 30 s isn't news, and a suspend/resume restarts the clock;
 * a critical one waits at most a minute), is then sent once, and again only if it gets worse (warn → crit) or `cooldownMs` later.
 * What was sent is remembered in the database so a restart doesn't repeat it.
 */
export function createAlerter(o: { send: (i: Issue) => void; store?: AlertStore; confirmMs?: number | (() => number); cooldownMs?: number }) {
  const confirmOf = (): number => (typeof o.confirmMs === "function" ? o.confirmMs() : (o.confirmMs ?? 2 * 60_000));
  const cooldownMs = o.cooldownMs ?? 6 * 3600_000;
  const store = o.store ?? settingsStore;
  const sent = store.load();
  const since = new Map<string, number>();
  let lastAt = 0;
  return {
    feed(issues: Issue[], at: number) {
      if (at - lastAt > 6 * SAMPLE_MS) since.clear();
      lastAt = at;
      const present = new Set(issues.map((i) => i.id));
      for (const id of [...since.keys()]) if (!present.has(id)) since.delete(id);
      for (const i of issues) {
        const t = since.get(i.id) ?? at;
        since.set(i.id, t);
        if (at - t < (i.level === "crit" ? Math.min(confirmOf(), 60_000) : confirmOf())) continue;
        const s = sent[i.id];
        const worse = s?.level === "warn" && i.level === "crit";
        if (s && !worse && at - s.at < cooldownMs) continue;
        sent[i.id] = { at, level: i.level };
        for (const [id, v] of Object.entries(sent)) if (at - v.at > 30 * 24 * 3600_000) delete sent[id];
        store.save(sent);
        o.send(i);
      }
    },
  };
}

const alerter = createAlerter({
  confirmMs: () => thresholds.confirmMin * 60_000,
  send: (i) => void notify("system", { title: i.title, body: i.detail, url: "/system", tag: `sys-${i.id}` }).catch(() => {}),
});

// ------------------------------------------------------------------- history

export const RANGES = {
  "1h": { span: 3600_000, step: 60_000 },
  "6h": { span: 6 * 3600_000, step: 5 * 60_000 },
  "24h": { span: 24 * 3600_000, step: 15 * 60_000 },
  "7d": { span: 7 * 24 * 3600_000, step: 3600_000 },
} as const;
export type RangeId = keyof typeof RANGES;
export const isRange = (r: unknown): r is RangeId => typeof r === "string" && r in RANGES;

type Acc = { minute: number; n: number; cpu: number; cpuN: number; cpuMax: number; mem: number; temp: number | null; load: number; disk: number | null };
let acc: Acc | null = null;
let prunedAt = 0;

function flush(a: Acc) {
  if (!a.n) return;
  db.query("INSERT OR REPLACE INTO health_samples (ts, cpu, cpu_max, mem, temp, load, disk) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    a.minute,
    a.cpuN ? round1(a.cpu / a.cpuN) : null,
    a.cpuN ? a.cpuMax : null,
    round1(a.mem / a.n),
    a.temp,
    round1(a.load / a.n),
    a.disk,
  );
  if (a.minute - prunedAt > 3600_000) {
    prunedAt = a.minute;
    db.query("DELETE FROM health_samples WHERE ts < ?").run(a.minute - KEEP_MS);
  }
}

/** Folds a sample into the current minute; a finished minute becomes one row. */
export function recordSample(s: Sample) {
  const minute = Math.floor(s.at / 60_000) * 60_000;
  if (acc && acc.minute !== minute) {
    flush(acc);
    acc = null;
  }
  acc ??= { minute, n: 0, cpu: 0, cpuN: 0, cpuMax: 0, mem: 0, temp: null, load: 0, disk: null };
  acc.n++;
  if (s.cpu.pct != null) {
    acc.cpu += s.cpu.pct;
    acc.cpuN++;
    acc.cpuMax = Math.max(acc.cpuMax, s.cpu.pct);
  }
  acc.mem += s.mem.pct;
  acc.load += s.cpu.load[0];
  const t = hottest(s.temps);
  if (t != null) acc.temp = Math.max(acc.temp ?? t, t);
  const worstDisk = s.disks.length ? Math.max(...s.disks.map((d) => d.pct)) : null;
  if (worstDisk != null) acc.disk = Math.max(acc.disk ?? worstDisk, worstDisk);
}

export type HistoryPoint = { t: number; cpu: number | null; cpuMax: number | null; mem: number | null; temp: number | null; load: number | null; disk: number | null };

export function history(range: RangeId, at = now()): { range: RangeId; step: number; from: number; points: HistoryPoint[] } {
  const { span, step } = RANGES[range];
  const from = at - span;
  const rows = db
    .query(
      `SELECT (ts / ?) * ? AS t, AVG(cpu) AS cpu, MAX(cpu_max) AS cpuMax, AVG(mem) AS mem, MAX(temp) AS temp, AVG(load) AS load, MAX(disk) AS disk
       FROM health_samples WHERE ts >= ? GROUP BY t ORDER BY t`,
    )
    .all(step, step, from) as Record<keyof HistoryPoint, number | null>[];
  const r = (n: number | null) => (n == null ? null : round1(n));
  return {
    range,
    step,
    from,
    points: rows.map((x) => ({ t: x.t!, cpu: r(x.cpu), cpuMax: r(x.cpuMax), mem: r(x.mem), temp: r(x.temp), load: r(x.load), disk: r(x.disk) })),
  };
}

// ------------------------------------------------------------------ the loop

let lastSig = "";
let lastEmit = 0;
let lastErr = 0;

function step(s: Sample) {
  lastIssues = issuesOf(s);
  alerter.feed(lastIssues, s.at);
  recordSample(s);
  const sig = lastIssues.map((i) => `${i.id}:${i.level}`).join("|");
  if (sig !== lastSig || s.at - lastEmit >= EMIT_MS) {
    lastSig = sig;
    lastEmit = s.at;
    emit("health");
  }
}

export function startHealthLoop() {
  if (!supported) return;
  takeSample(); // primes the CPU counters
  const tick = () => {
    try {
      step(takeSample());
    } catch (e) {
      if (Date.now() - lastErr > 60_000) {
        lastErr = Date.now();
        console.error("[ansai] system monitor:", e);
      }
    }
  };
  setTimeout(tick, 1000);
  setInterval(tick, SAMPLE_MS);
}

/** What the live page shows. */
export function systemNow(): { supported: boolean; sample: Sample | null; issues: Issue[]; level: Level; thresholds: Thresholds } {
  if (!supported) return { supported: false, sample: null, issues: [], level: "ok", thresholds };
  const sample = last ?? takeSample();
  const issues = last ? lastIssues : issuesOf(sample);
  return { supported: true, sample, issues, level: levelOf(issues), thresholds };
}

/** Sends a real "system" push to every device that has these alerts on, so you can see one arrive. Returns how many devices that is. */
export async function testAlert(): Promise<{ devices: number }> {
  const subs = db.query("SELECT prefs FROM push_subs").all() as { prefs: string }[];
  const devices = subs.filter((r) => JSON.parse(r.prefs).system !== false).length;
  if (devices) await notify("system", { title: "Test alert from your machine", body: `This is how a warning about ${hostname()} looks. Everything is fine.`, url: "/system", tag: "sys-test" });
  return { devices };
}

/** The small version pushed to every open page. */
export function healthSummary(): Summary | null {
  if (!last) return null;
  return {
    at: last.at,
    level: levelOf(lastIssues),
    issues: lastIssues,
    cpu: last.cpu.pct,
    mem: last.mem.pct,
    temp: hottest(last.temps),
    disk: last.disks.length ? Math.max(...last.disks.map((d) => d.pct)) : null,
    battery: last.battery ? { pct: last.battery.pct, plugged: last.battery.plugged } : null,
  };
}

// ----------------------------------------------------------------- processes

export type Proc = { pid: number; ppid: number; comm: string; ticks: number; rss: number };
const CLK_TCK = 100; // USER_HZ: 100 on every Linux ansai runs on
let pageBytes = 0;
const pageSize = () => (pageBytes ||= Number(new TextDecoder().decode(Bun.spawnSync(["getconf", "PAGESIZE"]).stdout).trim()) || 4096);

/**
 * One /proc/<pid>/stat line. The command name sits in parentheses and may itself contain
 * spaces and parentheses, so everything is read relative to the LAST ")".
 */
export function parseProcStat(pid: number, text: string, page: number): Proc | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const f = text.slice(close + 2).split(" ");
  const ppid = Number(f[1]);
  const ticks = Number(f[11]) + Number(f[12]);
  const rss = Number(f[21]) * page;
  if ([ppid, ticks, rss].some(Number.isNaN)) return null;
  return { pid, ppid, comm: text.slice(open + 1, close), ticks, rss };
}

/** Which root (an agent's tmux pane, or ansai itself) each process descends from; null if none. */
export function attribute(procs: Proc[], roots: Map<number, string>): Map<number, string | null> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const owner = new Map<number, string | null>();
  const find = (pid: number, depth = 0): string | null => {
    if (owner.has(pid)) return owner.get(pid)!;
    let r = roots.get(pid) ?? null;
    const p = byPid.get(pid);
    if (r == null && p && p.ppid > 1 && depth < 64) r = find(p.ppid, depth + 1);
    owner.set(pid, r);
    return r;
  };
  for (const p of procs) find(p.pid);
  return owner;
}

const INTERPRETERS = /^(node|nodejs|bun|deno|python[\d.]*|ruby|perl|java|php)$/;

/** A readable name: the command, plus the script for interpreters. Flags and other arguments (tokens!) are never shown. */
export function shortCmd(comm: string, cmdline: string | null): string {
  if (!cmdline || !INTERPRETERS.test(comm)) return comm;
  const script = cmdline.split("\0").slice(1).find((a) => a && !a.startsWith("-"));
  const name = script ? `${comm} ${basename(script)}` : comm;
  return name.length > 60 ? `${name.slice(0, 59)}…` : name;
}

type Snap = { at: number; procs: Map<number, Proc> };
function snap(): Snap {
  const procs = new Map<number, Proc>();
  let pids: string[] = [];
  try {
    pids = readdirSync("/proc");
  } catch {}
  const page = pageSize();
  for (const p of pids) {
    if (!/^\d+$/.test(p)) continue;
    const t = read(`/proc/${p}/stat`);
    const pr = t ? parseProcStat(Number(p), t, page) : null;
    if (pr) procs.set(pr.pid, pr);
  }
  return { at: Date.now(), procs };
}

async function paneRoots(): Promise<Map<string, number[]>> {
  const bySession = new Map<string, number[]>();
  try {
    const p = Bun.spawn([...tmuxBase(), "list-panes", "-a", "-F", "#{session_name} #{pane_pid}"], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: cleanEnv() });
    const out = await new Response(p.stdout).text();
    await p.exited;
    for (const line of out.split("\n")) {
      const i = line.lastIndexOf(" ");
      const pid = Number(line.slice(i + 1));
      if (i > 0 && pid > 0) bySession.set(line.slice(0, i), [...(bySession.get(line.slice(0, i)) ?? []), pid]);
    }
  } catch {}
  return bySession;
}

export type ProcRow = { pid: number; name: string; cpu: number; rss: number; agent: string | null };
export type AgentUse = { id: string; title: string; tool: string; project: string | null; cpu: number; rss: number; procs: number };
export type Procs = { at: number; cores: number; agents: AgentUse[]; ansai: { cpu: number; rss: number; procs: number }; topCpu: ProcRow[]; topMem: ProcRow[] };

let prevSnap: Snap | null = null;
let procsCache: Procs | null = null;
const SELF = "#ansai";

/**
 * Who is using the machine: per agent session (everything under its tmux pane), ansai
 * itself, and the busiest single processes. CPU is a share of one core, like `top`
 * (200 = two cores), measured over the time since the previous call. Memory is RSS,
 * which counts pages shared between processes more than once, so sums are approximate.
 */
export async function processes(): Promise<Procs> {
  const t = Date.now();
  if (procsCache && t - procsCache.at < 1500) return procsCache;
  let before = prevSnap && t - prevSnap.at < 60_000 ? prevSnap : null;
  if (!before) {
    before = snap();
    await Bun.sleep(400);
  }
  const after = snap();
  prevSnap = after;
  const secs = Math.max(0.05, (after.at - before.at) / 1000);
  const cpuOf = (p: Proc) => Math.max(0, p.ticks - (before!.procs.get(p.pid)?.ticks ?? 0)) / CLK_TCK / secs * 100;

  const sessions = db
    .query(`SELECT s.tmux_name, s.id, s.title, s.tool, p.name AS project FROM sessions s LEFT JOIN projects p ON p.id = s.project_id WHERE s.status = 'running'`)
    .all() as { tmux_name: string; id: string; title: string; tool: string; project: string | null }[];
  const byName = new Map(sessions.map((s) => [s.tmux_name, s]));
  const panes = await paneRoots();
  const roots = new Map<number, string>([[process.pid, SELF]]);
  for (const [name, pids] of panes) for (const pid of pids) roots.set(pid, name);

  const all = [...after.procs.values()];
  const owner = attribute(all, roots);
  const use = new Map<string, { cpu: number; rss: number; procs: number }>();
  for (const p of all) {
    const o = owner.get(p.pid);
    if (!o) continue;
    const u = use.get(o) ?? { cpu: 0, rss: 0, procs: 0 };
    u.cpu += cpuOf(p);
    u.rss += p.rss;
    u.procs++;
    use.set(o, u);
  }
  const agents: AgentUse[] = [];
  for (const [name, u] of use) {
    const s = byName.get(name);
    if (s) agents.push({ id: s.id, title: s.title, tool: s.tool, project: s.project, cpu: round1(u.cpu), rss: u.rss, procs: u.procs });
  }
  const me = use.get(SELF) ?? { cpu: 0, rss: 0, procs: 0 };

  const label = (pid: number) => {
    const o = owner.get(pid);
    return o === SELF ? "ansai" : o ? (byName.get(o)?.title ?? null) : null;
  };
  const row = (p: Proc): ProcRow => ({
    pid: p.pid,
    name: shortCmd(p.comm, read(`/proc/${p.pid}/cmdline`)),
    cpu: round1(cpuOf(p)),
    rss: p.rss,
    agent: label(p.pid),
  });
  const topCpu = all.map((p) => [p, cpuOf(p)] as const).filter(([, c]) => c >= 0.1).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p]) => row(p));
  const topMem = [...all].sort((a, b) => b.rss - a.rss).slice(0, 5).map(row);

  procsCache = {
    at: after.at,
    cores: last?.cpu.threads || navigator.hardwareConcurrency || 1,
    agents: agents.sort((a, b) => b.cpu - a.cpu || b.rss - a.rss),
    ansai: { cpu: round1(me.cpu), rss: me.rss, procs: me.procs },
    topCpu,
    topMem,
  };
  return procsCache;
}
