export type ToolId = "claude" | "codex" | "agy" | "shell";

export type Project = {
  id: string;
  name: string;
  path: string;
  pinned: number;
  hidden: number;
  last_used_at: number | null;
};

export type Session = {
  id: string;
  project_id: string | null;
  project_name: string | null;
  tool: ToolId;
  title: string;
  cwd: string;
  argv: string[];
  status: "running" | "exited" | "closed";
  exit_code: number | null;
  agent_state: string | null;
  created_at: number;
  ended_at: number | null;
  activity_at: number | null;
  current_command: string | null;
  clients: number;
};

export type Tool = { id: ToolId; label: string; installed: boolean };
export type Me = { user: string; tailscale: { dnsName: string | null; owner: string | null; url: string | null }; shell: string };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && (data as { error?: string }).error) || `${res.status} ${res.statusText}`);
  return data as T;
}

export const api = {
  me: () => call<Me>("GET", "/api/me"),
  tools: () => call<Tool[]>("GET", "/api/tools"),
  projects: () => call<Project[]>("GET", "/api/projects"),
  project: (id: string) => call<Project & { sessions: Session[] }>("GET", `/api/projects/${id}`),
  addProject: (path: string) => call<Project>("POST", "/api/projects", { path }),
  scanProjects: () => call<{ added: number; projects: Project[] }>("POST", "/api/projects/scan"),
  updateProject: (id: string, patch: { pinned?: boolean; hidden?: boolean }) => call<Project>("PATCH", `/api/projects/${id}`, patch),

  sessions: () => call<Session[]>("GET", "/api/sessions"),
  session: (id: string) => call<Session>("GET", `/api/sessions/${id}`),
  createSession: (o: { tool: ToolId; projectId?: string; prompt?: string; title?: string; yolo?: boolean }) =>
    call<Session>("POST", "/api/sessions", o),
  renameSession: (id: string, title: string) => call<Session>("PATCH", `/api/sessions/${id}`, { title }),
  restartSession: (id: string) => call<Session>("POST", `/api/sessions/${id}/restart`),
  closeSession: (id: string) => call<{ ok: true }>("DELETE", `/api/sessions/${id}`),
  history: (id: string) => call<string>("GET", `/api/sessions/${id}/history`),
  scroll: (id: string, dir: "up" | "down" | "exit") => call<{ ok: true }>("POST", `/api/sessions/${id}/scroll`, { dir }),
  send: (id: string, text: string, enter = true) => call<{ ok: true }>("POST", `/api/sessions/${id}/send`, { text, enter }),
};

export function wsUrl(path: string) {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
}
