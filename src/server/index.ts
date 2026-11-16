import type { Server, ServerWebSocket, Subprocess } from "bun";
// Importing the page costs nothing by itself (measured: under 1 MB, and nothing is bundled
// yet). Bun bundles it on the first request to a route that uses it, so with a prebuilt app
// (see ./webdist) `index` is simply never put on a route.
import index from "../web/index.html";
import swPath from "../web/public/sw.js" with { type: "file" };
import manifestPath from "../web/public/manifest.webmanifest" with { type: "file" };
import iconSvgPath from "../web/public/icon.svg" with { type: "file" };
import icon192Path from "../web/public/icon-192.png" with { type: "file" };
import icon512Path from "../web/public/icon-512.png" with { type: "file" };
import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { config, cleanEnv } from "./config";
import { authorize, deviceList, setAllowedDevices, tailscaleStatus } from "./auth";
import { addProject, getProject, listProjects, scanProjects, updateProject } from "./projects";
import { isLean } from "./lean";
import {
  captureHistory,
  closeSession,
  createSession,
  getSession,
  listSessions,
  reconcile,
  renameSession,
  restartSession,
  scroll,
  sendKeys,
  sendText,
  sessionView,
  startReconcileLoop,
  tmuxBase,
  writeTmuxConf,
} from "./sessions";
import { EFFORTS, TOOLS, isModelId, toolList, type ToolId } from "./tools";
import { modelChoices, switchModel } from "./models";
import { startRunWatch } from "./limits";
import { THRESHOLD_LIMITS, healthSummary, history, isRange, processes, RANGES, setThresholds, startHealthLoop, systemNow, testAlert, thresholdsView, type Thresholds } from "./health";
import { HttpError, badRequest, conflict, errorCode, notFound, tooLarge } from "./errors";
import { parseBody, v, type Check } from "./validate";
import { clientErrorLine } from "./clienterrors";
import { attachmentsDir, sweepAttachments } from "./attachments";
import { onChange, emit, type Topic } from "./events";
import { handleHook, writeHookFiles } from "./hooks";
import { getPrefs, publicKey, subscribe, testPush, unsubscribe } from "./push";
import { setViewer } from "./viewers";
import { startBackgroundTails, subscribeChat, unsubscribeChat } from "./transcripts";
import { mcpHttp } from "./mcp";
import { callerAllowed, shownKey } from "./sessionkeys";
import { deliverIdle, getPlaybook, listMessages, postMessage, resumeClaims, setPlaybook, teamBoard } from "./team";
import { resumeCompactions } from "./compaction";
import { digest, markSeen } from "./digest";
import { endProjectShift, endShift, nudgeIdle, stopPressed, shiftView, startProjectShift, startShift } from "./shifts";
import { autopilotTick, getSettings, setProjectAutopilot, startAutopilot, updateSettings } from "./autopilot";
import { STATUSES, createTask, deleteTask, getTask, listTasks, patchTask, runTask, startTaskReview, updateTask } from "./tasks";
import { changesIn, taskDir } from "./changes";
import { discardTaskWorktreeClosingAgents, mergeTaskWorktree } from "./worktrees";
import { db } from "./db";
import { startBackupLoop } from "./backup";
import { PAGE_PATHS, findWebDist, webRoutes } from "./webdist";
import { WEEKDAYS, deleteSchedule, listSchedules, runScheduleNow, saveSchedule, setScheduleEnabled } from "./schedules";
import {
  AGENT_TOOLS,
  createAccount,
  deleteAccount,
  ensureDefaultAccounts,
  getAccount,
  isAgentTool,
  listAccounts,
  loginArgv,
  scanUsage,
  startUsageLoop,
  updateAccount,
} from "./accounts";

type WSData =
  | { kind: "events"; user: string }
  | { kind: "chat"; user: string; sessionId: string }
  | { kind: "term"; user: string; sessionId: string; cols: number; rows: number; proc?: Subprocess };

// ------------------------------------------------------------------ helpers

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (status: number, error: string) => json({ error, code: errorCode(status) }, status);

type Handler = (
  req: Request & { params: Record<string, string> },
  server: Server<WSData>,
  user: string,
  device: string,
) => Response | Promise<Response | undefined> | undefined;

