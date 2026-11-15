# ansai

A private control room for coding agents running on your laptop. You can start and drive
Claude Code, Codex, Antigravity (`agy`) or a shell in any project from your phone or desktop,
keep a backlog per project, switch between accounts, and get a push when an agent needs you.

- **One Bun process** (about 60 MB of RAM), using Bun's built-in terminal support, `bun:sqlite` and WebSockets. No Docker, no database server.
- **Agents live in tmux** (socket `ansai`), which runs in its own systemd scope, so agents keep running when the browser disconnects or ansai is restarted or updated. Attach from a laptop terminal with `tmux -L ansai attach -t ansai-<id>` and detach with Ctrl-Alt-d.
- **Private by default.** The server listens only on the laptop (127.0.0.1). Remote access goes through `tailscale serve`, so only your own Tailscale devices can reach it. Requests must come from the machine owner's Tailscale login, or from this laptop itself. Unknown hosts, cross-site requests and Tailscale Funnel (public) traffic are rejected.

## Run

```sh
bun install
./scripts/install-service.sh            # systemd user service on :7777 (recommended)
# or: bun run dev                       # hot reload, for hacking on ansai
```

Phone access:

```sh
sudo tailscale up                       # log in once
sudo tailscale set --operator=$USER     # lets you run `tailscale serve` without sudo
tailscale serve --bg 7777               # https://<laptop>.<tailnet>.ts.net
```

Install the Tailscale app on your phone with the same account, open that URL, then use **Add to Home Screen**.

## Config (env vars)

| var | default | |
|---|---|---|
| `ANSAI_PORT` | `7777` | |
| `ANSAI_ROOTS` | `~/projects` | `:`-separated folders scanned for git repos |
| `ANSAI_SCAN_DEPTH` | `4` | |
| `ANSAI_ALLOWED_LOGINS` | | extra Tailscale logins allowed besides the owner |
| `ANSAI_HOME` | `~/.ansai` | database and tmux config |

## Using it on a phone

- The **compose box** pastes your text into the agent as one block, so multi-line prompts don't send early. The send button presses Enter.
- The **key bar** has esc, tab, ⇧tab (cycles Claude's mode), ctrl (sticky), ^C, arrow keys, ⏎, 1/2/3 for menus, and ⇞/⇟ to scroll.
- **Swipe** on the terminal to scroll back. Press esc to return to live output.
- **History** (the clock icon) shows the scrollback as plain text you can select and copy.
- **⌨** turns on typing directly into the terminal.
- **Notifications** (in the sidebar): turn them on once per device. On iPhone, add ansai to the Home Screen first.

## Features

- **Sessions:** real terminals (xterm.js over WebSocket, tmux underneath) for every agent, with a phone-friendly key bar, compose box and swipe scrollback.
- **Backlog:** tasks per project plus an Inbox, with a board (drag and drop) on desktop and a list on phones. **Run with Claude / Codex / agy** starts the agent in the task's project with the task as its first prompt. The task moves to *Review* when the agent finishes its turn and back to *Doing* when you reply.
- **Accounts:** add as many accounts per tool as you like. Each is its own profile folder under `~/.ansai/profiles` (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or a separate `HOME` for agy) that links your shared settings, skills and plugins. You can pick the account per session or task and mark one as preferred. The Accounts page shows plan, email, 5-hour and weekly limits with reset times (the values each CLI already caches), and tokens for the last 5 hours, today and 7 days.
- **Agents work the backlog:** jot tasks down (title is enough). Queue a task, or turn on **Autopilot** for a project so new tasks queue themselves. In Git projects, every task gets its own worktree and `ansai/<task-id>` branch, so agents can work on separate tasks in parallel (2 overall by default). Worktrees stay available for review and reruns. Non-Git projects continue to use their project folder. Each agent is told to ask before guessing, and to call `finish_task` with a summary when it's done. Its plan shows on the task as it works (e.g. 3/7). Agents can file follow-ups with `add_task`, and sessions you start by hand are recorded as tasks. Agents get these tools from a small MCP server inside ansai, passed in at launch (`--mcp-config` for Claude, `-c mcp_servers.ansai` for Codex), so your own config files stay untouched.
- **Chat view** (Claude Code and Codex): the agent's own conversation log, rendered as chat while it runs in tmux. You see messages, collapsible tool calls with output, edit diffs and the agent's plan. Live cards let you approve or deny actions, answer the agent's questions, or stop it. Chat and Terminal are two views of the same running agent; phones default to Chat.
- **Status and notifications:** Claude Code gets status hooks via `--settings`, and your own settings file is never touched. Codex gets a `notify` override via `-c`. Sessions show *working*, *needs you* or *your turn*. Web Push reaches your phone or desktop for "needs you", "finished" and crashes, unless you're already looking at that session.

Token counts include cache reads and come from local logs (Claude transcripts, Codex rollouts), which are read incrementally. Login tokens never leave the laptop and are never shown in the UI. agy accounts are experimental: agy keeps its login in the desktop keychain, so a profile signs in separately with a paste-code flow.

## Roadmap

1. ✅ Private access, sessions, terminal on web and phone, installable app
2. ✅ Backlog per project with tasks you can hand to an agent
3. ✅ Accounts: profiles per tool, switching, plan and limits, token usage
4. ✅ Real status from hooks, push notifications
5. A Git worktree per task (✅); still to come: Canvas view and a viewer for code changes
6. ✅ Chat view: the agent's conversation rendered natively (messages, tool calls, diffs, plan, approvals), next to the terminal
