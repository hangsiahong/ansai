import { db } from "./db";
import { getSession } from "./sessions";
import { createTask, finishTask, getTask } from "./tasks";

/**
 * A tiny MCP server (streamable HTTP, JSON responses, no SSE) that every agent
 * started from ansai gets via --mcp-config / -c mcp_servers.ansai. The URL
 * carries the session id, so tools act on that session's project and task.
 * Only reachable on 127.0.0.1 (agents run on this laptop).
 */

const TOOLS = [
  {
    name: "add_task",
    description:
      "Add a task to the user's backlog for this project. Use it for follow-up work you notice but should not do now (bugs, refactors, missing tests, ideas). The user reviews it later.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short imperative title, e.g. 'Add retry to the upload client'" },
        details: { type: "string", description: "Context: what you saw, where (files), why it matters" },
        priority: { type: "integer", minimum: 0, maximum: 3, description: "0 none, 1 low, 2 medium, 3 high" },
      },
      required: ["title"],
    },
  },
  {
    name: "list_tasks",
    description: "List the open backlog tasks for this project (to avoid duplicates before add_task).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "finish_task",
    description:
      "Mark the backlog task you were given as ready for the user's review, with a 2-3 sentence summary of what changed and how to verify it. Only call this when the task is actually done.",
    inputSchema: {
      type: "object",
      properties: { summary: { type: "string", description: "What changed, and how the user can check it" } },
      required: ["summary"],
    },
  },
];

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], isError });

function callTool(sessionId: string, name: string, args: any) {
  const s = getSession(sessionId);
  if (!s) return text("This ansai session no longer exists.", true);
  const label = s.tool === "codex" ? "Codex" : s.tool === "claude" ? "Claude" : "agent";

  if (name === "add_task") {
    const title = String(args?.title ?? "").trim();
    if (!title) return text("A title is required.", true);
    if (!s.project_id) return text("This session isn't in a project, so there's no backlog to add to.", true);
    const t = createTask({
      title,
      body: [String(args?.details ?? "").trim(), `Added by ${label} while working on “${s.title}”.`].filter(Boolean).join("\n\n"),
      projectId: s.project_id,
      priority: args?.priority,
      source: "agent",
    });
    return text(`Added to the backlog: “${t.title}”. The user will review it; don't work on it now.`);
  }

  if (name === "list_tasks") {
    if (!s.project_id) return text("No project for this session.");
    const rows = db
      .query("SELECT title, status FROM tasks WHERE project_id = ? AND status != 'done' ORDER BY status, position LIMIT 50")
      .all(s.project_id) as { title: string; status: string }[];
    return text(rows.length ? rows.map((r) => `- [${r.status}] ${r.title}`).join("\n") : "The backlog for this project is empty.");
  }

  if (name === "finish_task") {
    if (!s.task_id || !getTask(s.task_id)) return text("This session wasn't started from a backlog task — just tell the user you're done.");
    const summary = String(args?.summary ?? "").trim();
    if (!summary) return text("A summary is required.", true);
    finishTask(s.task_id, summary);
    return text("Thanks — the task is marked ready for the user's review.");
  }

  return text(`Unknown tool ${name}`, true);
}

function handle(sessionId: string, msg: Rpc): object | null {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  switch (msg.method) {
    case "initialize":
      console.log(`[ansai] mcp: ${getSession(sessionId)?.tool ?? "unknown"} session ${sessionId} connected`);
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ansai", version: "0.1.0" },
        instructions: "The user's ansai backlog for this project. Use add_task for follow-ups and finish_task when a backlog task is done.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call":
      return reply(callTool(sessionId, String(msg.params?.name ?? ""), msg.params?.arguments ?? {}));
    default:
      if (msg.id === undefined || msg.id === null) return null; // notification (e.g. notifications/initialized)
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

export async function mcpHttp(req: Request): Promise<Response> {
  if (req.method === "GET") return new Response("ansai MCP: POST JSON-RPC here", { status: 405, headers: { allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 204 });
  const sessionId = new URL(req.url).searchParams.get("s") ?? "";
  let body: Rpc | Rpc[];
  try {
    body = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  const out = (Array.isArray(body) ? body : [body]).map((m) => handle(sessionId, m)).filter(Boolean);
  if (!out.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? out : out[0]);
}
