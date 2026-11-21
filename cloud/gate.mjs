#!/usr/bin/env node
// Sign-in gate in front of ansai: only ALLOWED people reach it. ansai itself only trusts requests addressed to
// localhost with no proxy headers, so the gate forwards each request as if it came from this machine.
// KOOMPI ID through KOOMPI Cloud's add_koompi_login (it sets KOOMPI_ID_LOGIN_URL and KOOMPI_ID_USERINFO_URL);
// the person comes back to /api/auth/callback?access_token=…, and only what KOOMPI_ID_USERINFO_URL says about that
// token counts. GATE_PASSWORD instead (or as well) shows a password form. With neither set, nobody gets in.
//   env: GATE_PORT=8080 ANSAI_PORT=7777 ALLOWED="email or id, …" GATE_PASSWORD= SECRET= (sessions survive restarts only with SECRET)
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";

const PORT = +(process.env.GATE_PORT || 8080), UP = { host: "127.0.0.1", port: +(process.env.ANSAI_PORT || 7777) };
const OPEN = process.env.GATE_OPEN === "1";   // no sign-in (private networks only)
const LOCAL = `127.0.0.1:${UP.port}`;
// What ansai sees: addressed to localhost, same-origin, no proxy or Tailscale headers (those would make it refuse).
function upHeaders(req) {
    const h = {};
    for (const [k, v] of Object.entries(req.headers)) if (!/^(x-forwarded-|x-real-ip|forwarded|tailscale-|cookie$)/.test(k)) h[k] = v;
    const keep = (req.headers.cookie || "").split(/;\s*/).filter(c => c && !c.startsWith(NAME + "=")).join("; ");
    if (keep) h.cookie = keep;
    h.host = LOCAL;
    if (h.origin) h.origin = `http://${LOCAL}`;
    if (h.referer) h.referer = h.referer.replace(/^https?:\/\/[^/]+/, `http://${LOCAL}`);
    return h;
}
// The browser only sends cross-site Origins we must refuse here, before rewriting them for ansai.
const sameOrigin = req => { try { return !req.headers.origin || new URL(req.headers.origin).host === req.headers.host; } catch { return false; } };
const LOGIN = process.env.KOOMPI_ID_LOGIN_URL || "", USERINFO = process.env.KOOMPI_ID_USERINFO_URL || "";
const ALLOWED = (process.env.ALLOWED || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const PASSWORD = process.env.GATE_PASSWORD || "", SECRET = process.env.SECRET || randomBytes(32).toString("hex");
// __Host-: other *.public.koompi.cloud apps can't set it for this host.
const DAYS = 14, NAME = "__Host-ansai_gate";

const sign = v => createHmac("sha256", SECRET).update(v).digest("base64url");
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function session(req) {
    const c = new RegExp(`(?:^|;\\s*)${NAME}=([^;]+)`).exec(req.headers.cookie || "")?.[1];
    if (!c) return null;
    const [who, exp, mac] = decodeURIComponent(c).split("|");
    return mac && same(mac, sign(who + "|" + exp)) && +exp > Date.now() ? who : null;
}
function grant(res, who) {
    const exp = Date.now() + DAYS * 864e5, v = encodeURIComponent(`${who}|${exp}|${sign(who + "|" + exp)}`);
    res.writeHead(302, { location: "/", "set-cookie": `${NAME}=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DAYS * 86400}`, "cache-control": "no-store" });
    res.end();
}
const esc = s => String(s).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
function page(res, code, title, body) {
    res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>ansai shell</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#15121b;color:#e9e0f0;font:16px system-ui,sans-serif;text-align:center}
a.b,button{display:inline-block;margin-top:18px;padding:12px 22px;border:0;border-radius:24px;background:#d0bcff;color:#381e72;font:600 15px system-ui;text-decoration:none;cursor:pointer}
input{padding:11px 14px;border-radius:12px;border:1px solid #4a4458;background:#211f26;color:#e9e0f0;font:15px system-ui}p{opacity:.7;margin:6px 0}</style>
<div><h2 style="font-weight:600;margin:0 0 6px">${title}</h2>${body}</div>`);
}
function loginPage(res, note = "") {
    const parts = [];
    if (LOGIN && USERINFO) parts.push(`<a class=b href="${esc(LOGIN)}">Sign in with KOOMPI ID</a>`);
    if (PASSWORD) parts.push(`<form method=post action="/__gate/password" style="margin-top:18px"><input type=password name=p placeholder=Password autofocus> <button>Open</button></form>`);
    page(res, note ? 403 : 200, "ansai shell", (note ? `<p>${esc(note)}</p>` : `<p>This ansai is private.</p>`) + (parts.join("") || "<p>Sign-in isn't set up yet.</p>"));
}

async function koompi(res, url) {
    const token = url.searchParams.get("access_token");
    if (!token || !USERINFO) return loginPage(res, "Sign-in didn't finish. Try again.");
    let u;
    try {
        const r = await fetch(USERINFO, { headers: { authorization: `Bearer ${token}` } });
        if (!r.ok) return loginPage(res, "Sign-in didn't finish. Try again.");
        u = await r.json();
    } catch { return loginPage(res, "Couldn't reach KOOMPI ID. Try again."); }
    const me = u.user ?? u.data ?? u;
    const ids = [me.id, me.sub, me._id, me.email, me.username, me.phone].filter(Boolean).map(x => String(x).toLowerCase());
    console.log("[gate] sign-in:", ids.join(" "), ids.some(x => ALLOWED.includes(x)) ? "allowed" : "refused");
    if (!ids.some(x => ALLOWED.includes(x))) return loginPage(res, "This ansai belongs to someone else.");
    grant(res, ids[0]);
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/auth/callback") return void koompi(res, url);
    if (url.pathname === "/__gate/logout") { res.writeHead(302, { location: "/", "set-cookie": `${NAME}=; Path=/; Secure; Max-Age=0` }); return res.end(); }
    if (url.pathname === "/__gate/password" && req.method === "POST" && PASSWORD) {
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) { res.writeHead(403); return res.end(); }
        let body = "";
        req.on("data", d => { body += d; if (body.length > 4096) req.destroy(); });
        req.on("end", () => same(sign(new URLSearchParams(body).get("p") || ""), sign(PASSWORD)) ? grant(res, "password") : setTimeout(() => loginPage(res, "Wrong password."), 800));
        return;
    }
    if (!OPEN && !session(req)) return loginPage(res);
    if (!sameOrigin(req)) { res.writeHead(403); return res.end(); }
    const up = http.request({ ...UP, method: req.method, path: req.url, headers: upHeaders(req) }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on("error", () => { if (!res.headersSent) page(res, 502, "Starting…", "<p>ansai is still starting. Reload in a few seconds.</p>"); else res.destroy(); });
    req.pipe(up);
});
server.on("upgrade", (req, sock, head) => {
    if ((!OPEN && !session(req)) || !sameOrigin(req)) return sock.destroy();
    const up = net.connect(UP.port, UP.host, () => {
        up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(upHeaders(req)).map(([k, v]) => `${k}: ${v}\r\n`).join("") + "\r\n");
        if (head?.length) up.write(head);
        sock.pipe(up).pipe(sock);
    });
    const done = () => { up.destroy(); sock.destroy(); };
    up.on("error", done); sock.on("error", done); up.on("close", done); sock.on("close", done);
});
server.listen(PORT, () => console.log(`[gate] :${PORT} → ansai :${UP.port} (${OPEN ? "OPEN, no sign-in; " : ""}KOOMPI ID ${LOGIN && USERINFO ? "on" : "off"}, password ${PASSWORD ? "on" : "off"}, ${ALLOWED.length} allowed)`));
// Container thread cap (KOOMPI Cloud: ~256): when it's nearly used up, new apps and tabs silently fail to start.
const cg = f => { try { return readFileSync("/sys/fs/cgroup/" + f, "utf8").trim(); } catch { return ""; } };
console.log(`[gate] limits: cpu.max ${cg("cpu.max")}, threads ${cg("pids.current")} of ${cg("pids.max")}`);
let warned = 0;
setInterval(() => {
    const now = +cg("pids.current"), max = +cg("pids.max");
    if (!max || now < max * 0.85) return void (warned = 0);
    if (Date.now() - warned > 300e3) { warned = Date.now(); console.log(`[gate] threads ${now} of ${max}: stop some agents`); }
}, 15e3).unref();
