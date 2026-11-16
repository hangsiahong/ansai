// System monitor: parsers (against lines a real kernel produced), sensor discovery on a fake sysfs, alerts, history, process attribution.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { db } = await import("./db");
const h = await import("./health");

const fixture = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(process.env.ANSAI_HOME!, "sys-")); // removed with the test home
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

// ------------------------------------------------------------------- /proc

test("cpu usage is the busy share between two readings, idle counting iowait", () => {
  const stat = `cpu  79359704 15545121 17440949 1603279894 1550463 4089015 916403 0 3 54330
cpu0 4690712 752482 957641 65241556 89084 180014 68226 0 0 3304
cpu1 4844325 803996 949892 65078213 92890 160237 46046 0 0 2530
intr 1 2 3`;
  const a = h.parseStat(stat);
  expect(a.cores).toHaveLength(2);
  expect(a.all).toEqual({ total: 79359704 + 15545121 + 17440949 + 1603279894 + 1550463 + 4089015 + 916403, busy: 79359704 + 15545121 + 17440949 + 4089015 + 916403 });
  // 100 ticks pass: 25 busy, 70 idle, 5 iowait (idle too)
  const b = { total: a.all!.total + 100, busy: a.all!.busy + 25 };
  expect(h.cpuPct(a.all!, b)).toBe(25);
  expect(h.cpuPct(a.all!, a.all!)).toBeNull(); // no time passed
  expect(h.cpuPct(a.all!, { total: a.all!.total + 10, busy: a.all!.busy - 5 })).toBe(0); // never negative
});

test("memory uses MemAvailable, not MemFree, and swap is what is in use", () => {
  const m = h.parseMeminfo(`MemTotal:       31937040 kB
MemFree:         1000000 kB
MemAvailable:   14923436 kB
Buffers:           10000 kB
Cached:         20000000 kB
SwapTotal:      31936508 kB
SwapFree:       12652968 kB`);
  expect(m.total).toBe(31937040 * 1024);
  expect(m.available).toBe(14923436 * 1024);
  expect(m.used).toBe(m.total - m.available);
  expect(m.swapUsed).toBe((31936508 - 12652968) * 1024);
  // Old kernels have no MemAvailable
  expect(h.parseMeminfo("MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 150 kB\n").available).toBe(300 * 1024);
});

test("pressure stall lines", () => {
  expect(h.parsePressure("some avg10=0.04 avg60=0.07 avg300=0.06 total=7310101867\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n")).toEqual({ avg10: 0.04, avg60: 0.07, avg300: 0.06 });
  expect(h.parsePressure(null)).toBeNull();
  expect(h.parsePressure("")).toBeNull();
});

const MOUNTINFO = `40 1 0:34 /@ / rw,noatime shared:1 - btrfs /dev/nvme0n1p9 rw,compress=zstd:1,ssd,subvolid=256,subvol=/@
60 40 0:34 /@home /home rw,noatime shared:191 - btrfs /dev/nvme0n1p9 rw,compress=zstd:1,ssd,subvolid=257,subvol=/@home
263 40 0:34 /@log /var/log rw,noatime shared:227 - btrfs /dev/nvme0n1p9 rw,compress=zstd:1,ssd,subvolid=262,subvol=/@log
269 40 259:8 / /boot rw,relatime shared:233 - vfat /dev/nvme0n1p8 rw,fmask=0077,errors=remount-ro
346 289 0:93 / /run/user/1000/psd/x rw,nosuid shared:802 - fuse.fuse-overlayfs fuse-overlayfs rw,user_id=1000
20 40 0:19 / /dev/shm rw,nosuid,nodev shared:3 - tmpfs tmpfs rw
500 40 8:17 / /mnt/My\\040Disk rw,relatime - ext4 /dev/sdb1 rw
501 40 7:1 / /snap/core/1 ro,nodev - squashfs /dev/loop1 ro
502 40 8:33 / /var/lib/docker/btrfs rw - btrfs /dev/sdc1 rw`;

test("disks: real filesystems only, one row per device, '/' first, escapes decoded", () => {
  expect(h.parseMounts(MOUNTINFO)).toEqual([
    { mount: "/", device: "/dev/nvme0n1p9", fs: "btrfs" },
    { mount: "/boot", device: "/dev/nvme0n1p8", fs: "vfat" },
    { mount: "/mnt/My Disk", device: "/dev/sdb1", fs: "ext4" },
  ]);
  // The shortest mount stands for a device when "/" isn't one of them
  expect(h.parseMounts("1 0 8:1 / /data/deep/er rw - ext4 /dev/sda1 rw\n2 0 8:1 / /data rw - ext4 /dev/sda1 rw\n")).toEqual([{ mount: "/data", device: "/dev/sda1", fs: "ext4" }]);
});

// ------------------------------------------------------------------- sensors

