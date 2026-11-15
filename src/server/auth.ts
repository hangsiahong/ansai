import { config } from "./config";
import { getSetting, setSetting } from "./db";

/**
 * ansai is effectively a remote shell, so every request is checked:
 *  1. Host header must be one we serve (blocks DNS rebinding).
 *  2. If an Origin header is present it must match the Host (blocks CSRF and
 *     cross-site WebSocket hijacking from pages open in your laptop browser).
 *  3. Identity: requests proxied by `tailscale serve` carry Tailscale-User-Login,
 *     which must be the machine owner (or ANSAI_ALLOWED_LOGINS).
 *  4. Device: the proxied request's source address must belong to a device on
 *     the allow-list (stable Tailscale node IDs). This laptop is always allowed.
 *  Requests with no Tailscale headers must be addressed to localhost (this laptop).
 * The server binds 127.0.0.1 only, so nothing reaches it except local processes and tailscaled.
 */

export type Device = {
  id: string;
  name: string;
  os: string;
  ips: string[];
  online: boolean;
  self: boolean;
  lastSeen: string | null;
};

type TsInfo = { dnsName: string | null; owner: string | null; devices: Device[]; at: number };
let ts: TsInfo = { dnsName: null, owner: null, devices: [], at: 0 };

async function tailscaleInfo(force = false): Promise<TsInfo> {
  if (!force && Date.now() - ts.at < 30_000) return ts;
  try {
    const p = Bun.spawn(["tailscale", "status", "--json"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    const j = JSON.parse(out);
    const self = j.Self ?? {};
    const user = j.User?.[String(self.UserID)] ?? {};
    const toDevice = (n: any, isSelf: boolean): Device => ({
      id: String(n.ID ?? ""),
      name: String(n.DNSName ?? n.HostName ?? "").split(".")[0] || String(n.HostName ?? "device"),
      os: String(n.OS ?? ""),
      ips: (n.TailscaleIPs ?? []).map(String),
      online: !!n.Online || isSelf,
      self: isSelf,
      lastSeen: n.LastSeen ?? null,
    });
    ts = {
      dnsName: self.DNSName ? String(self.DNSName).replace(/\.$/, "").toLowerCase() : null,
      owner: user.LoginName ? String(user.LoginName).toLowerCase() : null,
      devices: [toDevice(self, true), ...Object.values(j.Peer ?? {}).map((n) => toDevice(n, false))],
      at: Date.now(),
    };
  } catch {
    ts = { dnsName: null, owner: null, devices: [], at: Date.now() };
  }
  return ts;
}

// ------------------------------------------------------------- device allow-list

const KEY = "allowed_devices";
/** null = not configured yet (every device of the owner is allowed, as before). */
export const allowedDevices = () => getSetting<string[] | null>(KEY, null);
export function setAllowedDevices(ids: string[]) {
  setSetting(KEY, [...new Set(ids.filter((x) => typeof x === "string" && x))]);
}

const blocked: { id: string; name: string; at: number }[] = [];
function noteBlocked(d: Device) {
  const i = blocked.findIndex((b) => b.id === d.id);
  if (i >= 0) blocked.splice(i, 1);
  blocked.unshift({ id: d.id, name: d.name, at: Date.now() });
  blocked.length = Math.min(blocked.length, 20);
}

export async function deviceList() {
  const info = await tailscaleInfo(true);
  const allow = allowedDevices();
  return {
    configured: allow !== null,
    devices: info.devices.map((d) => ({ ...d, allowed: d.self || allow === null || allow.includes(d.id) })),
    blocked: blocked.slice(),
  };
}

/** The last X-Forwarded-For hop is the one tailscale serve added: the real tailnet source. */
function sourceIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (!xff) return null;
  const last = xff.split(",").pop()!.trim();
  return last.replace(/^::ffff:/, "") || null;
}

// --------------------------------------------------------------------- authorize

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostOnly(h: string): string {
  h = h.toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0]!;
}

export type AuthResult = { ok: true; user: string; device: string } | { ok: false; status: number; reason: string; code?: string };

export async function authorize(req: Request): Promise<AuthResult> {
  const hostHeader = req.headers.get("host") || "";
  const host = hostOnly(hostHeader);
  const isLocalHost = LOCAL_HOSTS.has(host);

  if (req.headers.get("tailscale-funnel-request")) {
    return { ok: false, status: 403, reason: "funnel (public) access is disabled" };
  }

  let info = await tailscaleInfo();
  const knownHost = (h: string) =>
    LOCAL_HOSTS.has(h) || config.extraHosts.includes(h) || (!!info.dnsName && h === info.dnsName);

  if (!knownHost(host)) {
    info = await tailscaleInfo(true); // maybe tailscale just came up
    if (!knownHost(host)) return { ok: false, status: 421, reason: `unknown host ${host}` };
  }

  const origin = req.headers.get("origin");
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {}
    if (originHost !== hostHeader.toLowerCase()) {
      return { ok: false, status: 403, reason: "cross-origin request blocked" };
    }
  }

  const login = req.headers.get("tailscale-user-login")?.toLowerCase();
  if (login) {
    if (!info.owner) info = await tailscaleInfo(true);
    if (login !== info.owner && !config.extraLogins.includes(login)) {
      return { ok: false, status: 403, reason: `tailscale user ${login} is not allowed` };
    }
    const ip = sourceIp(req);
    let dev = ip ? info.devices.find((d) => d.ips.includes(ip)) : undefined;
    if (ip && !dev) {
      info = await tailscaleInfo(true); // a device that just joined
      dev = info.devices.find((d) => d.ips.includes(ip));
    }
    const allow = allowedDevices();
    if (allow !== null) {
      // Fail closed: once an allow-list exists, an unidentifiable device is refused.
      if (!dev) return { ok: false, status: 403, reason: "unrecognised device", code: "device" };
      if (!dev.self && !allow.includes(dev.id)) {
        noteBlocked(dev);
        return { ok: false, status: 403, reason: `${dev.name} is not allowed to use ansai — allow it from the laptop`, code: "device" };
      }
    }
    return { ok: true, user: login, device: dev?.name ?? "unknown" };
  }

  // Anything proxied by tailscale serve carries X-Forwarded-For; only direct local processes don't.
  if (isLocalHost && !req.headers.get("x-forwarded-for")) return { ok: true, user: "local", device: "this laptop" };
  return { ok: false, status: 403, reason: "no tailscale identity" };
}

export async function tailscaleStatus() {
  const i = await tailscaleInfo(true);
  return { dnsName: i.dnsName, owner: i.owner, url: i.dnsName ? `https://${i.dnsName}` : null };
}
