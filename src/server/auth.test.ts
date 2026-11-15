// authorize(): ansai is effectively a remote shell, so every rule gets a test.
// A fake tailnet stands in for `tailscale status --json`.
import { beforeEach, describe, expect, test } from "bun:test";

const { authorize, setAllowedDevices, setTailscaleSource } = await import("./auth");
const { db } = await import("./db");

const TAILNET = "laptop.tail1234.ts.net";
const status = {
  Self: { ID: "n-laptop", DNSName: `${TAILNET}.`, HostName: "laptop", OS: "linux", TailscaleIPs: ["100.64.0.1"], Online: true, UserID: 7 },
  User: { "7": { LoginName: "Owner@Example.com" } },
  Peer: {
    k1: { ID: "n-phone", DNSName: "phone.tail1234.ts.net.", HostName: "phone", OS: "iOS", TailscaleIPs: ["100.64.0.2"], Online: true },
    k2: { ID: "n-tablet", DNSName: "tablet.tail1234.ts.net.", HostName: "tablet", OS: "android", TailscaleIPs: ["100.64.0.3"], Online: true },
  },
};
let calls = 0;
setTailscaleSource(async () => (calls++, status));

const req = (h: Record<string, string>) => new Request(`http://${h.host ?? "x"}/api/me`, { headers: h });
const viaServe = (ip: string, login = "owner@example.com", extra: Record<string, string> = {}) =>
  req({ host: TAILNET, "tailscale-user-login": login, "x-forwarded-for": ip, ...extra });

beforeEach(() => {
  db.exec("DELETE FROM settings");
});

describe("on this laptop", () => {
  test("a local process is allowed", async () => {
    expect(await authorize(req({ host: "127.0.0.1:7777" }))).toMatchObject({ ok: true, user: "local" });
    expect(await authorize(req({ host: "localhost:7777" }))).toMatchObject({ ok: true });
  });
  test("a proxied request without a Tailscale identity is refused", async () => {
    expect(await authorize(req({ host: "127.0.0.1:7777", "x-forwarded-for": "100.64.0.9" }))).toMatchObject({ ok: false, status: 403 });
  });
});

describe("browser attacks", () => {
  test("DNS rebinding: unknown Host headers are refused", async () => {
    expect(await authorize(req({ host: "evil.example:7777" }))).toMatchObject({ ok: false, status: 421 });
  });
  test("CSRF / cross-site WebSocket: a foreign Origin is refused", async () => {
    expect(await authorize(req({ host: "127.0.0.1:7777", origin: "https://evil.example" }))).toMatchObject({ ok: false, status: 403 });
    expect(await authorize(req({ host: "127.0.0.1:7777", origin: "http://127.0.0.1:7778" }))).toMatchObject({ ok: false });
    expect(await authorize(req({ host: "127.0.0.1:7777", origin: "not a url" }))).toMatchObject({ ok: false });
  });
  test("the same origin is fine", async () => {
    expect(await authorize(req({ host: "127.0.0.1:7777", origin: "http://127.0.0.1:7777" }))).toMatchObject({ ok: true });
  });
  test("Tailscale Funnel (public internet) is always refused", async () => {
    expect(await authorize(viaServe("100.64.0.2", "owner@example.com", { "tailscale-funnel-request": "?1" }))).toMatchObject({ ok: false, status: 403 });
  });
});

describe("through tailscale serve", () => {
  test("the owner's device is allowed, named after the device", async () => {
    expect(await authorize(viaServe("100.64.0.2"))).toEqual({ ok: true, user: "owner@example.com", device: "phone" });
  });
  test("logins are compared case-insensitively; extra logins come from ANSAI_ALLOWED_LOGINS", async () => {
    expect(await authorize(viaServe("100.64.0.2", "OWNER@example.com"))).toMatchObject({ ok: true });
    expect(await authorize(viaServe("100.64.0.3", "friend@example.com"))).toMatchObject({ ok: true });
  });
  test("other Tailscale users are refused", async () => {
    expect(await authorize(viaServe("100.64.0.2", "stranger@example.com"))).toMatchObject({ ok: false, status: 403 });
  });
  test("only the last X-Forwarded-For hop (the one tailscale serve adds) counts", async () => {
    setAllowedDevices(["n-phone"]);
    // A client can't claim to be the phone by prepending its address.
    expect(await authorize(viaServe("100.64.0.2, 100.64.0.3"))).toMatchObject({ ok: false, code: "device" });
    expect(await authorize(viaServe("100.64.0.3, 100.64.0.2"))).toMatchObject({ ok: true, device: "phone" });
  });
});

describe("device allow-list", () => {
  test("not configured: every device of the owner is allowed", async () => {
    expect(await authorize(viaServe("100.64.0.3"))).toMatchObject({ ok: true, device: "tablet" });
  });
  test("configured: listed devices only, and the laptop itself always", async () => {
    setAllowedDevices(["n-phone"]);
    expect(await authorize(viaServe("100.64.0.2"))).toMatchObject({ ok: true });
    expect(await authorize(viaServe("100.64.0.3"))).toMatchObject({ ok: false, status: 403, code: "device" });
    expect(await authorize(viaServe("100.64.0.1"))).toMatchObject({ ok: true, device: "laptop" });
  });
  test("configured: an unknown address fails closed, after one fresh look at the tailnet", async () => {
    setAllowedDevices(["n-phone"]);
    const before = calls;
    expect(await authorize(viaServe("100.64.0.99"))).toMatchObject({ ok: false, code: "device" });
    expect(calls).toBeGreaterThan(before);
  });
});