test("only the sensors that mean something are picked", () => {
  const c = h.classifySensor;
  expect(c("k10temp", "Tctl", 1)).toEqual({ name: "CPU", kind: "cpu" });
  expect(c("k10temp", "Tccd1", 3)).toBeNull();
  expect(c("coretemp", "Package id 0", 1)).toEqual({ name: "CPU", kind: "cpu" });
  expect(c("coretemp", "Core 3", 5)).toBeNull();
  expect(c("amdgpu", "edge", 1)).toEqual({ name: "GPU", kind: "gpu" });
  expect(c("amdgpu", "mem", 3)).toBeNull();
  expect(c("nvme", "Composite", 1)).toEqual({ name: "NVMe", kind: "nvme" });
  expect(c("nvme", "Sensor 1", 2)).toBeNull(); // reports its own limit (65 kC) as a reading
  expect(c("mt7925_phy0", "", 1)).toEqual({ name: "Wi-Fi", kind: "wifi" });
  expect(c("iwlwifi_1", "", 1)).toEqual({ name: "Wi-Fi", kind: "wifi" });
  expect(c("acpitz", "", 1)).toEqual({ name: "Board", kind: "board" });
  expect(c("acpitz", "", 2)).toBeNull();
  expect(c("BAT1", "", 1)).toBeNull();
});

test("sensors are discovered with the chip's own limits, and Tdie beats Tctl", () => {
  const root = fixture({
    "hwmon/hwmon2/name": "acpitz\n",
    "hwmon/hwmon2/temp1_input": "43000\n",
    "hwmon/hwmon2/temp2_input": "20000\n",
    "hwmon/hwmon4/name": "nvme\n",
    "hwmon/hwmon4/temp1_input": "35850\n",
    "hwmon/hwmon4/temp1_label": "Composite\n",
    "hwmon/hwmon4/temp1_max": "85000\n",
    "hwmon/hwmon4/temp1_crit": "88000\n",
    "hwmon/hwmon4/temp2_input": "35850\n",
    "hwmon/hwmon4/temp2_label": "Sensor 1\n",
    "hwmon/hwmon4/temp2_max": "65261850\n",
    "hwmon/hwmon10/name": "nvme\n",
    "hwmon/hwmon10/temp1_input": "40000\n",
    "hwmon/hwmon10/temp1_label": "Composite\n",
    "hwmon/hwmon6/name": "k10temp\n",
    "hwmon/hwmon6/temp1_input": "43500\n",
    "hwmon/hwmon6/temp1_label": "Tctl\n",
    "hwmon/hwmon6/temp2_input": "40500\n",
    "hwmon/hwmon6/temp2_label": "Tdie\n",
  });
  const s = h.discoverSensors(root);
  expect(s.map((x) => [x.id, x.label, x.kind])).toEqual([
    ["board", "Board", "board"],
    ["nvme", "NVMe", "nvme"],
    ["cpu", "CPU", "cpu"], // hwmon6 sorts before hwmon10, which is the second drive
    ["nvme-2", "NVMe 2", "nvme"],
  ]);
  const by = Object.fromEntries(s.map((x) => [x.id, x]));
  expect(by.cpu!.raw).toBe("Tdie");
  expect([by.cpu!.warn, by.cpu!.crit]).toEqual([90, 97]); // defaults: this chip reports no limits
  expect([by.nvme!.warn, by.nvme!.crit]).toEqual([80, 88]); // max - 5, crit
  expect(by.nvme!.slow).toBe(true);
  expect(by.cpu!.slow).toBe(false);
});

test("without hwmon CPU sensors a thermal zone stands in, and junk limits are ignored", () => {
  const root = fixture({
    "hwmon/hwmon0/name": "nvme\n",
    "hwmon/hwmon0/temp1_input": "30000\n",
    "hwmon/hwmon0/temp1_label": "Composite\n",
    "hwmon/hwmon0/temp1_max": "65261850\n", // 65 kC: not a temperature
    "thermal/thermal_zone0/type": "cpu-thermal\n",
    "thermal/thermal_zone0/temp": "51000\n",
    "thermal/thermal_zone1/type": "gpu-thermal\n",
    "thermal/thermal_zone1/temp": "49000\n",
  });
  const s = h.discoverSensors(root);
  expect(s.map((x) => x.id)).toEqual(["nvme", "cpu"]);
  expect([s[0]!.warn, s[0]!.crit]).toEqual([75, 85]);
  expect(s[1]!.path.endsWith("thermal_zone0/temp")).toBe(true);
  expect(h.discoverSensors(fixture({ "x/y": "" }))).toEqual([]); // no sensors at all is fine
});

test("a reading must be plausible, and a sleeping device is left alone", () => {
  const root = fixture({
    "hwmon/hwmon1/name": "amdgpu\n",
    "hwmon/hwmon1/temp1_input": "61500\n",
    "hwmon/hwmon1/temp1_label": "edge\n",
    "hwmon/hwmon1/device/power/runtime_status": "active\n",
  });
  const [gpu] = h.discoverSensors(root);
  expect(h.readSensor(gpu!, 1_000)).toBe(61.5);
  writeFileSync(gpu!.path, "-274000\n");
  expect(h.readSensor(gpu!, 2_000)).toBeNull();
  writeFileSync(gpu!.path, "61500\n");
  writeFileSync(gpu!.pm!, "suspended\n");
  expect(h.readSensor(gpu!, 3_000)).toBeNull(); // not read: that would wake the GPU
  writeFileSync(gpu!.pm!, "active\n");
  expect(h.readSensor(gpu!, 4_000)).toBe(61.5);
});

