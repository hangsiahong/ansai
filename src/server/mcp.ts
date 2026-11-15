import { db } from "./db";
import { HttpError } from "./errors";
import { getSession } from "./sessions";
import { JSON_LIMIT, readJson } from "./validate";
import { createTask, finishTask, getTask } from "./tasks";
import { getPlaybook, claimFiles, deliveryNote, describeAgents, describeHistory, postMessage, releaseFiles, takePending } from "./team";
import { endShift, shiftView } from "./shifts";

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
    name: "list_agents",
    description:
      "List the other coding agents running right now (Claude Code and Codex sessions started from ansai): their id, what they are working on, whether they are busy, their branch, and the files they have edited. Call it before touching shared code, or to find who to ask.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "send_message",
    description:
      "Send a message to another agent (to: its id from list_agents) or to every agent in this project (to: \"all\"). Use it to avoid clashing edits, hand over a finding, ask the agent that owns some code, or say what you changed that others depend on. It is delivered right away: mid-task as context, or typed in if the agent is idle. Be brief and specific; don't send acknowledgements or small talk.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "An agent id from list_agents, or \"all\" for everyone in this project" },
        message: { type: "string", description: "What you want them to know or do. Include file paths and branch names when relevant." },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "claim_files",
    description:
      "Tell the other agents you're changing some files, so they leave them alone (advisory: nothing is locked). Claims show in list_agents, and an agent that edits a file you claimed is told right away. Claim before a larger change to shared code; release_files when done.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Files (relative to your working folder, or absolute)" },
        reason: { type: "string", description: "What you're doing to them, in a few words" },
      },
      required: ["paths"],
    },
  },
  {
    name: "release_files",
    description: "Release files you claimed with claim_files (all of them when paths is left out).",
    inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } } },
  },
  {
    name: "read_messages",
    description:
      "Read the team conversation: messages between agents and from the user in this project. New messages already reach you automatically; use this to look back at what was said.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100, description: "How many recent messages (default 20)" } } },
  },
  {
    name: "end_shift",
    description:
      "Only if you are on an ansai shift (you'll have been told so): end it because nothing useful is left to do. Give a short summary of what you did during the shift; the user reads it when they're back.",
    inputSchema: {
      type: "object",
      properties: { summary: { type: "string", description: "What you did this shift, and anything the user should look at first" } },
      required: ["summary"],
    },
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

/** Tool failures are results the agent can read and act on, never HTTP errors. */
function callTool(sessionId: string, name: string, args: any) {
  try {
    return runTool(sessionId, name, args);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(`[ansai] mcp ${name} failed:`, e);
    return text(e instanceof Error ? e.message : String(e), true);
  }
}

function runTool(sessionId: string, name: string, args: any) {
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

  if (name === "list_agents") return text(describeAgents(s));

  if (name === "send_message") {
    const to = String(args?.to ?? "").trim();
    if (!to) return text('Say who it is for: an agent id from list_agents, or "all".', true);
    const m = postMessage({ from: s, to, body: String(args?.message ?? "") });
    const target = m.to_session ? getSession(m.to_session) : null;
    return text(
      target
        ? `Sent to ${m.to_label}. ${deliveryNote(target)}`
        : "Sent to everyone in this project. Busy agents read it between steps; idle ones on their next turn (broadcasts don't wake anyone).",
    );
  }

  if (name === "claim_files") {
    const paths = Array.isArray(args?.paths) ? args.paths.map(String) : [];
    if (!paths.length) return text("List the files to claim in paths.", true);
    return text(claimFiles(s, paths, String(args?.reason ?? "")));
  }

  if (name === "release_files") return text(releaseFiles(s, Array.isArray(args?.paths) ? args.paths.map(String) : undefined));

  if (name === "read_messages") {
    const n = Math.max(1, Math.min(100, Number(args?.limit) || 20));
    const fresh = takePending(s.id);
    return text([fresh, "Recent team messages:\n\n" + describeHistory(s, n)].filter(Boolean).join("\n\n---\n\n"));
  }

  if (name === "end_shift") {
    if (!shiftView(s.id)?.active) return text("You're not on a shift, so there's nothing to end. If you're done, just say so.");
    const summary = String(args?.summary ?? "").trim();
    if (!summary) return text("A summary is required.", true);
    endShift(s.id, "agent", summary);
    return text("Shift ended. Your summary is saved for the user. You can stop now.");
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

/** ansai's own note, plus the project's playbook (your standing instructions) when it has one. */
function instructionsFor(sessionId: string): string {
  const base = "The user's ansai backlog for this project. Use add_task for follow-ups and finish_task when a backlog task is done.";
  const pid = getSession(sessionId)?.project_id;
  const playbook = pid ? getPlaybook(pid) : "";
  return playbook ? `${base}\n\nThe user's playbook for this project (follow it in all your work here):\n${playbook}` : base;
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
        instructions: instructionsFor(sessionId),
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
  let body: unknown;
  try {
    body = await readJson(req, JSON_LIMIT);
  } catch (e) {
    if (e instanceof HttpError && e.status === 413) {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: e.message } }, { status: 413 });
    }
    body = undefined;
  }
  if (body === undefined) {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  const invalid = { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  const isRpc = (m: unknown): m is Rpc => typeof m === "object" && m !== null && typeof (m as Rpc).method === "string";
  const out = (Array.isArray(body) ? body : [body]).map((m) => (isRpc(m) ? handle(sessionId, m) : invalid)).filter(Boolean);
  if (!out.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? out : out[0]);
}
