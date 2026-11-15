import type { Server, ServerWebSocket, Subprocess } from "bun";
import index from "../web/index.html";
import swPath from "../web/public/sw.js" with { type: "file" };
import manifestPath from "../web/public/manifest.webmanifest" with { type: "file" };
import iconSvgPath from "../web/public/icon.svg" with { type: "file" };
import icon192Path from "../web/public/icon-192.png" with { type: "file" };
import icon512Path from "../web/public/icon-512.png" with { type: "file" };

import { config, cleanEnv } from "./config";
import { authorize, tailscaleStatus } from "./auth";
import { addProject, getProject, listProjects, scanProjects, updateProject } from "./projects";
import {
  captureHistory,
  closeSession,
  createSession,
  getSession,
  listSessions,
  onSessionsChanged,
  reconcile,
  renameSession,
  restartSession,
  scroll,
  sendText,
  sessionView,
  startReconcileLoop,
  tmuxBase,
  writeTmuxConf,
} from "./sessions";
import { isTool, toolList } from "./tools";

type WSData =
  | { kind: "events"; user: string }
  | { kind: "term"; user: string; sessionId: string; cols: number; rows: number; proc?: Subprocess };

// ------------------------------------------------------------------ helpers

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (status: number, error: string) => json({ error }, status);

type Handler = (req: Request & { params: Record<string, string> }, server: Server<WSData>, user: string) => Response | Promise<Response | undefined> | undefined;

/** Every API/WS route goes through this: auth first, errors become JSON. */
function guard(h: Handler) {
  return async (req: Request & { params: Record<string, string> }, server: Server<WSData>) => {
    const a = await authorize(req);
    if (!a.ok) return fail(a.status, a.reason);
    try {
      return await h(req, server, a.user);
    } catch (e) {
      return fail(400, e instanceof Error ? e.message : String(e));
    }
  };
}

async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

const clampDim = (v: string | null, def: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 2 ? Math.min(Math.floor(n), max) : def;
};

const asset = (path: string, type: string, cache = "public, max-age=86400") => () =>
  new Response(Bun.file(path), { headers: { "content-type": type, "cache-control": cache } });

// ------------------------------------------------------------------- server

writeTmuxConf();
setTimeout(() => {
  try {
    const n = scanProjects();
    if (n) console.log(`[ansai] discovered ${n} new project(s)`);
  } catch (e) {
    console.error("[ansai] project scan failed:", e);
  }
}, 0);

