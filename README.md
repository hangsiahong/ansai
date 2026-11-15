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
bun run test                            # bun test: auth, autopilot, team messaging (no tmux or network)
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
- **Agents work as a team:** every Claude Code and Codex agent ansai starts can see the others and talk to them through the same MCP server. `list_agents` shows who else is running, what they're on, their branch, and the files they've edited (with a warning when two agents edit the same file). `send_message` reaches one agent or everyone in the project, and `read_messages` shows what was said. Messages are delivered, not polled: a busy Claude reads them between steps (its `PostToolUse` hook returns them as context), one finishing a turn reads them and keeps going (`Stop` hook), and an idle agent gets direct messages typed in. Broadcasts from agents don't wake idle agents, and each agent can send 12 messages per 10 minutes, so they can't keep each other busy. The project page has a **Team** panel with a live *who's on what* board (each agent's task, branch, and the files it has edited or claimed, with a warning when two agents touch the same file), the conversation feed, and a box to message one agent or all of them. Each agent's chat shows the messages it sent and received.
- **Shifts (keep working until…):** put an agent on shift from its ⋯ menu (*Keep working until…*: 1 h, 2 h, 4 h, 7 AM, 9 AM or any time), or every Claude and Codex agent in a project at once from *Keep working* on the project page. While on shift, an agent that would stop and wait for you gets its next prompt instead: Claude through its `Stop` hook, so it carries on in the same turn and no "finished" push goes out, and Codex typed in once its turn ends. The prompt tells it to finish and verify what it started, work the backlog, coordinate with teammates, commit in small steps, and file decisions only you can make with `add_task`. A shift ends when time is up, when the agent calls `end_shift` with a summary, after two nudges in a row with no work done, at 30 nudges an hour on average, or when you end it. It leaves a report on the session: time on shift, nudges, the commits made meanwhile and the agent's summary. You also get a push. Shift prompts show as one-line notes in the chat. agy has no hooks yet, so it can't go on shift.
- **While you were away:** the top of *Now* sums up what happened since you last cleared it, on any device: tasks ready for review and done (with the agents' summaries a tap away), commits per project plus what's still on task branches, shifts that ended, and follow-ups agents filed. *Clear* marks it seen everywhere.
- **Task dependencies:** a task can wait for others (*Blocked by* in the task sheet). Autopilot only starts it once every prerequisite is Done. Cycles and cross-project links are refused.
- **Schedules:** a project can run a saved prompt daily, on weekdays, or weekly on a day you pick, at a local time, with its own agent, account and model. Each run is its own task. It respects the project's autopilot (with autopilot off, the run waits for you) and never starts twice after a restart. *Run now* is there too.
- **File claims:** `claim_files` / `release_files` let an agent say "I'm changing these" (advisory, nothing is locked). Claims show in `list_agents` and on the board. When a Claude agent edits a file another running agent claimed or also edited, its `PostToolUse` hook tells it right away, once, so the two talk before it turns into a conflict.
- **Startup dialogs:** when Claude, Codex or agy stops before starting (trust this folder, bypass-mode warning, first run, sign-in), the session says *Needs you* and offers the right answer. Task worktrees ansai created from your own project are trusted automatically.
- **Code changes:** *Code changes* on a task (or in a session's ⋯ menu) shows what the agent changed. In a task worktree that means its commits plus uncommitted and new files, against the branch it started from; elsewhere, the uncommitted work. There's one row per file with +/− counts, and you tap a row to read its hunks. **Merge** squash-merges a task's branch into the project's branch as one commit named after the task. It commits anything left uncommitted, removes the worktree and branch, and marks the task Done. It refuses on a dirty project folder or an open agent session, and rolls back conflicts. **Discard** deletes the worktree and branch.
- **Ready-to-run worktrees:** a new task worktree gets the project's gitignored env files (`.env*`, `.dev.vars`) copied and its `node_modules` linked, and the agent is told what it was given and whether the project folder had uncommitted work it lacks.
- **Not starting from zero:** restarting a Claude or Codex session resumes its conversation (`--resume` / `codex resume`) when it ran in the last 55 minutes, while its prompt cache is still warm. After that it starts fresh, because resuming a cold conversation re-reads it all at full price. A task that already has an agent offers *Continue in the session*, or *Pick up the last session*, before a new run. A new run of a task that ran before starts with a handoff: the last summary, the commits already on its branch, and any uncommitted files.
- **Runs that die:** if an autopilot run crashes or its terminal disappears mid-task, it's queued again once, with the reason in its handoff; after that it waits in Review marked *Stopped early*. A session you close, a clean exit, or an agent waiting on your answer is never retried.
- **Review from your phone:** in *Code changes*, tap any diff line to comment on it, collect comments, and *Send review* delivers them to the task's agent as one message anchored by file, line and the line's text. The sheet refreshes while the agent works, and a comment whose line has changed since is flagged before you send it, and sent with a note. Messages you send an agent directly always wake it, and direct messages show *Delivered* or *Waiting*.
- **Answer from the notification:** a *Needs you* push has buttons: Allow / Deny for tool approvals, or the dialog's own answer for startup screens (e.g. *Trust folder*). Each button is pinned to the prompt it was sent for. If the agent has moved on, the tap opens the session instead of pressing anything. Buttons appear on Android and desktop; iOS web push has none.
- **Playbooks:** each project page has a *Playbook*, your standing instructions (e.g. "run the tests before finishing"). Every agent started (or restarted) in that project gets it as system-level instructions: Claude through `--append-system-prompt`, Codex through `developer_instructions`, next to ansai's own note. It never becomes a prompt of its own. agy has no such flag, so there it goes in front of the first prompt. Your repository's files (CLAUDE.md, AGENTS.md) are never touched.
- **Cost awareness:** the chat shows the conversation's context size (every reply re-reads all of it) and, past ~150k, offers to compact it. The Accounts page counts fresh tokens (input, cache writes, output) and lists cache reads, which cost a fraction as much, separately. Team messages only wake an agent when it's worth a turn.
- **Lean startup:** Claude agents ansai starts skip your claude.ai connectors (Gmail, Drive, Calendar…) and chat-channel plugins such as Telegram, through their own `--settings`, so your files stay untouched. That's about 6k fewer tokens in every request, and agents no longer take your Telegram bot from the session you chat through (a bot allows only one poller). A project's own MCP servers and your other plugins still load. It's on for every project; turn it off under the project's *Automation › Agent startup*. ansai's own tools are always loaded up front, not deferred behind tool search.
- **Chat view** (Claude Code and Codex): the agent's own conversation log, rendered as chat while it runs in tmux. You see messages, collapsible tool calls with output, edit diffs and the agent's plan. Live cards let you approve or deny actions, answer the agent's questions, or stop it. Chat and Terminal are two views of the same running agent; phones default to Chat.
- **Status and notifications:** Claude Code gets status hooks via `--settings`, and your own settings file is never touched. Codex gets a `notify` override via `-c`. Sessions show *working*, *needs you* or *your turn*. Web Push reaches your phone or desktop for "needs you", "finished" and crashes, unless you're already looking at that session.

Token counts include cache reads and come from local logs (Claude transcripts, Codex rollouts), which are read incrementally. Login tokens never leave the laptop and are never shown in the UI. agy accounts are experimental: agy keeps its login in the desktop keychain, so a profile signs in separately with a paste-code flow.

## Roadmap

1. ✅ Private access, sessions, terminal on web and phone, installable app
2. ✅ Backlog per project with tasks you can hand to an agent
3. ✅ Accounts: profiles per tool, switching, plan and limits, token usage
4. ✅ Real status from hooks, push notifications
5. A Git worktree per task, code-change viewer, merge and discard (✅); still to come: Canvas view
6. ✅ Chat view: the agent's conversation rendered natively (messages, tool calls, diffs, plan, approvals), next to the terminal
7. ✅ Agents that run themselves overnight: team messaging and file claims, shifts, schedules, task dependencies, playbooks, retries and time limits, and a morning summary