test("slow sensors are read at most every 30 s", () => {
  const root = fixture({ "hwmon/hwmon0/name": "nvme\n", "hwmon/hwmon0/temp1_input": "30000\n", "hwmon/hwmon0/temp1_label": "Composite\n" });
  const [ssd] = h.discoverSensors(root);
  expect(h.readSensor(ssd!, 100_000)).toBe(30);
  writeFileSync(ssd!.path, "55000\n");
  expect(h.readSensor(ssd!, 110_000)).toBe(30); // cached
  expect(h.readSensor(ssd!, 131_000)).toBe(55);
});

test("fans", () => {
  const root = fixture({ "hwmon/hwmon1/name": "acpi_fan\n", "hwmon/hwmon1/fan1_input": "0\n", "hwmon/hwmon2/name": "x\n", "hwmon/hwmon2/fan1_input": "2400\n", "hwmon/hwmon2/fan1_label": "CPU fan\n" });
  expect(h.readFans(root)).toEqual([{ label: "Fan 1", rpm: 0 }, { label: "CPU fan", rpm: 2400 }]);
  const asus = fixture({ "hwmon/hwmon7/name": "asus\n", "hwmon/hwmon7/fan1_input": "3700\n", "hwmon/hwmon7/fan1_label": "mid_fan\n", "hwmon/hwmon7/fan2_input": "2400\n", "hwmon/hwmon7/fan2_label": "gpu_fan\n" });
  expect(h.readFans(asus)).toEqual([{ label: "Mid fan", rpm: 3700 }, { label: "GPU fan", rpm: 2400 }]);
});

// ------------------------------------------------------------------- battery

test("a battery held at its charge limit is plugged in but not charging", () => {
  // The files this laptop actually has: charge (µAh) and current/voltage, no energy or power.
  const root = fixture({
    "power_supply/ACAD/type": "Mains\n",
    "power_supply/ACAD/online": "1\n",
    "power_supply/BAT1/type": "Battery\n",
    "power_supply/BAT1/capacity": "80\n",
    "power_supply/BAT1/status": "Not charging\n",
    "power_supply/BAT1/charge_now": "3460000\n",
    "power_supply/BAT1/charge_full": "4351000\n",
    "power_supply/BAT1/current_now": "0\n",
    "power_supply/BAT1/voltage_now": "16782000\n",
    "power_supply/BAT1/charge_control_end_threshold": "80\n",
    "power_supply/ucsi-source-psy-USBC000:001/type": "USB\n",
    "power_supply/ucsi-source-psy-USBC000:001/online": "1\n",
  });
  expect(h.readBattery(root)).toEqual({ pct: 80, status: "Not charging", charging: false, discharging: false, plugged: true, watts: 0, etaMin: null, limit: 80 });
});

test("on battery: draw and time left, from energy files or charge files", () => {
  const energy = fixture({
    "power_supply/BAT0/type": "Battery\n",
    "power_supply/BAT0/capacity": "50\n",
    "power_supply/BAT0/status": "Discharging\n",
    "power_supply/BAT0/energy_now": "30000000\n", // 30 Wh
    "power_supply/BAT0/energy_full": "60000000\n",
    "power_supply/BAT0/power_now": "15000000\n", // 15 W
    "power_supply/AC/type": "Mains\n",
    "power_supply/AC/online": "0\n",
  });
  expect(h.readBattery(energy)).toMatchObject({ pct: 50, discharging: true, plugged: false, watts: 15, etaMin: 120, limit: null });
  const charge = fixture({
    "power_supply/BAT0/type": "Battery\n",
    "power_supply/BAT0/capacity": "40\n",
    "power_supply/BAT0/status": "Discharging\n",
    "power_supply/BAT0/charge_now": "2000000\n", // 2 Ah at 10 V = 20 Wh
    "power_supply/BAT0/current_now": "1000000\n", // 1 A = 10 W
    "power_supply/BAT0/voltage_now": "10000000\n",
  });
  expect(h.readBattery(charge)).toMatchObject({ watts: 10, etaMin: 120 });
});

test("no battery, and a headset's battery, mean no battery", () => {
  expect(h.readBattery(fixture({ "x/y": "" }))).toBeNull();
  const headset = fixture({ "power_supply/hid-1/type": "Battery\n", "power_supply/hid-1/scope": "Device\n", "power_supply/hid-1/capacity": "30\n" });
  expect(h.readBattery(headset)).toBeNull();
});

// ------------------------------------------------------------- clock and profile

