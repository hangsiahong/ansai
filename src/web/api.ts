export type ToolId = "claude" | "codex" | "agy" | "shell";

/** model/effort null (or missing, on older saves) = the agent's own default. */
export type Autopilot = {
  on: boolean;
  tool: ToolId;
  accountId: string | null;
  yolo: boolean;
  model?: string | null;
  effort?: string | null;
  /** Time limit per run, in minutes (null = none). */
  maxMinutes?: number | null;
};
export type Schedule = { id: string; project_id: string; title: string; prompt: string; tool: Exclude<ToolId, "shell">; account_id: string | null; model: string | null; effort: string | null; cadence: "daily" | "weekdays" | "weekly"; local_time: string; timezone: string; next_at: number; enabled: number; occurrences: { id: string; task_id: string; scheduled_for: number; status: string; outcome: string | null; task_status: string; summary: string | null; last_failure: string | null; session_id: string | null }[] };
export type Project = {
  id: string;
  name: string;
  path: string;
  pinned: number;
  hidden: number;
  last_used_at: number | null;
  autopilot: Autopilot | null;
  /** Lean startup: Claude agents here skip claude.ai connectors and chat-channel plugins (on unless turned off). */
  lean?: boolean;
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
  /** A dialog Claude shows before it starts (trust this folder, bypass warning…), with the keys that answer it. */
  startup: StartupPrompt | null;
  /** The current or last shift ("keep working until…"); null if it never had one. */
  shift: Shift | null;
  /** Spent so far, from the agent's log: fresh = input + cache writes + output; cache reads apart. */
  tokens: { fresh: number; cached: number } | null;
  /** When autopilot stops this run (its project's time limit), while its task is in Doing. */
  deadline: number | null;
};

export type Shift = {
  session_id: string;
  active: boolean;
  until: number;
  focus: string | null;
  started_at: number;
  nudges: number;
  idle: number;
  last_nudge_at: number | null;
  ended_at: number | null;
  end_reason: "time" | "agent" | "idle" | "you" | "exited" | "cap" | null;
  summary: string | null;
  report: { commits: { sha: string; subject: string }[]; moreCommits: number } | null;
};

export type StartupPrompt = { kind: string; message: string; accept: string | null; acceptKeys: string[]; decline: string | null; declineKeys: string[] };