/**
 * Every API/WS route goes through this: auth first, then errors become JSON.
 * HttpErrors keep their status (400/404/409/413); anything else is a server
 * fault, logged and returned as 500.
 */
function guard(h: Handler) {
  return async (req: Request & { params: Record<string, string> }, server: Server<WSData>) => {
    try {
      const a = await authorize(req);
      if (!a.ok) return json({ error: a.reason, code: a.code ?? "auth" }, a.status);
      return await h(req, server, a.user, a.device);
    } catch (e) {
      if (e instanceof HttpError) return fail(e.status, e.message);
      console.error(`[ansai] ${req.method} ${new URL(req.url).pathname} failed:`, e);
      return fail(500, e instanceof Error ? e.message : String(e));
    }
  };
}

// Body size limits. JSON routes read at most JSON_LIMIT (1 MB). Hook payloads
// carry whole tool inputs (a file an agent writes), so they get more room.
// Bun itself refuses anything over MAX_BODY before a route runs.
const HOOK_LIMIT = 16 * 1024 * 1024;
const ATTACH_LIMIT = 51 * 1024 * 1024; // 50 MB of files plus multipart framing
const MAX_BODY = 64 * 1024 * 1024;
// Prompts (and task bodies, which become prompts) are passed to the agent as
// one argv entry; Linux caps that at 128 KB, and a character can be 4 bytes.
const PROMPT_MAX = 30_000;

// Field checks shared by several routes.
const TOOL_IDS = Object.keys(TOOLS) as ToolId[];
const optRef = v.optional(v.nullable(v.string({ max: 200 })));
const optBool = v.optional(v.boolean());
const modelId: Check<string> = (x, path) => {
  const m = v.string({ min: 1, max: 100, trim: true })(x, path);
  if (!isModelId(m)) throw badRequest(`${path} must be a model name like opus or gpt-6-luna`);
  return m;
};
// null or missing = the agent's own default
const optModel = v.optional(v.nullable(modelId));
const optEffort = v.optional(v.nullable(v.oneOf(EFFORTS)));
const priority = v.number({ int: true, min: 0, max: 3 });
const endpointBody = v.object({ endpoint: v.string({ min: 1, max: 2048 }) });

const clampDim = (v: string | null, def: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 2 ? Math.min(Math.floor(n), max) : def;
};

const asset = (path: string, type: string, cache = "public, max-age=86400") => () =>
  new Response(Bun.file(path), { headers: { "content-type": type, "cache-control": cache } });

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * API routes declared per method answer other methods with a JSON 405 (and an
 * Allow header) instead of falling through to the plain-text 404.
 */
function allowMethods<T extends Record<string, unknown>>(routes: T): T {
  for (const [path, r] of Object.entries(routes)) {
    if (!path.startsWith("/api/") || typeof r !== "object" || r === null || r instanceof Response) continue;
    const handlers = r as Record<string, unknown>;
    const allow = METHODS.filter((m) => m in handlers);
    if (!allow.length) continue;
    for (const m of METHODS) {
      if (!(m in handlers))
        handlers[m] = () =>
          new Response(JSON.stringify({ error: `use ${allow.join(" or ")} here`, code: "method_not_allowed" }), {
            status: 405,
            headers: { "content-type": "application/json", allow: allow.join(", ") },
          });
    }
  }
  return routes;
}

function snapshot(t: Topic): string {
  if (t === "sessions") return JSON.stringify({ t, sessions: listSessions() });
  if (t === "tasks") return JSON.stringify({ t, tasks: listTasks() });
  if (t === "projects") return JSON.stringify({ t, projects: listProjects() });
  if (t === "accounts") return JSON.stringify({ t, accounts: listAccounts() });
  if (t === "messages") return JSON.stringify({ t, messages: listMessages({ limit: 200 }) });
  if (t === "health") return JSON.stringify({ t, health: healthSummary() });
  return JSON.stringify({ t });
}

// ------------------------------------------------------------------- server

writeTmuxConf();
writeHookFiles();
ensureDefaultAccounts();
setTimeout(() => {
  try {
    const n = scanProjects();
    if (n) console.log(`[ansai] discovered ${n} new project(s)`);
  } catch (e) {
    console.error("[ansai] project scan failed:", e);
  }
}, 0);