test("clock: average and fastest core now, and the ceiling they are held to", () => {
  const cpu = (n: number, cur: number | null, max: number) => ({
    [`cpu${n}/cpufreq/scaling_max_freq`]: `${max}\n`,
    [`cpu${n}/cpufreq/cpuinfo_max_freq`]: "5100000\n",
    ...(cur == null ? {} : { [`cpu${n}/cpufreq/scaling_cur_freq`]: `${cur}\n` }),
  });
  // Values as the kernel gives them: kHz. cpu2 is offline (no scaling_cur_freq).
  const root = fixture({ ...cpu(0, 1500000, 2000000), ...cpu(1, 1700000, 2000000), ...cpu(2, null, 2000000), "cpufreq/ignored": "", "cpuidle/x": "" });
  expect(h.readCpuSpeed(root)).toEqual({ avgMhz: 1600, maxMhz: 1700, limitMhz: 2000 });
  // Without a scaling_max_freq the hardware ceiling stands in
  const bare = fixture({ "cpu0/cpufreq/scaling_cur_freq": "800000\n", "cpu0/cpufreq/cpuinfo_max_freq": "3600000\n" });
  expect(h.readCpuSpeed(bare)).toEqual({ avgMhz: 800, maxMhz: 800, limitMhz: 3600 });
  expect(h.readCpuSpeed(fixture({ "x/y": "" }))).toBeNull(); // a VM without cpufreq
  expect(h.readCpuSpeed(join(process.env.ANSAI_HOME!, "nope"))).toBeNull();
});

test("power profile", () => {
  const root = fixture({ "platform_profile": "quiet\n", "platform_profile_choices": "quiet balanced performance\n" });
  expect(h.readPowerProfile(root)).toEqual({ current: "quiet", choices: ["quiet", "balanced", "performance"] });
  expect(h.readPowerProfile(fixture({ "platform_profile": "low-power\n" }))).toEqual({ current: "low-power", choices: [] });
  expect(h.readPowerProfile(fixture({ "x/y": "" }))).toBeNull(); // servers and VMs have none
});

// -------------------------------------------------------------------- issues

const GB = 1024 ** 3;
const sample = (over: Partial<import("./health").Sample> = {}): import("./health").Sample => ({
  at: 0,
  host: "t",
  uptime: 0,
  cpu: { pct: 10, cores: [], threads: 8, model: "", load: [1, 1, 1], pressure: null, speed: null },
  profile: null,
  mem: { total: 32 * GB, available: 16 * GB, used: 16 * GB, pct: 50, swapTotal: 0, swapUsed: 0, pressure: null },
  temps: [],
  fans: [],
  disks: [],
  battery: null,
  ...over,
});
const disk = (pct: number, total = 500 * GB, mount = "/") => ({ mount, device: "/dev/x", fs: "ext4", total, used: (total * pct) / 100, avail: (total * (100 - pct)) / 100, pct });

test("a healthy machine has no issues, and busy CPU alone is not one", () => {
  expect(h.issuesOf(sample({ cpu: { ...sample().cpu, pct: 100 }, disks: [disk(52)], temps: [{ id: "cpu", label: "CPU", kind: "cpu", c: 80, warn: 90, crit: 97 }] }))).toEqual([]);
});

test("disks warn at 90% and are critical at 95%, or when little room is left on a big disk", () => {
  expect(h.issuesOf(sample({ disks: [disk(89.9)] }))).toEqual([]);
  expect(h.issuesOf(sample({ disks: [disk(90)] }))[0]).toMatchObject({ id: "disk:/", level: "warn" });
  expect(h.issuesOf(sample({ disks: [disk(95)] }))[0]).toMatchObject({ id: "disk:/", level: "crit" });
  expect(h.issuesOf(sample({ disks: [disk(88, 40 * GB)] }))).toEqual([]); // 4.8 GB left, but a small disk
  expect(h.issuesOf(sample({ disks: [disk(99, 400 * GB, "/data")] }))[0]).toMatchObject({ id: "disk:/data", level: "crit" });
  expect(h.issuesOf(sample({ disks: [{ ...disk(80, 100 * GB), avail: 4 * GB }] }))[0]).toMatchObject({ level: "warn" });
});

test("temperatures use each sensor's own limits", () => {
  const t = (c: number, kind: "cpu" | "nvme" = "cpu") => sample({ temps: [{ id: kind, label: kind.toUpperCase(), kind, c, warn: kind === "cpu" ? 90 : 80, crit: kind === "cpu" ? 97 : 87 }] });
  expect(h.issuesOf(t(89.9))).toEqual([]);
  expect(h.issuesOf(t(92))[0]).toMatchObject({ id: "temp:cpu", level: "warn" });
  expect(h.issuesOf(t(97))[0]).toMatchObject({ level: "crit" });
  expect(h.issuesOf(t(82, "nvme"))[0]).toMatchObject({ id: "temp:nvme", level: "warn" }); // fine for a CPU, not for an SSD
});