/** A team message: agent → agent, agent → everyone in the project, or you → them. */
export type Message = {
  id: number;
  project_id: string | null;
  from_session: string | null;
  from_label: string;
  to_session: string | null;
  to_label: string | null;
  body: string;
  created_at: number;
  delivered_at: number | null;
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
  /** Autopilot retries used, and why the last run stopped early (null if it didn't). */
  attempts: number;
  last_failure: string | null;
  source: "you" | "agent" | "session";
  sessions: { id: string; tool: ToolId; title: string; status: string; agent_state: string | null; auto: number }[];
  dependencies?: { id: string; title: string; status: TaskStatus }[];
  blocked_by?: { id: string; title: string; status: TaskStatus }[];
  review: null | { session_id: string | null; reviewer_tool: "claude" | "codex"; status: "running" | "complete" | "stopped"; summary: string | null; findings: { file: string; line: number; severity: "high" | "medium" | "low"; message: string }[] };
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
    /** Fresh tokens (input + cache writes + output); cache reads counted separately. */
    tokens: { five_hour: number; today: number; week: number; daily: number[]; cache_read_week: number; total_week: number };
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

export type FileChange = {
  path: string;
  oldPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
  truncated: boolean;
};
export type Changes = {
  dir: string;
  branch: string | null;
  base: { label: string; sha: string };
  worktree: boolean;
  commits: { sha: string; subject: string; at: number }[];
  uncommitted: number;
  files: FileChange[];
  additions: number;
  deletions: number;
  truncated: boolean;
};

export type Tool = { id: ToolId; label: string; installed: boolean };

export type ModelOption = { id: string; label: string; efforts?: string[]; defaultEffort?: string | null };
export type ModelChoices = {
  models: ModelOption[];
  efforts: string[];
  /** What the agent runs on when nothing is picked, from its own config (if known). */
  default: { model: string | null; effort: string | null };
  /** The agent takes `/model <id>` and `/effort <level>` mid-conversation (Codex only opens its own menu). */
  liveSwitch: boolean;
};
/** A launch choice: null = the agent's own default. */
export type ModelPick = { model: string | null; effort: string | null };
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
  updateProject: (id: string, patch: { pinned?: boolean; hidden?: boolean; lean?: boolean }) => call<Project>("PATCH", `/api/projects/${id}`, patch),

  tasks: () => call<Task[]>("GET", "/api/tasks"),
  createTask: (o: { title: string; body?: string; projectId?: string | null; status?: TaskStatus; priority?: number }) =>
    call<Task>("POST", "/api/tasks", o),
  updateTask: (id: string, patch: { title?: string; body?: string; status?: TaskStatus; projectId?: string | null; priority?: number; position?: number; queued?: boolean; dependencies?: string[] }) =>
    call<Task>("PATCH", `/api/tasks/${id}`, patch),
  deleteTask: (id: string) => call<{ ok: true }>("DELETE", `/api/tasks/${id}`),
  taskChanges: (id: string) => call<Changes>("GET", `/api/tasks/${id}/changes`),
  reviewTask: (id: string, tool?: "claude" | "codex") => call<Session>("POST", `/api/tasks/${id}/review`, { tool }),
  mergeTask: (id: string) => call<{ sha: string; into: string; files: number }>("POST", `/api/tasks/${id}/merge`),
  discardWorktree: (id: string) => call<{ ok: true }>("DELETE", `/api/tasks/${id}/worktree`),
  runTask: (id: string, o: { tool: ToolId; yolo?: boolean; accountId?: string | null } & Partial<ModelPick>) => call<Session>("POST", `/api/tasks/${id}/run`, o),

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
  schedules: (projectId: string) => call<Schedule[]>("GET", `/api/projects/${projectId}/schedules`),
  saveSchedule: (projectId: string, schedule: Partial<Schedule> & { title: string; prompt: string; tool: Exclude<ToolId, "shell">; cadence: Schedule["cadence"]; local_time: string; timezone: string; weekday?: string }) => call<Schedule>("POST", `/api/projects/${projectId}/schedules`, {
      // The server takes camelCase; the row it returns is snake_case.
      id: schedule.id,
      title: schedule.title,
      prompt: schedule.prompt,
      tool: schedule.tool,
      accountId: schedule.account_id ?? null,
      model: schedule.model ?? null,
      effort: schedule.effort ?? null,
      cadence: schedule.cadence,
      localTime: schedule.local_time,
      timezone: schedule.timezone,
      weekday: schedule.weekday,
    }),
  toggleSchedule: (projectId: string, id: string, enabled: boolean) => call<{ ok: true }>("PATCH", `/api/projects/${projectId}/schedules/${id}`, { enabled }),
  deleteSchedule: (projectId: string, id: string) => call<{ ok: true }>("DELETE", `/api/projects/${projectId}/schedules/${id}`),
  runScheduleNow: (projectId: string, id: string) => call<{ task: Task; queued: boolean }>("POST", `/api/projects/${projectId}/schedules/${id}/run`),
  startShift: (sessionId: string, o: { until: number; focus?: string | null }) => call<Shift>("PUT", `/api/sessions/${sessionId}/shift`, o),
  endShift: (sessionId: string) => call<Shift>("DELETE", `/api/sessions/${sessionId}/shift`),
  startProjectShift: (projectId: string, o: { until: number; focus?: string | null }) =>
    call<{ started: number }>("PUT", `/api/projects/${projectId}/shift`, o),
  endProjectShift: (projectId: string) => call<{ ended: number }>("DELETE", `/api/projects/${projectId}/shift`),
  settings: () => call<Settings>("GET", "/api/settings"),
  updateSettings: (patch: Partial<Settings>) => call<Settings>("PUT", "/api/settings", patch),

  messages: (q: { project?: string; session?: string } = {}) =>
    call<Message[]>("GET", `/api/messages?${new URLSearchParams(q as Record<string, string>)}`),
  postMessage: (o: { body: string; to?: string | null; projectId?: string | null }) => call<Message>("POST", "/api/messages", o),

  sessions: () => call<Session[]>("GET", "/api/sessions"),
  session: (id: string) => call<Session>("GET", `/api/sessions/${id}`),
  createSession: (o: { tool: ToolId; projectId?: string; prompt?: string; title?: string; yolo?: boolean; accountId?: string | null } & Partial<ModelPick>) =>
    call<Session>("POST", "/api/sessions", o),
  renameSession: (id: string, title: string) => call<Session>("PATCH", `/api/sessions/${id}`, { title }),
  sessionChanges: (id: string) => call<Changes>("GET", `/api/sessions/${id}/changes`),
  restartSession: (id: string) => call<Session>("POST", `/api/sessions/${id}/restart`),
  closeSession: (id: string) => call<{ ok: true }>("DELETE", `/api/sessions/${id}`),
  history: (id: string) => call<string>("GET", `/api/sessions/${id}/history`),
  scroll: (id: string, dir: "up" | "down" | "exit") => call<{ ok: true }>("POST", `/api/sessions/${id}/scroll`, { dir }),
  keys: (id: string, keys: string[]) => call<{ ok: true }>("POST", `/api/sessions/${id}/keys`, { keys }),
  models: (tool: ToolId, accountId?: string | null) =>
    call<ModelChoices>("GET", `/api/models?${new URLSearchParams({ tool, ...(accountId ? { account: accountId } : {}) })}`),
  /** `missed`: commands the agent didn't confirm in time (the switch may not have applied). */
  switchModel: (id: string, o: { model?: string; effort?: string }) =>
    call<{ menu: boolean; missed?: ("model" | "effort")[] }>("POST", `/api/sessions/${id}/model`, o),
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
