import { config } from "./config";

/**
 * ansai is effectively a remote shell, so every request is checked three ways:
 *  1. Host header must be one we serve (blocks DNS-rebinding from random sites).
 *  2. If an Origin header is present it must match the Host (blocks CSRF and
 *     cross-site WebSocket hijacking from pages open in your laptop browser).
 *  3. Identity: requests proxied by `tailscale serve` carry Tailscale-User-Login,
 *     which must be the machine owner (or ANSAI_ALLOWED_LOGINS). Requests with no
 *     Tailscale headers must be addressed to localhost, i.e. from this laptop.
 * The server binds 127.0.0.1 only, so nothing reaches it except local processes
 * and tailscaled.
 */

type TsInfo = { dnsName: string | null; owner: string | null; at: number };
let ts: TsInfo = { dnsName: null, owner: null, at: 0 };

async function tailscaleInfo(force = false): Promise<TsInfo> {
  if (!force && Date.now() - ts.at < 60_000) return ts;
  try {
    const p = Bun.spawn(["tailscale", "status", "--json"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    const j = JSON.parse(out);
    const self = j.Self ?? {};
    const user = j.User?.[String(self.UserID)] ?? {};
    ts = {
      dnsName: self.DNSName ? String(self.DNSName).replace(/\.$/, "").toLowerCase() : null,
      owner: user.LoginName ? String(user.LoginName).toLowerCase() : null,
      at: Date.now(),
    };
  } catch {
    ts = { dnsName: null, owner: null, at: Date.now() };
  }
  return ts;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostOnly(h: string): string {
  h = h.toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0]!;
}

export type AuthResult = { ok: true; user: string } | { ok: false; status: number; reason: string };

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
    if (login === info.owner || config.extraLogins.includes(login)) return { ok: true, user: login };
    return { ok: false, status: 403, reason: `tailscale user ${login} is not allowed` };
  }

  if (isLocalHost) return { ok: true, user: "local" };
  return { ok: false, status: 403, reason: "no tailscale identity" };
}

export async function tailscaleStatus() {
  const i = await tailscaleInfo(true);
  return { dnsName: i.dnsName, owner: i.owner, url: i.dnsName ? `https://${i.dnsName}` : null };
}