test("memory is judged on what is available, not on swap", () => {
  const mem = (availGB: number) => sample({ mem: { total: 32 * GB, available: availGB * GB, used: (32 - availGB) * GB, pct: 0, swapTotal: 32 * GB, swapUsed: 30 * GB, pressure: null } });
  expect(h.issuesOf(mem(16))).toEqual([]); // swap nearly full, but plenty of RAM
  expect(h.issuesOf(mem(3))[0]).toMatchObject({ id: "mem", level: "warn" });
  expect(h.issuesOf(mem(1))[0]).toMatchObject({ id: "mem", level: "crit" });
});

test("battery matters only when discharging and low", () => {
  const b = (pct: number, discharging: boolean) => sample({ battery: { pct, status: "", charging: false, discharging, plugged: !discharging, watts: 10, etaMin: 40, limit: null } });
  expect(h.issuesOf(b(10, false))).toEqual([]);
  expect(h.issuesOf(b(40, true))).toEqual([]);
  expect(h.issuesOf(b(15, true))[0]).toMatchObject({ id: "battery", level: "warn" });
  expect(h.issuesOf(b(7, true))[0]).toMatchObject({ level: "crit" });
  expect(h.levelOf([])).toBe("ok");
  expect(h.levelOf(h.issuesOf(b(7, true)))).toBe("crit");
});

// -------------------------------------------------------------------- alerts

const MIN = 60_000;
const issue = (id: string, level: "warn" | "crit" = "warn") => ({ id, level, title: id, detail: "" });
function alerter(o: { confirmMs?: number; cooldownMs?: number; sent?: Record<string, { at: number; level: "warn" | "crit" }> } = {}) {
  const out: string[] = [];
  let saved = o.sent ?? {};
  const a = h.createAlerter({ send: (i) => out.push(`${i.id}:${i.level}`), confirmMs: o.confirmMs, cooldownMs: o.cooldownMs, store: { load: () => saved, save: (v) => (saved = JSON.parse(JSON.stringify(v))) } });
  return { a, out, saved: () => saved };
}
/** Feed the same issues every 5 s from `from` to `to`. */
const run = (a: ReturnType<typeof alerter>["a"], issues: ReturnType<typeof issue>[], from: number, to: number) => {
  for (let t = from; t <= to; t += 5_000) a.feed(issues, t);
};

test("an issue is pushed once it has lasted two minutes, and only once", () => {
  const { a, out } = alerter();
  run(a, [issue("temp:cpu")], 0, 100_000);
  expect(out).toEqual([]); // 100 s: a compile, not a problem
  run(a, [issue("temp:cpu")], 105_000, 130_000);
  expect(out).toEqual(["temp:cpu:warn"]);
  run(a, [issue("temp:cpu")], 135_000, 5 * 3600_000); // still hot for hours: no nagging
  expect(out).toEqual(["temp:cpu:warn"]);
});

test("a spike that cools off never alerts, and flapping around a threshold doesn't repeat", () => {
  const { a, out } = alerter();
  run(a, [issue("temp:cpu")], 0, 90_000);
  run(a, [], 95_000, 100_000); // cooled
  run(a, [issue("temp:cpu")], 105_000, 190_000); // the clock restarted
  expect(out).toEqual([]);
  run(a, [issue("temp:cpu")], 195_000, 230_000);
  expect(out).toEqual(["temp:cpu:warn"]);
  run(a, [], 235_000, 240_000);
  run(a, [issue("temp:cpu")], 245_000, 600_000);
  expect(out).toEqual(["temp:cpu:warn"]); // back within the 6 h cooldown
});

test("it repeats after the cooldown, and right away when it gets worse", () => {
  const { a, out } = alerter({ cooldownMs: 3600_000 });
  run(a, [issue("disk:/")], 0, 130_000);
  run(a, [issue("disk:/", "crit")], 135_000, 140_000);
  expect(out).toEqual(["disk:/:warn", "disk:/:crit"]);
  run(a, [issue("disk:/", "crit")], 145_000, 3600_000 + 130_000); // the crit went out at 135 s
  expect(out).toHaveLength(2);
  run(a, [issue("disk:/", "crit")], 3600_000 + 135_000, 3600_000 + 140_000);
  expect(out).toHaveLength(3);
  // crit then warn then crit again is not "worse": the cooldown holds
  run(a, [issue("disk:/")], 3600_000 + 150_000, 3600_000 + 200_000);
  run(a, [issue("disk:/", "crit")], 3600_000 + 205_000, 3600_000 + 400_000);
  expect(out).toHaveLength(3);
});

test("a gap in the samples (suspend) restarts the confirmation", () => {
  const { a, out } = alerter();
  run(a, [issue("mem")], 0, 100_000);
  a.feed([issue("mem")], 10 * MIN); // laptop slept; 100 s of heat before it is not 2 minutes after it
  expect(out).toEqual([]);
  run(a, [issue("mem")], 10 * MIN + 5_000, 10 * MIN + 100_000);
  expect(out).toEqual([]);
  run(a, [issue("mem")], 10 * MIN + 105_000, 10 * MIN + 125_000);
  expect(out).toEqual(["mem:warn"]);
});

