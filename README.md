# ansai

A private control room for coding agents running on your laptop. You can start and drive
Claude Code, Codex, Antigravity (`agy`) or a shell in any project from your phone or desktop.

- **One Bun process** (about 60 MB of RAM), using Bun's built-in terminal support, `bun:sqlite` and WebSockets. No Docker, no database server.
- **Agents live in tmux** (socket `ansai`). They keep running if the browser disconnects or ansai restarts. Attach from a laptop terminal with `tmux -L ansai attach -t ansai-<id>` and detach with Ctrl-Alt-d.
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

## Roadmap

1. ✅ Private access, sessions, terminal on web and phone, installable app
2. Backlog per project: tasks you can start with an agent
3. Accounts: separate profiles per tool (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, separate `HOME` for agy), switching, plan and usage limits, token counts
4. Real agent status from hooks (Claude hooks, Codex `notify`), plus phone notifications
5. Canvas view, a git worktree per task, a viewer for code changes
6. A chat-style view instead of a terminal (stream-json / `codex app-server`)
