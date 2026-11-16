#!/usr/bin/env bash
# Install ansai as a systemd user service (starts at login, restarts on failure).
# Agents keep running across ansai restarts: they live in ansai's tmux server,
# and KillMode=process stops only ansai itself.
#
# The service runs from its own copy of the code, the release folder (~/.ansai/release),
# not from this working folder: edits here go live only when you run scripts/release.sh.
#
#   scripts/install-service.sh         run from the release folder (made here if missing)
#   scripts/install-service.sh --dev   run straight from this folder, as ansai used to:
#                                      every restart then ships whatever is in it
#
# Running it again keeps the settings the service already has (its Environment= lines);
# an ANSAI_* setting given on the command line replaces that one.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUN="$(command -v bun)"
SERVICE="${ANSAI_SERVICE:-ansai}"
UNIT="$HOME/.config/systemd/user/$SERVICE.service"
RELEASE="$(realpath -m "${ANSAI_RELEASE_DIR:-$HOME/.ansai/release}")"

RUN="$RELEASE"
for arg in "$@"; do
  case "$arg" in
    --dev) RUN="$DIR" ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install-service: unknown option $arg (see --help)" >&2; exit 1 ;;
  esac
done

# The settings the service runs with. An existing service keeps its own (its PATH too: the
# shell this is run from may have a different one); a new one gets this shell's.
ENV_LINES=()
if [ -f "$UNIT" ]; then
  mapfile -t ENV_LINES < <(grep '^Environment=' "$UNIT" || true)
fi
has_env() {
  local l
  for l in "${ENV_LINES[@]}"; do
    case "$l" in "Environment=$1="*|"Environment=\"$1="*) return 0 ;; esac
  done
  return 1
}
set_env() { # name value
  local kept=() l
  for l in "${ENV_LINES[@]}"; do
    case "$l" in "Environment=$1="*|"Environment=\"$1="*) ;; *) kept+=("$l") ;; esac
  done
  case "$2" in
    *[[:space:]]*) kept+=("Environment=\"$1=$2\"") ;;
    *) kept+=("Environment=$1=$2") ;;
  esac
  ENV_LINES=("${kept[@]}")
}
has_env PATH || set_env PATH "$PATH"
for name in ANSAI_PORT ANSAI_HOME ANSAI_ROOTS ANSAI_SCAN_DEPTH ANSAI_ALLOWED_LOGINS ANSAI_HOSTS ANSAI_TMUX_SOCKET; do
  if [ -n "${!name:-}" ]; then set_env "$name" "${!name}"; fi
done
has_env ANSAI_PORT || set_env ANSAI_PORT 7777
PORT="$(printf '%s\n' "${ENV_LINES[@]}" | sed -n 's/^Environment="\{0,1\}ANSAI_PORT=\([^"]*\)"\{0,1\}$/\1/p' | tail -n 1)"

if [ "$RUN" = "$RELEASE" ] && [ ! -d "$RELEASE/node_modules" ]; then
  # First time: fill the release folder with the commit this folder is on.
  ANSAI_RELEASE_DIR="$RELEASE" "$DIR/scripts/release.sh" --prepare
fi

mkdir -p "$(dirname "$UNIT")"
if [ -f "$UNIT" ]; then cp -f "$UNIT" "$UNIT.previous"; fi # the way back, if this goes wrong
{
  cat <<EOF
[Unit]
Description=ansai - private control room for coding agents
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$RUN
ExecStart=$BUN $RUN/src/server/index.ts
EOF
  printf '%s\n' "${ENV_LINES[@]}"
  cat <<EOF
Restart=on-failure
RestartSec=2
KillMode=process

[Install]
WantedBy=default.target
EOF
} > "$UNIT"
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE.service"
systemctl --user restart "$SERVICE.service"
sleep 1
systemctl --user --no-pager status "$SERVICE.service" | head -5
echo
echo "ansai is on http://127.0.0.1:$PORT"
if [ "$RUN" = "$RELEASE" ]; then
  echo "It runs from $RELEASE. To put a newer commit live:  scripts/release.sh"
else
  echo "It runs straight from $DIR: every restart ships whatever is in that folder."
fi
echo "Phone access:  tailscale serve --bg $PORT"