const server = Bun.serve<WSData>({
  hostname: config.hostname,
  port: config.port,
  development: config.dev,
  idleTimeout: 120,

  routes: {
    "/": index,
    "/p/*": index,
    "/s/*": index,
    "/sw.js": asset(swPath, "text/javascript", "no-cache"),
    "/manifest.webmanifest": asset(manifestPath, "application/manifest+json"),
    "/icon.svg": asset(iconSvgPath, "image/svg+xml"),
    "/icon-192.png": asset(icon192Path, "image/png"),
    "/icon-512.png": asset(icon512Path, "image/png"),

    "/api/me": guard(async (_r, _s, user) => json({ user, tailscale: await tailscaleStatus(), shell: config.shell })),
    "/api/tools": guard(() => json(toolList())),

    "/api/projects": {
      GET: guard((req) => json(listProjects(new URL(req.url).searchParams.has("all")))),
      POST: guard(async (req) => json(addProject(String((await body(req)).path ?? "")))),
    },
    "/api/projects/scan": { POST: guard(() => json({ added: scanProjects(), projects: listProjects() })) },
    "/api/projects/:id": {
      GET: guard((req) => {
        const p = getProject(req.params.id!);
        return p ? json({ ...p, sessions: listSessions({ projectId: p.id }) }) : fail(404, "no such project");
      }),
      PATCH: guard(async (req) => json(updateProject(req.params.id!, await body(req)))),
    },

    "/api/sessions": {
      GET: guard((req) => {
        const q = new URL(req.url).searchParams;
        return json(listSessions({ projectId: q.get("project") ?? undefined, includeClosed: q.has("all") }));
      }),
      POST: guard(async (req) => {
        const b = await body<{ tool?: string; projectId?: string; cwd?: string; title?: string; prompt?: string; yolo?: boolean; accountId?: string }>(req);
        if (!isTool(b.tool)) return fail(400, "unknown tool");
        return json(await createSession({ ...b, tool: b.tool }));
      }),
    },
    "/api/sessions/:id": {
      GET: guard((req) => {
        const s = getSession(req.params.id!);
        return s ? json(sessionView(s)) : fail(404, "no such session");
      }),
      PATCH: guard(async (req) => {
        const b = await body<{ title?: string }>(req);
        if (b.title) await renameSession(req.params.id!, b.title);
        await reconcile();
        return json(sessionView(getSession(req.params.id!)!));
      }),
      DELETE: guard(async (req) => {
        await closeSession(req.params.id!);
        return json({ ok: true });
      }),
    },
    "/api/sessions/:id/restart": { POST: guard(async (req) => json(await restartSession(req.params.id!))) },
    "/api/sessions/:id/history": {
      GET: guard(async (req) => {
        const lines = clampDim(new URL(req.url).searchParams.get("lines"), 3000, 50000);
        return new Response(await captureHistory(req.params.id!, lines), {
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      }),
    },
    "/api/sessions/:id/scroll": {
      POST: guard(async (req) => {
        const dir = (await body<{ dir?: string }>(req)).dir;
        if (dir !== "up" && dir !== "down" && dir !== "exit") return fail(400, "dir must be up|down|exit");
        await scroll(req.params.id!, dir);
        return json({ ok: true });
      }),
    },
    "/api/sessions/:id/send": {
      POST: guard(async (req) => {
        const b = await body<{ text?: string; enter?: boolean }>(req);
        await sendText(req.params.id!, String(b.text ?? ""), b.enter !== false);
        return json({ ok: true });
      }),
    },

    "/ws/events": guard((req, server, user) => {
      if (server.upgrade(req, { data: { kind: "events", user } })) return undefined;
      return fail(426, "websocket upgrade required");
    }),
    "/ws/term/:id": guard((req, server, user) => {
      const s = getSession(req.params.id!);
      if (!s || s.status === "closed") return fail(404, "no such session");
      const q = new URL(req.url).searchParams;
      const data: WSData = {
        kind: "term",
        user,
        sessionId: s.id,
        cols: clampDim(q.get("cols"), 80, 500),
        rows: clampDim(q.get("rows"), 24, 200),
      };
      if (server.upgrade(req, { data })) return undefined;
      return fail(426, "websocket upgrade required");
    }),

    "/api/*": guard(() => fail(404, "not found")),
  },

  fetch() {
    return new Response("not found", { status: 404 });
  },

  websocket: {
    maxPayloadLength: 4 * 1024 * 1024,
    idleTimeout: 0, // terminals can sit idle for hours
    sendPings: true,

    open(ws: ServerWebSocket<WSData>) {
      const d = ws.data;
      if (d.kind === "events") {
        ws.subscribe("events");
        ws.send(JSON.stringify({ t: "sessions", sessions: listSessions() }));
        return;
      }
      const s = getSession(d.sessionId)!;
      const proc = Bun.spawn([...tmuxBase(), "attach-session", "-t", s.tmux_name], {
        env: cleanEnv(),
        terminal: {
          cols: d.cols,
          rows: d.rows,
          data(_t, chunk) {
            if (ws.readyState === 1) ws.send(chunk);
          },
        },
      });
      d.proc = proc;
      proc.exited.then((code) => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ t: "detached", code }));
          ws.close(1000, "detached");
        }
      });
    },

    message(ws, raw) {
      const d = ws.data;
      if (d.kind !== "term" || !d.proc?.terminal) return;
      let m: { i?: string; r?: [number, number] };
      try {
        m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      } catch {
        return;
      }
      if (typeof m.i === "string" && m.i) d.proc.terminal.write(m.i);
      if (Array.isArray(m.r)) {
        const [c, r] = m.r;
        if (c >= 2 && r >= 2 && c <= 500 && r <= 200) d.proc.terminal.resize(Math.floor(c), Math.floor(r));
      }
    },

    close(ws) {
      const d = ws.data;
      if (d.kind === "term" && d.proc) {
        try {
          d.proc.terminal?.close();
        } catch {}
        d.proc.kill();
      }
    },
  },
});

onSessionsChanged(() => server.publish("events", JSON.stringify({ t: "sessions", sessions: listSessions() })));
startReconcileLoop();

console.log(`[ansai] listening on http://${server.hostname}:${server.port}`);
tailscaleStatus().then((t) => {
  if (t.url) console.log(`[ansai] private URL (after \`tailscale serve --bg ${config.port}\`): ${t.url}`);
  else console.log("[ansai] tailscale not logged in — local access only");
});
