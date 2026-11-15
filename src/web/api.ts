export type ToolId = "claude" | "codex" | "agy" | "shell";

export type Autopilot = { on: boolean; tool: ToolId; accountId: string | null; yolo: boolean };
export type Project = {
  id: string;
  name: string;
  path: string;
  pinned: number;
  hidden: number;
  last_used_at: number | null;
  autopilot: Autopilot | null;
};
export type Plan = { done: number; total: number; current: string | null; items: { content: string; status: string }[] };
export type Settings = { autopilotMax: number; trackSessions: boolean };

export type Session = {
  id: string;
  task_id: string | null;
  account_id: string | null;
  project_id: string | null;
  project_name: string | null;
  tool: ToolId;
  title: string;
  cwd: string;
  argv: string[];
  status: "running" | "exited" | "closed";
  exit_code: number | null;
  agent_state: string | null;
  agent_state_at: number | null;
  agent_message: string | null;
  /** Model id and reasoning effort from the agent's own log (null until it says). */
  model: string | null;
  effort: string | null;
  created_at: number;
  ended_at: number | null;
  activity_at: number | null;
  current_command: string | null;
  clients: number;
};

export type TaskStatus = "todo" | "doing" | "review" | "done";
export const TASK_STATUSES: TaskStatus[] = ["todo", "doing", "review", "done"];
export const STATUS_LABEL: Record<TaskStatus, string> = { todo: "To do", doing: "Doing", review: "Review", done: "Done" };

export type Task = {
  id: string;
  project_id: string | null;
  project_name: string | null;
  title: string;
  body: string;
  status: TaskStatus;
  priority: number;
  position: number;
  created_at: number;
  updated_at: number;
  done_at: number | null;
  queued: number;
  plan: Plan | null;
  summary: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  source: "you" | "agent" | "session";
  sessions: { id: string; tool: ToolId; status: string; agent_state: string | null; auto: number }[];
};

export type UsageLimit = { id: string; label: string; used_percent: number; resets_at: number | null; reset: boolean };
export type Account = {
  id: string;
  tool: ToolId;
  name: string;
  dir: string | null;
  is_default: number;
  email: string | null;
  plan: string | null;
  logged_in: boolean;
  running: number;
  usage: null | {
    limits: UsageLimit[];
    limits_at: number | null;
    tokens: { five_hour: number; today: number; week: number; daily: number[] };
    note?: string | null;
  };
};

export type Device = { id: string; name: string; os: string; online: boolean; self: boolean; allowed: boolean; lastSeen: string | null };
export type DeviceList = { configured: boolean; devices: Device[]; blocked: { id: string; name: string; at: number }[] };

export type ChatItem =
  | { id: string; k: "user"; text: string; ts: number }
  | { id: string; k: "assistant"; text: string; ts: number }
  | { id: string; k: "thinking"; text: string; ts: number }
  | { id: string; k: "note"; text: string; ts: number }
  | { id: string; k: "tool"; ts: number; name: string; title: string; input?: Record<string, unknown>; result?: string; error?: boolean; done: boolean };

export type Tool = { id: ToolId; label: string; installed: boolean };
export type Me = { user: string; device: string; tailscale: { dnsName: string | null; owner: string | null; url: string | null }; shell: string };

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

  tasks: () => call<Task[]>("GET", "/api/tasks"),
  createTask: (o: { title: string; body?: string; projectId?: string | null; status?: TaskStatus; priority?: number }) =>
    call<Task>("POST", "/api/tasks", o),
  updateTask: (id: string, patch: { title?: string; body?: string; status?: TaskStatus; projectId?: string | null; priority?: number; position?: number; queued?: boolean }) =>
    call<Task>("PATCH", `/api/tasks/${id}`, patch),
  deleteTask: (id: string) => call<{ ok: true }>("DELETE", `/api/tasks/${id}`),
  runTask: (id: string, o: { tool: ToolId; yolo?: boolean; accountId?: string | null }) => call<Session>("POST", `/api/tasks/${id}/run`, o),

  accounts: () => call<Account[]>("GET", "/api/accounts"),
  createAccount: (tool: ToolId, name: string) => call<Account>("POST", "/api/accounts", { tool, name }),
  updateAccount: (id: string, patch: { name?: string; preferred?: boolean }) => call<Account>("PATCH", `/api/accounts/${id}`, patch),
  deleteAccount: (id: string) => call<{ ok: true }>("DELETE", `/api/accounts/${id}`),
  loginAccount: (id: string) => call<Session>("POST", `/api/accounts/${id}/login`),
  refreshAccounts: () => call<Account[]>("POST", "/api/accounts/refresh"),

  pushKey: () => call<{ publicKey: string }>("GET", "/api/push/key"),
  pushSubscribe: (subscription: PushSubscriptionJSON, prefs: Record<string, boolean>) =>
    call<{ ok: true }>("POST", "/api/push/subscribe", { subscription, prefs }),
  pushUnsubscribe: (endpoint: string) => call<{ ok: true }>("POST", "/api/push/unsubscribe", { endpoint }),
  pushStatus: (endpoint: string) => call<{ prefs: Record<string, boolean> | null }>("POST", "/api/push/status", { endpoint }),
  pushTest: (endpoint: string) => call<{ ok: true }>("POST", "/api/push/test", { endpoint }),

  allProjects: () => call<Project[]>("GET", "/api/projects?all"),
  devices: () => call<DeviceList>("GET", "/api/devices"),
  setDevices: (allowed: string[]) => call<DeviceList>("PUT", "/api/devices", { allowed }),

  setAutopilot: (projectId: string, patch: Partial<Autopilot>) => call<Autopilot>("PUT", `/api/projects/${projectId}/autopilot`, patch),
  settings: () => call<Settings>("GET", "/api/settings"),
  updateSettings: (patch: Partial<Settings>) => call<Settings>("PUT", "/api/settings", patch),

  sessions: () => call<Session[]>("GET", "/api/sessions"),
  session: (id: string) => call<Session>("GET", `/api/sessions/${id}`),
  createSession: (o: { tool: ToolId; projectId?: string; prompt?: string; title?: string; yolo?: boolean; accountId?: string | null }) =>
    call<Session>("POST", "/api/sessions", o),
  renameSession: (id: string, title: string) => call<Session>("PATCH", `/api/sessions/${id}`, { title }),
  restartSession: (id: string) => call<Session>("POST", `/api/sessions/${id}/restart`),
  closeSession: (id: string) => call<{ ok: true }>("DELETE", `/api/sessions/${id}`),
  history: (id: string) => call<string>("GET", `/api/sessions/${id}/history`),
  scroll: (id: string, dir: "up" | "down" | "exit") => call<{ ok: true }>("POST", `/api/sessions/${id}/scroll`, { dir }),
  keys: (id: string, keys: string[]) => call<{ ok: true }>("POST", `/api/sessions/${id}/keys`, { keys }),
  send: (id: string, text: string, enter = true) => call<{ ok: true }>("POST", `/api/sessions/${id}/send`, { text, enter }),
  uploadAttachments: async (id: string, files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append("files", file, file.name);
    const res = await fetch(`/api/sessions/${id}/attachments`, { method: "POST", body: form });
    // Bun answers an oversized upload itself, with an empty body.
    const data = (res.headers.get("content-type") || "").includes("json") ? await res.json() : null;
    if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
    return data as { files: { name: string; path: string; type: string; size: number }[] };
  },
};

export function wsUrl(path: string) {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
}