test("what was sent survives a restart", () => {
  const first = alerter();
  run(first.a, [issue("mem")], 0, 130_000);
  expect(first.out).toEqual(["mem:warn"]);
  const second = alerter({ sent: first.saved() }); // a new process reading the same store
  run(second.a, [issue("mem")], 200_000, 400_000);
  expect(second.out).toEqual([]);
});

// ---------------------------------------------------------------- thresholds

test("thresholds are clamped, rounded and defaulted, whatever is stored", () => {
  const d = h.DEFAULT_THRESHOLDS;
  expect(h.normalizeThresholds(undefined)).toEqual(d);
  expect(h.normalizeThresholds("junk")).toEqual(d);
  expect(h.normalizeThresholds({ diskPct: 80.6, cpuTemp: 5, memFreePct: 999, batteryPct: "20", confirmMin: -3, extra: 1 })).toEqual({ ...d, diskPct: 81, cpuTemp: 60, memFreePct: 50, confirmMin: 0 });
  expect(h.normalizeThresholds({ diskPct: NaN, cpuTemp: Infinity })).toEqual(d);
});

test("the disk, memory and battery rules follow the thresholds", () => {
  const th = { ...h.DEFAULT_THRESHOLDS, diskPct: 80, memFreePct: 20, batteryPct: 30 };
  expect(h.issuesOf(sample({ disks: [disk(79)] }), th)).toEqual([]);
  expect(h.issuesOf(sample({ disks: [disk(80)] }), th)[0]).toMatchObject({ level: "warn" });
  expect(h.issuesOf(sample({ disks: [disk(85)] }), th)[0]).toMatchObject({ level: "crit" }); // 5 points above
  expect(h.issuesOf(sample({ disks: [disk(96)] }), { ...th, diskPct: 98 })[0]).toBeUndefined(); // looser than the default stays quiet
  const mem = (availGB: number) => sample({ mem: { total: 32 * GB, available: availGB * GB, used: 0, pct: 0, swapTotal: 0, swapUsed: 0, pressure: null } });
  expect(h.issuesOf(mem(7), th)).toEqual([]); // 21.9% free
  expect(h.issuesOf(mem(6), th)[0]).toMatchObject({ id: "mem", level: "warn" }); // 18.8%
  expect(h.issuesOf(mem(3), th)[0]).toMatchObject({ level: "crit" }); // 9.4%, under half of 20
  const bat = (pct: number) => sample({ battery: { pct, status: "", charging: false, discharging: true, plugged: false, watts: 10, etaMin: 40, limit: null } });
  expect(h.issuesOf(bat(31), th)).toEqual([]);
  expect(h.issuesOf(bat(30), th)[0]).toMatchObject({ level: "warn" });
  expect(h.issuesOf(bat(15), th)[0]).toMatchObject({ level: "crit" });
  // The defaults are what they were before they became settings
  expect(h.issuesOf(sample({ disks: [disk(90)] }))[0]).toMatchObject({ level: "warn" });
  expect(h.issuesOf(bat(15))[0]).toMatchObject({ level: "warn" });
  expect(h.issuesOf(bat(7))[0]).toMatchObject({ level: "crit" });
});

test("only CPU and GPU limits follow the temperature setting; other chips keep their own", () => {
  const th = { ...h.DEFAULT_THRESHOLDS, cpuTemp: 80 };
  expect(h.limitsFor({ kind: "cpu", warn: 90, crit: 97 }, th)).toEqual([80, 87]);
  expect(h.limitsFor({ kind: "gpu", warn: 90, crit: 100 }, th)).toEqual([80, 87]);
  expect(h.limitsFor({ kind: "nvme", warn: 75, crit: 85 }, th)).toEqual([75, 85]);
  expect(h.limitsFor({ kind: "board", warn: 80, crit: 95 }, th)).toEqual([80, 95]);
});

test("saving thresholds persists them, ignores nonsense and keeps what wasn't sent", () => {
  try {
    expect(h.getThresholds()).toEqual(h.DEFAULT_THRESHOLDS);
    expect(h.setThresholds({ cpuTemp: 75 })).toEqual({ ...h.DEFAULT_THRESHOLDS, cpuTemp: 75 });
    expect(h.setThresholds({ diskPct: 85, cpuTemp: 9999 })).toEqual({ ...h.DEFAULT_THRESHOLDS, diskPct: 85, cpuTemp: 105 });
    const stored = db.query("SELECT value FROM settings WHERE key = 'health.thresholds'").get() as { value: string };
    expect(h.normalizeThresholds(JSON.parse(stored.value))).toEqual(h.getThresholds());
    expect(h.thresholdsView().values).toEqual(h.getThresholds());
    expect(h.thresholdsView().limits.cpuTemp).toEqual({ min: 60, max: 105 });
  } finally {
    h.setThresholds(h.DEFAULT_THRESHOLDS);
  }
  expect(h.getThresholds()).toEqual(h.DEFAULT_THRESHOLDS);
});

