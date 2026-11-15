#!/usr/bin/env bash
# Install ansai as a systemd user service (starts at login, restarts on failure).
# Agents keep running across ansai restarts: they live in ansai's tmux server,
# and KillMode=process stops only ansai itself.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUN="$(command -v bun)"
PORT="${ANSAI_PORT:-7777}"
UNIT="$HOME/.config/systemd/user/ansai.service"
mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<EOF
[Unit]
Description=ansai - private control room for coding agents
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$BUN $DIR/src/server/index.ts
Environment=PATH=$PATH
Environment=ANSAI_PORT=$PORT
Restart=on-failure
RestartSec=2
KillMode=process

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now ansai.service
systemctl --user restart ansai.service
sleep 1
systemctl --user --no-pager status ansai.service | head -5
echo
echo "ansai is on http://127.0.0.1:$PORT"
echo "Phone access:  tailscale serve --bg $PORT"