// The web app: the files a release built for this commit if there are any, else Bun's own HTML
// import, which bundles the app inside this process on the first page load (and is what
// `bun run dev` needs for hot reload). Like the HTML import before it, the page and its files
// are not behind `guard`: they hold no data, and everything the app asks for is.
const prebuilt = config.dev ? null : findWebDist(resolve(import.meta.dir, "../.."), config.webDist);
if (prebuilt) console.log(`[ansai] web app: ${prebuilt.note}`);
const pageRoutes = prebuilt?.dist ? webRoutes(prebuilt.dist) : Object.fromEntries(PAGE_PATHS.map((p) => [p, index]));

const server = Bun.serve<WSData>({
  hostname: config.hostname,
  port: config.port,
  development: config.dev,
  idleTimeout: 120,
  maxRequestBodySize: MAX_BODY,

  routes: allowMethods({
    ...pageRoutes,
    "/sw.js": asset(swPath, "text/javascript", "no-cache"),
    "/manifest.webmanifest": asset(manifestPath, "application/manifest+json"),
    "/icon.svg": asset(iconSvgPath, "image/svg+xml"),
    "/icon-192.png": asset(icon192Path, "image/png"),
    "/icon-512.png": asset(icon512Path, "image/png"),

    "/api/me": guard(async (_r, _s, user, device) => json({ user, device, tailscale: await tailscaleStatus(), shell: config.shell })),
    // The web app tells the laptop when a screen failed to draw (crash.tsx).
    "/api/client-error": {
      POST: guard(async (req, _s, _u, device) => {
        const b = await parseBody(
          req,
          v.object({ where: v.optional(v.string({ max: 40 })), route: v.optional(v.string({ max: 400 })), text: v.string({ min: 1, max: 4000 }) }),
        );
        const line = clientErrorLine(device, b);
        if (line) console.error(line);
        return json({ ok: true });
      }),
    },
    "/api/devices": {
      GET: guard(async () => json(await deviceList())),
      PUT: guard(async (req, _s, _u, device) => {
        const b = await parseBody(req, v.object({ allowed: v.array(v.string({ max: 200 }), { max: 1000 }) }));
        const list = await deviceList();
        const ids = new Set(b.allowed);
        // Never lock out the device making the change.
        const me = list.devices.find((d) => d.name === device);
        if (me && !me.self) ids.add(me.id);
        setAllowedDevices([...ids].filter((id) => list.devices.some((d) => d.id === id)));
        return json(await deviceList());
      }),
    },
    "/api/tools": guard(() => json(toolList())),
    "/api/digest": guard(async (req) => {
      const q = Number(new URL(req.url).searchParams.get("since"));
      return json(await digest(Number.isFinite(q) && q > 0 ? q : undefined));
    }),
    "/api/digest/seen": {
      POST: guard(() => {
        markSeen();
        return json({ ok: true });
      }),
    },
    "/api/models": {
      GET: guard(async (req) => {
        const q = new URL(req.url).searchParams;
        const tool = q.get("tool");
        if (!isAgentTool(tool)) throw badRequest(`tool must be one of ${AGENT_TOOLS.join(", ")}`);
        return json(await modelChoices(tool, q.get("account") || null));
      }),
    },

    "/api/system": guard(() => json(systemNow())),
    "/api/system/history": guard((req) => {
      const range = new URL(req.url).searchParams.get("range") ?? "1h";
      if (!isRange(range)) throw badRequest(`range must be one of ${Object.keys(RANGES).join(", ")}`);
      return json(history(range));
    }),
    "/api/system/processes": guard(async () => json(await processes())),
    "/api/system/settings": {
      GET: guard(() => json(thresholdsView())),
      PUT: guard(async (req) => {
        const shape = Object.fromEntries(Object.entries(THRESHOLD_LIMITS).map(([k, l]) => [k, v.optional(v.number({ int: true, min: l.min, max: l.max }))]));
        setThresholds((await parseBody(req, v.object(shape))) as Partial<Thresholds>);
        return json(thresholdsView());
      }),
    },
    "/api/system/alerts/test": { POST: guard(async () => json(await testAlert())) },

    "/api/projects": {
      GET: guard((req) => json(listProjects(new URL(req.url).searchParams.has("all")))),
      POST: guard(async (req) => {
        const b = await parseBody(req, v.object({ path: v.string({ min: 1, max: 4096, trim: true }) }));
        const p = addProject(b.path);
        emit("projects");
        return json(p);
      }),
    },
    "/api/projects/scan": {
      POST: guard(() => {
        const added = scanProjects();
        emit("projects");
        return json({ added, projects: listProjects() });
      }),
    },
    "/api/projects/:id": {
      GET: guard((req) => {
        const p = getProject(req.params.id!);
        return p ? json({ ...p, lean: isLean(p.id), sessions: listSessions({ projectId: p.id }) }) : fail(404, "no such project");
      }),
      PATCH: guard(async (req) => {
        const p = updateProject(req.params.id!, await parseBody(req, v.object({ pinned: optBool, hidden: optBool, lean: optBool })));
        emit("projects");
        emit("tasks");
        return json(p);
      }),
    },

    "/api/tasks": {
      GET: guard(() => json(listTasks())),
      POST: guard(async (req) => {
        const b = await parseBody(
          req,
          v.object({
            title: v.string({ min: 1, max: 300, trim: true }),
            body: v.optional(v.string({ max: PROMPT_MAX })),
            projectId: optRef,
            status: v.optional(v.oneOf(STATUSES)),
            priority: v.optional(priority),
            queued: optBool,
          }),
        );
        return json(createTask(b));
      }),
    },
    "/api/tasks/:id": {
      PATCH: guard(async (req) => {
        const b = await parseBody(
          req,
          v.object({
            title: v.optional(v.string({ min: 1, max: 300, trim: true })),
            body: v.optional(v.string({ max: PROMPT_MAX })),
            projectId: optRef,
            status: v.optional(v.oneOf(STATUSES)),
            priority: v.optional(priority),
            position: v.optional(v.number()),
            queued: optBool,
            dependencies: v.optional(v.array(v.string({ min: 1, max: 100 }), { max: 100 })),
          }),
        );
        return json(await patchTask(req.params.id!, b));
      }),
      DELETE: guard(async (req) => {
        await deleteTask(req.params.id!);
        return json({ ok: true });
      }),
    },
    "/api/tasks/:id/changes": {
      GET: guard(async (req) => {
        const task = getTask(req.params.id!);
        if (!task) throw notFound("no such task");
        const project = task.project_id ? getProject(task.project_id) : null;
        if (!project) throw conflict("this task isn't in a project, so it has no code changes");
        return json(await changesIn(await taskDir(task, project.path)));
      }),
    },
    "/api/tasks/:id/review": {
      POST: guard(async (req) => {
        const b = await parseBody(req, v.object({ tool: v.optional(v.oneOf(["claude", "codex"] as const)) }));
        return json(await startTaskReview(req.params.id!, b.tool));
      }),
    },
    "/api/tasks/:id/merge": {
      POST: guard(async (req) => {
        const task = getTask(req.params.id!);
        if (!task) throw notFound("no such task");
        if (db.query(`SELECT 1 FROM sessions s WHERE s.task_id = ? AND s.status = 'running' AND s.agent_state = 'working'
          AND NOT EXISTS (SELECT 1 FROM task_reviews r WHERE r.session_id = s.id AND r.status = 'complete')`).get(task.id))
          throw conflict("the agent is still working on this task; wait for it to finish (or stop it) first");
        // An idle agent is closed too, once its work has landed; a conflict leaves it open to be asked for a rebase.
        const r = await mergeTaskWorktree(task, { close: closeSession });
        updateTask(task.id, { status: "done" });
        return json(r);
      }),
    },
    "/api/tasks/:id/worktree": {
      DELETE: guard(async (req) => {
        const task = getTask(req.params.id!);
        if (!task) throw notFound("no such task");
        // Refuses while an agent is mid-turn; an idle one is closed, then the worktree thrown away.
        await discardTaskWorktreeClosingAgents(task, closeSession);
        return json({ ok: true });
      }),
    },
    "/api/tasks/:id/run": {
      POST: guard(async (req) => {
        const b = await parseBody(req, v.object({ tool: v.oneOf(TOOL_IDS), yolo: optBool, accountId: optRef, model: optModel, effort: optEffort }));
        return json(
          await runTask(req.params.id!, { tool: b.tool, yolo: b.yolo === true, accountId: b.accountId || null, model: b.model ?? null, effort: b.effort ?? null }),
        );
      }),
    },

    "/mcp": guard((req) => mcpHttp(req)),
    "/api/settings": {
      GET: guard(() => json(getSettings())),
      PUT: guard(async (req) => {
        const b = await parseBody(req, v.object({ autopilotMax: v.optional(v.number({ int: true, min: 1, max: 6 })), trackSessions: optBool, closeFinished: optBool }));
        return json(updateSettings(b));
      }),
    },
    "/api/projects/:id/shift": {
      PUT: guard(async (req) => {
        if (!getProject(req.params.id!)) throw notFound("no such project");
        const b = await parseBody(req, v.object({ until: v.number({ int: true }), focus: v.optional(v.nullable(v.string({ max: 2000 }))) }));
        return json(startProjectShift(req.params.id!, b));
      }),
      DELETE: guard((req) => json(endProjectShift(req.params.id!))),
    },
    "/api/projects/:id/autopilot": {
      PUT: guard(async (req) => {
        const b = await parseBody(req, v.object({
            on: optBool,
            tool: v.optional(v.oneOf(AGENT_TOOLS)),
            accountId: optRef,
            yolo: optBool,
            model: optModel,
            effort: optEffort,
            maxMinutes: v.optional(v.nullable(v.number({ int: true, min: 5, max: 24 * 60 }))),
          }));
        const ap = setProjectAutopilot(req.params.id!, b);
        emit("tasks");
        return json(ap);
      }),
    },
    "/api/projects/:id/schedules": {
      GET: guard((req) => json(listSchedules(req.params.id!))),
      POST: guard(async (req) => {
        const b = await parseBody(req, v.object({ id: v.optional(v.string({ max: 40 })), title: v.string({ min: 1, max: 300, trim: true }), prompt: v.string({ min: 1, max: PROMPT_MAX }), tool: v.oneOf(AGENT_TOOLS), accountId: optRef, model: optModel, effort: optEffort, cadence: v.oneOf(["daily", "weekdays", "weekly"] as const), localTime: v.string({ min: 5, max: 5 }), timezone: v.string({ min: 1, max: 100 }), weekday: v.optional(v.oneOf(WEEKDAYS)) }));
        return json(saveSchedule(req.params.id!, b.id ?? null, b));
      }),
    },
    "/api/projects/:id/schedules/:scheduleId": {
      PATCH: guard(async (req) => {
        const b = await parseBody(req, v.object({ enabled: v.boolean() })); // required: a body without it used to pause the schedule
        return json(setScheduleEnabled(req.params.id!, req.params.scheduleId!, b.enabled === true));
      }),
      DELETE: guard((req) => { deleteSchedule(req.params.id!, req.params.scheduleId!); return json({ ok: true }); }),
    },
    "/api/projects/:id/schedules/:scheduleId/run": {
      POST: guard(async (req) => {
        const task = runScheduleNow(req.params.id!, req.params.scheduleId!);
        // The same autopilot scheduler enforces project permission and the global concurrency limit.
        await autopilotTick();
        const current = getTask(task.id)!;
        return json({ task: current, queued: !!current.queued });
      }),
    },
    "/api/hooks/:tool/:event": {
      POST: guard(async (req) => {
        // Claude reads this reply (team messages as additionalContext); an empty body means "nothing to add".
        const sid = new URL(req.url).searchParams.get("s");
        // A hook call acts as its session (it hands over that agent's messages): it must show the session's key.
        if (sid && !callerAllowed(sid, shownKey(req))) throw new HttpError(403, "ansai doesn't know this session, or its key doesn't match");
        const reads =new URL(req.url).searchParams.get("r") === "1"; // the hook's reply reaches Claude
        const out = sid ? handleHook(req.params.tool!, req.params.event!, sid, await parseBody(req, v.anyObject(), HOOK_LIMIT), reads) : undefined;
        return out ? json(out) : new Response(null, { status: 204 });
      }),
    },
    "/api/projects/:id/playbook": {
      GET: guard((req) => {
        if (!getProject(req.params.id!)) throw notFound("no such project");
        return json({ text: getPlaybook(req.params.id!) });
      }),
      PUT: guard(async (req) => {
        if (!getProject(req.params.id!)) throw notFound("no such project");
        const b = await parseBody(req, v.object({ text: v.string({ max: 8000 }) }));
        return json({ text: setPlaybook(req.params.id!, b.text) });
      }),
    },
    "/api/projects/:id/team": {
      GET: guard((req) => {
        if (!getProject(req.params.id!)) throw notFound("no such project");
        return json(teamBoard(req.params.id!));
      }),
    },
    "/api/messages": {
      GET: guard((req) => {
        const q = new URL(req.url).searchParams;
        return json(listMessages({ projectId: q.get("project"), sessionId: q.get("session") ?? undefined, limit: clampDim(q.get("limit"), 150, 500) }));
      }),
      POST: guard(async (req) => {
        const b = await parseBody(
          req,
          v.object({ body: v.string({ min: 1, max: 8000 }), to: v.optional(v.nullable(v.string({ max: 200 }))), projectId: optRef }),
        );
        return json(postMessage({ from: null, to: b.to ?? null, projectId: b.projectId ?? null, body: b.body }));
      }),
    },
    "/api/push/key": guard(() => json({ publicKey: publicKey() })),
    "/api/push/subscribe": {
      POST: guard(async (req, _s, user) => {
        const b = await parseBody(
          req,
          v.object({
            subscription: v.object({
              endpoint: v.string({ min: 1, max: 2048 }),
              keys: v.object({ p256dh: v.string({ min: 1, max: 512 }), auth: v.string({ min: 1, max: 512 }) }),
            }),
            prefs: v.optional(v.object({ input: optBool, done: optBool, exited: optBool, system: optBool })),
          }),
        );
        subscribe(b.subscription, user, b.prefs ?? {});
        return json({ ok: true });
      }),
    },
    "/api/push/unsubscribe": {
      POST: guard(async (req) => {
        unsubscribe((await parseBody(req, endpointBody)).endpoint);
        return json({ ok: true });
      }),
    },
    "/api/push/status": {
      POST: guard(async (req) => json({ prefs: getPrefs((await parseBody(req, endpointBody)).endpoint) })),
    },
    "/api/push/test": {
      POST: guard(async (req) => {
        await testPush((await parseBody(req, endpointBody)).endpoint);
        return json({ ok: true });
      }),
    },

    "/api/accounts": {
      GET: guard(() => json(listAccounts())),
      POST: guard(async (req) => {
        const b = await parseBody(req, v.object({ tool: v.oneOf(AGENT_TOOLS), name: v.string({ min: 1, max: 60, trim: true }) }));
        return json(createAccount(b.tool, b.name));
      }),
    },
    "/api/accounts/refresh": {
      POST: guard(async () => {
        await scanUsage();
        return json(listAccounts());
      }),
    },
    "/api/accounts/:id": {
      PATCH: guard(async (req) => {
        const b = await parseBody(req, v.object({ name: v.optional(v.string({ min: 1, max: 60, trim: true })), preferred: optBool }));
        return json(updateAccount(req.params.id!, b));
      }),
      DELETE: guard((req) => {
        deleteAccount(req.params.id!);
        return json({ ok: true });
      }),
    },
    "/api/accounts/:id/login": {
      POST: guard(async (req) => {
        const a = getAccount(req.params.id!);
        if (!a) return fail(404, "no such account");
        return json(
          await createSession({ tool: a.tool, accountId: a.id, argv: loginArgv(a), title: `Sign in · ${a.name}` }),
        );
      }),
    },

    "/api/sessions": {
      GET: guard((req) => {
        const q = new URL(req.url).searchParams;
        return json(listSessions({ projectId: q.get("project") ?? undefined, includeClosed: q.has("all") }));
      }),
      POST: guard(async (req) => {
        const b = await parseBody(
          req,
          v.object({
            tool: v.oneOf(TOOL_IDS),
            projectId: optRef,
            title: v.optional(v.string({ max: 120 })),
            prompt: v.optional(v.string({ max: PROMPT_MAX })),
            yolo: optBool,
            accountId: optRef,
            model: optModel,
            effort: optEffort,
          }),
        );
        return json(
          await createSession({
            tool: b.tool,
            projectId: b.projectId || undefined,
            title: b.title || undefined,
            prompt: b.prompt || undefined,
            yolo: b.yolo === true,
            accountId: b.accountId || null,
            model: b.model ?? null,
            effort: b.effort ?? null,
          }),
        );
      }),
    },
    "/api/sessions/:id": {
      GET: guard((req) => {
        const s = getSession(req.params.id!);
        return s ? json(sessionView(s)) : fail(404, "no such session");
      }),
      PATCH: guard(async (req) => {
        const id = req.params.id!;
        if (!getSession(id)) throw notFound("no such session");
        const b = await parseBody(req, v.object({ title: v.optional(v.string({ min: 1, max: 120, trim: true })) }));
        if (b.title) await renameSession(id, b.title);
        await reconcile();
        return json(sessionView(getSession(id)!));
      }),
      DELETE: guard(async (req) => {
        await closeSession(req.params.id!);
        return json({ ok: true });
      }),
    },
    "/api/sessions/:id/changes": {
      GET: guard(async (req) => {
        const s = getSession(req.params.id!);
        if (!s) throw notFound("no such session");
        return json(await changesIn(s.cwd));
      }),
    },
    "/api/sessions/:id/restart": { POST: guard(async (req) => json(await restartSession(req.params.id!))) },
    "/api/sessions/:id/shift": {
      PUT: guard(async (req) => {
        const b = await parseBody(req, v.object({ until: v.number({ int: true }), focus: v.optional(v.nullable(v.string({ max: 2000 }))) }));
        return json(startShift(req.params.id!, b));
      }),
      DELETE: guard((req) => {
        if (!getSession(req.params.id!)) throw notFound("no such session");
        endShift(req.params.id!, "you");
        return json(shiftView(req.params.id!));
      }),
    },
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
        const { dir } = await parseBody(req, v.object({ dir: v.oneOf(["up", "down", "exit"]) }));
        await scroll(req.params.id!, dir);
        return json({ ok: true });
      }),
    },
    "/api/sessions/:id/keys": {
      POST: guard(async (req) => {
        const { keys, ifSince } = await parseBody(
          req,
          v.object({ keys: v.array(v.string({ min: 1, max: 16 }), { max: 20 }), ifSince: v.optional(v.nullable(v.number())) }),
        );
        // A notification button only answers the prompt it was sent for: if the agent has
        // moved on (answered, or now waiting on something else), don't press anything.
        if (ifSince !== undefined) {
          const s = getSession(req.params.id!);
          if (!s || s.agent_state !== "needs-input" || s.agent_state_at !== ifSince) throw conflict("the agent isn't waiting on that prompt any more");
        }
        stopPressed(req.params.id!, keys); // Esc on an agent on shift that's mid-turn ends the shift
        await sendKeys(req.params.id!, keys);
        return json({ ok: true });
      }),
    },
    "/api/sessions/:id/model": {
      POST: guard(async (req) => {
        const b = await parseBody(req, v.object({ model: v.optional(modelId), effort: v.optional(v.oneOf(EFFORTS)) }));
        return json(await switchModel(req.params.id!, b));
      }),
    },
    "/api/sessions/:id/send": {
      POST: guard(async (req) => {
        const b = await parseBody(req, v.object({ text: v.optional(v.string({ max: 1_000_000 })), enter: optBool }));
        await sendText(req.params.id!, b.text ?? "", b.enter !== false);
        return json({ ok: true });
      }),
    },
    "/api/sessions/:id/attachments": {
      POST: guard(async (req) => {
        const s = getSession(req.params.id!);
        if (!s || s.status === "closed") return fail(404, "no such active session");
        if (!req.headers.get("content-type")?.startsWith("multipart/form-data")) throw badRequest("send attachments as multipart/form-data");
        if (Number(req.headers.get("content-length")) > ATTACH_LIMIT) throw tooLarge("Attachments must total 50 MB or less");
        let form: FormData;
        try {
          form = await req.formData();
        } catch {
          throw badRequest("could not read the uploaded files");
        }
        const files = form.getAll("files").filter((v): v is File => v instanceof File);
        if (!files.length || files.length > 5) return fail(400, "Attach between 1 and 5 files");
        if (files.some((f) => f.size > 20 * 1024 * 1024)) return fail(413, "Each attachment must be 20 MB or smaller");
        if (files.reduce((n, f) => n + f.size, 0) > 50 * 1024 * 1024) return fail(413, "Attachments must total 50 MB or less");
        const dir = attachmentsDir(s.id);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const saved = [];
        for (const file of files) {
          // Keep the tail of long names so the extension survives (agents pick image readers by it).
          const original = basename(file.name).replace(/[^\w.-]/g, "_").slice(-100) || "attachment";
          const name = `${crypto.randomUUID()}-${original}`;
          const path = join(dir, name);
          await Bun.write(path, file);
          saved.push({ name: file.name, path, type: file.type || "application/octet-stream", size: file.size });
        }
        return json({ files: saved });
      }),
    },

    "/ws/events": guard((req, server, user) => {
      if (server.upgrade(req, { data: { kind: "events", user } })) return undefined;
      return fail(426, "websocket upgrade required");
    }),
    "/ws/chat/:id": guard((req, server, user) => {
      const s = getSession(req.params.id!);
      if (!s || s.status === "closed") return fail(404, "no such session");
      if (server.upgrade(req, { data: { kind: "chat", user, sessionId: s.id } })) return undefined;
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
  }),

  fetch() {
    return new Response("not found", { status: 404 });
  },

  websocket: {
    maxPayloadLength: 4 * 1024 * 1024,
    idleTimeout: 0, // terminals can sit idle for hours
    sendPings: true,

    open(ws: ServerWebSocket<WSData>) {
      const d = ws.data;
      if (d.kind === "chat") {
        subscribeChat(d.sessionId, ws);
        return;
      }
      if (d.kind === "events") {
        ws.subscribe("events");
        for (const t of ["sessions", "tasks", "projects", "accounts", "messages", "health"] as Topic[]) ws.send(snapshot(t));
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
      if (d.kind === "chat") {
        try {
          const m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
          if (typeof m.v === "boolean") setViewer(d.sessionId, ws, m.v);
        } catch {}
        return;
      }
      if (d.kind !== "term" || !d.proc?.terminal) return;
      let m: { i?: string; r?: [number, number]; v?: boolean };
      try {
        m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      } catch {
        return;
      }
      if (typeof m.i === "string" && m.i) d.proc.terminal.write(m.i);
      if (typeof m.v === "boolean") setViewer(d.sessionId, ws, m.v);
      if (Array.isArray(m.r)) {
        const [c, r] = m.r;
        if (c >= 2 && r >= 2 && c <= 500 && r <= 200) d.proc.terminal.resize(Math.floor(c), Math.floor(r));
      }
    },

    close(ws) {
      const d = ws.data;
      if (d.kind === "term" || d.kind === "chat") setViewer(d.sessionId, ws, false);
      if (d.kind === "chat") unsubscribeChat(d.sessionId, ws);
      if (d.kind === "term" && d.proc) {
        try {
          d.proc.terminal?.close();
        } catch {}
        d.proc.kill();
      }
    },
  },
});

onChange((t) => server.publish("events", snapshot(t)));
// What agents asked for before this restart still holds: their file claims and their compactions.
resumeClaims();
resumeCompactions();
startReconcileLoop();
startUsageLoop();
startHealthLoop();
startBackgroundTails();
startAutopilot();
sweepAttachments().catch(() => {});
startRunWatch();
startBackupLoop();
// Idle agents get their direct messages typed in (busy Claude sessions get them through hooks).
setInterval(() => deliverIdle().catch((e) => console.error("[ansai] team delivery:", e)), 2000);
// Agents on shift get their next prompt instead of waiting for you (Claude mostly through its Stop hook).
setInterval(() => nudgeIdle().catch((e) => console.error("[ansai] shifts:", e)), 3000);

console.log(`[ansai] listening on http://${server.hostname}:${server.port}`);
tailscaleStatus().then((t) => {
  if (t.url) console.log(`[ansai] private URL (after \`tailscale serve --bg ${config.port}\`): ${t.url}`);
  else console.log("[ansai] tailscale not logged in — local access only");
});
