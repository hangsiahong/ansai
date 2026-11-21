#!/usr/bin/env bash
# Entrypoint: a passwd entry for whatever uid the platform picked, ansai on 127.0.0.1:7777, the sign-in gate on :8080.
set -e
id -un >/dev/null 2>&1 || echo "ansai:x:$(id -u):0:ansai:/home/ansai:/bin/bash" >> /etc/passwd
export HOME=/home/ansai SHELL=/bin/bash
[ -w "$HOME" ] || { export HOME=/tmp/home; mkdir -p "$HOME/projects"; }
cd "$HOME"
git config --global init.defaultBranch main 2>/dev/null || true
echo "[ansai-cloud] uid $(id -u), $(nproc) cores, cpu.max $(cat /sys/fs/cgroup/cpu.max 2>/dev/null), threads max $(cat /sys/fs/cgroup/pids.max 2>/dev/null)"
(cd /opt/ansai && ANSAI_PORT=7777 exec bun src/server/index.ts) &
exec node /opt/ansai/cloud/gate.mjs