test("the wait before an alert follows the setting, and a critical one waits at most a minute", () => {
  let confirm = 5 * MIN;
  const out: string[] = [];
  let saved = {};
  const a = h.createAlerter({ send: (i) => out.push(`${i.id}:${i.level}`), confirmMs: () => confirm, store: { load: () => saved, save: (v) => (saved = JSON.parse(JSON.stringify(v))) } });
  run(a, [issue("disk:/")], 0, 4 * MIN);
  expect(out).toEqual([]); // 4 of 5 minutes
  run(a, [issue("disk:/")], 4 * MIN + 5_000, 5 * MIN);
  expect(out).toEqual(["disk:/:warn"]);
  run(a, [issue("temp:cpu", "crit")], 6 * MIN, 6 * MIN + 55_000);
  expect(out).toHaveLength(1); // not yet a minute
  run(a, [issue("temp:cpu", "crit")], 6 * MIN + 60_000, 6 * MIN + 65_000);
  expect(out).toEqual(["disk:/:warn", "temp:cpu:crit"]); // after 1 min, not 5
  confirm = 0;
  run(a, [issue("mem")], 20 * MIN, 20 * MIN + 5_000);
  expect(out).toContain("mem:warn"); // 0 = right away
});

test("a test alert counts the devices that have these alerts on, and sends nothing when there are none", async () => {
  const add = (endpoint: string, prefs: object) => db.query("INSERT INTO push_subs (endpoint, keys, user, prefs, created_at) VALUES (?, '{}', 'me', ?, 0)").run(endpoint, JSON.stringify(prefs));
  db.exec("DELETE FROM push_subs");
  expect(await h.testAlert()).toEqual({ devices: 0 });
  add("https://example.invalid/a", { system: false, input: true });
  expect(await h.testAlert()).toEqual({ devices: 0 }); // muted on its only device
  add("https://example.invalid/b", { input: true }); // never set: on by default
  expect(await h.testAlert()).toEqual({ devices: 1 }); // the push to the bogus address fails quietly
  db.exec("DELETE FROM push_subs");
});

// ------------------------------------------------------------------- history

test("minutes become rows, and ranges average them into coarser steps", () => {
  db.exec("DELETE FROM health_samples");
  const base = Math.floor(Date.now() / 3600_000) * 3600_000 - 2 * 3600_000; // an hour boundary two hours ago
  const s = (at: number, cpu: number | null, mem: number, temp: number | null, diskPct = 50) =>
    sample({
      at,
      cpu: { ...sample().cpu, pct: cpu, load: [2, 2, 2] },
      mem: { ...sample().mem, pct: mem },
      temps: temp == null ? [] : [{ id: "cpu", label: "CPU", kind: "cpu", c: temp, warn: 90, crit: 97 }],
      disks: [disk(diskPct)],
    });
  // minute 0: cpu 10, 30 (avg 20, peak 30); temp peaks at 70
  h.recordSample(s(base + 1_000, 10, 40, 60));
  h.recordSample(s(base + 6_000, 30, 60, 70));
  // minute 1: no CPU reading yet (first sample after start), still records memory
  h.recordSample(s(base + MIN + 1_000, null, 50, null));
  // minute 2 flushes minute 1; minute 3 flushes minute 2
  h.recordSample(s(base + 2 * MIN + 1_000, 50, 50, 80, 91));
  h.recordSample(s(base + 3 * MIN + 1_000, 0, 50, 50));
  const rows = db.query("SELECT * FROM health_samples ORDER BY ts").all() as Record<string, number | null>[];
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({ ts: base, cpu: 20, cpu_max: 30, mem: 50, temp: 70, load: 2, disk: 50 });
  expect(rows[1]).toMatchObject({ ts: base + MIN, cpu: null, cpu_max: null, mem: 50, temp: null });
  expect(rows[2]).toMatchObject({ ts: base + 2 * MIN, cpu: 50, temp: 80, disk: 91 });

  const at = base + 2 * 3600_000;
  const oneHour = h.history("1h", at);
  expect(oneHour.step).toBe(MIN);
  expect(oneHour.points).toHaveLength(0); // all of it is more than an hour old
  const day = h.history("24h", at);
  expect(day.step).toBe(15 * MIN);
  expect(day.points).toHaveLength(1);
  // one 15-minute bucket: averages of the averages (20, 50; the null CPU row is ignored), hottest, worst disk
  expect(day.points[0]).toMatchObject({ t: base, cpu: 35, cpuMax: 50, mem: 50, temp: 80, disk: 91 });
  expect(h.history("7d", at).points).toHaveLength(1);
  expect(h.isRange("6h")).toBe(true);
  expect(h.isRange("1y")).toBe(false);
});

// ----------------------------------------------------------------- processes

test("process stat lines are read relative to the last ')' (names can contain anything)", () => {
  const line = (comm: string) => `4242 (${comm}) S 1 4242 4242 0 -1 4194560 100 0 0 0 150 50 0 0 20 0 3 0 12345 99999999 2500 18446744073709551615`;
  expect(h.parseProcStat(4242, line("bun"), 4096)).toEqual({ pid: 4242, ppid: 1, comm: "bun", ticks: 200, rss: 2500 * 4096 });
  expect(h.parseProcStat(4242, line("tmux: server"), 4096)!.comm).toBe("tmux: server");
  expect(h.parseProcStat(4242, line("a) S 9 (b"), 4096)).toMatchObject({ comm: "a) S 9 (b", ppid: 1, ticks: 200 });
  expect(h.parseProcStat(1, "garbage", 4096)).toBeNull();
});

test("processes belong to the agent whose terminal started them", () => {
  const p = (pid: number, ppid: number) => ({ pid, ppid, comm: "x", ticks: 0, rss: 0 });
  // tmux server (10) → pane shell (20, agent A) → claude (21) → bun test (22); pane (30, agent B) → codex (31); unrelated (40); ansai (50) → git (51)
  const procs = [p(1, 0), p(10, 1), p(20, 10), p(21, 20), p(22, 21), p(30, 10), p(31, 30), p(40, 1), p(50, 1), p(51, 50)];
  const o = h.attribute(procs, new Map([[20, "ansai-a"], [30, "ansai-b"], [50, "#ansai"]]));
  expect([20, 21, 22].map((x) => o.get(x))).toEqual(["ansai-a", "ansai-a", "ansai-a"]);
  expect([30, 31].map((x) => o.get(x))).toEqual(["ansai-b", "ansai-b"]);
  expect([50, 51].map((x) => o.get(x))).toEqual(["#ansai", "#ansai"]);
  expect([1, 10, 40].map((x) => o.get(x))).toEqual([null, null, null]); // the tmux server itself belongs to no agent
});

test("process names show the script for interpreters and never the arguments", () => {
  expect(h.shortCmd("claude", "claude\u0000--resume\u0000abc\u0000")).toBe("claude");
  expect(h.shortCmd("bun", "bun\u0000--hot\u0000/home/me/projects/ansai/src/server/index.ts\u0000--token=secret")).toBe("bun index.ts");
  expect(h.shortCmd("node", "node\u0000--max-old-space-size=4096\u0000/usr/lib/x/cli.js\u0000--api-key\u0000hunter2")).toBe("node cli.js");
  expect(h.shortCmd("python3", "python3\u0000-m\u0000http.server\u00008000")).toBe("python3 http.server");
  expect(h.shortCmd("bash", "bash\u0000-c\u0000curl -H 'Authorization: Bearer abc' x")).toBe("bash");
  expect(h.shortCmd("bun", null)).toBe("bun");
  expect(h.shortCmd("node", `node\u0000/${"a".repeat(100)}/${"b".repeat(80)}.js`).length).toBeLessThanOrEqual(60);
});

// ---------------------------------------------------------- this very machine

test.skipIf(!h.supported)("a real sample of this machine is plausible, and so is the process view", async () => {
  h.takeSample(Date.now() - 1000);
  await Bun.sleep(50);
  const s = h.takeSample();
  expect(s.cpu.threads).toBeGreaterThan(0);
  expect(s.cpu.pct).not.toBeNull();
  expect(s.cpu.pct!).toBeGreaterThanOrEqual(0);
  expect(s.cpu.pct!).toBeLessThanOrEqual(100);
  expect(s.cpu.cores).toHaveLength(s.cpu.threads);
  if (s.cpu.speed) {
    expect(s.cpu.speed.avgMhz).toBeGreaterThan(0);
    expect(s.cpu.speed.maxMhz).toBeGreaterThanOrEqual(s.cpu.speed.avgMhz);
    expect(s.cpu.speed.limitMhz).toBeGreaterThan(0);
  }
  expect(s.mem.total).toBeGreaterThan(256 * 1024 * 1024);
  expect(s.mem.available).toBeGreaterThan(0);
  expect(s.mem.available).toBeLessThanOrEqual(s.mem.total);
  expect(s.uptime).toBeGreaterThan(0);
  expect(s.disks.length).toBeGreaterThan(0);
  expect(new Set(s.disks.map((d) => d.device)).size).toBe(s.disks.length); // one row per device
  for (const d of s.disks) {
    expect(d.pct).toBeGreaterThanOrEqual(0);
    expect(d.pct).toBeLessThanOrEqual(100);
    expect(d.used + d.avail).toBeLessThanOrEqual(d.total);
  }
  for (const t of s.temps) expect(t.c).toBeGreaterThan(-30);
  expect(h.systemNow().sample).not.toBeNull();

  const p = await h.processes();
  expect(p.cores).toBeGreaterThan(0);
  expect(p.ansai.procs).toBeGreaterThanOrEqual(1); // this test process
  expect(p.ansai.rss).toBeGreaterThan(0);
  expect(p.topMem).toHaveLength(5);
  expect(p.topMem[0]!.rss).toBeGreaterThanOrEqual(p.topMem[4]!.rss);
  for (const r of p.topCpu) expect(r.cpu).toBeGreaterThan(0);
});
