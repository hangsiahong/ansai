#!/usr/bin/env bash
# Put a commit live.
#
# The ansai service doesn't run from this working folder: it runs from its own copy, the
# release folder (~/.ansai/release), which only this script changes. Half-done edits here,
# yours or an agent's, can't reach the running service; only a commit that passed the
# checks does.
#
#   scripts/release.sh                 release the commit this folder is on (HEAD)
#   scripts/release.sh <commit>        release that commit (also the way back to an older one)
#   scripts/release.sh --status        what is live, and what isn't yet
#   scripts/release.sh --skip-checks   don't run the checks first (when you must go back fast)
#
# What it does, in order:
#   1. runs the checks on exactly that commit, in a throwaway folder: typecheck, tests,
#      a build of the web app, and the browser smoke test against that build
#   2. copies the database to ~/.ansai/backups/ansai-before-release-<time>.db
#   3. moves the release folder to the commit, installs its packages and builds the web
#      app into dist/web/<commit> there, so the service hands out those files instead of
#      bundling the app inside its own process (about 30 MB of memory). Builds of other
#      commits are removed, except the one that was live, so going back stays quick. A
#      build that fails doesn't stop the release: the service then bundles the app itself
#      on the first page load, as it used to
#   4. restarts the service and waits until it answers
#   5. if it doesn't come up, moves back to the commit that was live and restarts again
#      (its build is still there; the service finds it by the commit)
#
# Agents keep running through all of it: they live in tmux, not in the service.
set -euo pipefail

DEV="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE="${ANSAI_SERVICE:-ansai}"
UNIT="$HOME/.config/systemd/user/$SERVICE.service"

say() { printf '%s\n' "$*"; }
die() { printf 'release: %s\n' "$*" >&2; exit 1; }

# What the service itself is set up with wins over this shell's environment.
unit_env() {
  [ -f "$UNIT" ] || return 0
  sed -n "s/^Environment=\"\{0,1\}$1=\([^\"]*\)\"\{0,1\}\$/\1/p" "$UNIT" | tail -n 1
}
unit_dir() {
  [ -f "$UNIT" ] || return 0
  sed -n 's/^WorkingDirectory=//p' "$UNIT" | tail -n 1
}

RELEASE="$(realpath -m "${ANSAI_RELEASE_DIR:-$HOME/.ansai/release}")"
DATA="$(unit_env ANSAI_HOME)"; DATA="${DATA:-${ANSAI_HOME:-$HOME/.ansai}}"
PORT="$(unit_env ANSAI_PORT)"; PORT="${PORT:-${ANSAI_PORT:-7777}}"

MODE=release
CHECKS=1
TARGET=HEAD
for arg in "$@"; do
  case "$arg" in
    --status) MODE=status ;;
    --prepare) MODE=prepare; CHECKS=0 ;; # used by install-service.sh: fill the folder, nothing else
    --skip-checks) CHECKS=0 ;;
    -h|--help) sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $arg (see --help)" ;;
    *) TARGET="$arg" ;;
  esac
done

[ "$DEV" != "$RELEASE" ] || die "run this from your working folder, not from the release folder"
command -v bun >/dev/null || die "bun isn't on the PATH"

short() { git -C "$DEV" rev-parse --short "$1"; }
subject() { git -C "$DEV" log -1 --format=%s "$1"; }

if [ "$MODE" = status ]; then
  [ -d "$RELEASE/.git" ] || die "there is no release folder yet ($RELEASE): run scripts/install-service.sh"
  live="$(git -C "$RELEASE" rev-parse HEAD)"
  say "Live:  $(git -C "$RELEASE" rev-parse --short HEAD)  $(git -C "$RELEASE" log -1 --format=%s)"
  if [ "$(unit_dir)" = "$RELEASE" ]; then
    say "       service is $(systemctl --user is-active "$SERVICE" 2>/dev/null || true), started $(systemctl --user show "$SERVICE" -p ExecMainStartTimestamp --value)"
  else
    say "       but the service runs from $(unit_dir), not from the release folder"
  fi
  if git -C "$DEV" cat-file -e "$live^{commit}" 2>/dev/null; then
    n="$(git -C "$DEV" rev-list --count "$live..HEAD")"
    if [ "$n" = 0 ]; then
      say "Here:  nothing committed here is waiting to go live"
    else
      say "Here:  $n commit(s) not live yet:"
      git -C "$DEV" log --format='         %h  %s' -n 15 "$live..HEAD"
    fi
  fi
  dirty="$(git -C "$DEV" status --porcelain | wc -l)"
  [ "$dirty" = 0 ] || say "       $dirty file(s) changed here and not committed"
  exit 0
fi

COMMIT="$(git -C "$DEV" rev-parse --verify --quiet "$TARGET^{commit}")" || die "no such commit: $TARGET"

mkdir -p "$DATA"
exec 9>"$DATA/release.lock"
flock -n 9 || die "another release is running"

if [ "$MODE" = release ]; then
  [ -f "$UNIT" ] || die "the $SERVICE service isn't installed: run scripts/install-service.sh"
  [ "$(unit_dir)" = "$RELEASE" ] || die "the service runs from $(unit_dir), not from the release folder: run scripts/install-service.sh once to move it"
fi

dirty="$(git -C "$DEV" status --porcelain | wc -l)"
[ "$dirty" = 0 ] || say "Note: $dirty file(s) changed here are not committed, so they are not part of this release."

# The release folder is its own clone, so nothing done in this working folder (branches,
# worktrees, a reset) can move it. The commit is handed over under a name of its own.
if [ ! -d "$RELEASE/.git" ]; then
  [ ! -e "$RELEASE" ] || die "$RELEASE exists and isn't a git folder"
  mkdir -p "$(dirname "$RELEASE")"
  git clone --quiet "$DEV" "$RELEASE"
  git -C "$RELEASE" config advice.detachedHead false
fi
git -C "$DEV" push --quiet --force --no-verify "$RELEASE" "$COMMIT:refs/ansai/candidate"
[ -z "$(git -C "$RELEASE" status --porcelain)" ] || die "files in the release folder were changed by hand ($RELEASE): undo that first, it should only ever hold a commit"
PREV="$(git -C "$RELEASE" rev-parse HEAD)"

CHECK=""
cleanup() {
  if [ -n "$CHECK" ]; then
    git -C "$RELEASE" worktree remove --force "$CHECK/ansai" 2>/dev/null || true
    rmdir "$CHECK" 2>/dev/null || true
    git -C "$RELEASE" worktree prune 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Builds the web app for $COMMIT into <folder>/dist/web/<commit>, where the service looks for it
# by the commit it runs. It never stops a release: with no build the service bundles the page
# itself, as it used to. scripts/build-web.ts builds aside and moves the result into place only
# when it is complete, so a failure leaves nothing half-written. A build that is already there
# is kept: the commit is the same, and the service may be reading it right now.
build_web() { # folder; prints ok or failed on the line the caller started
  local out="$1/dist/web/$COMMIT" log
  if [ -f "$out/index.html" ]; then say "already built"; return 0; fi
  log="$(mktemp "${TMPDIR:-/tmp}/ansai-web-build.XXXXXX")"
  if (cd "$1" && timeout 180 bun scripts/build-web.ts "$out") >"$log" 2>&1; then
    say "ok"
  else
    say "failed. The release goes on, and the service bundles the page itself on first load (more memory):"
    tail -n 15 "$log" | sed 's/^/      /' >&2
  fi
  rm -f "$log"
}

# Keeps the builds of the commit being released and of the one that was live (the way back);
# removes the rest of dist/web. Only direct children of that one folder are ever touched.
prune_web() {
  local web="$RELEASE/dist/web" d
  [ -d "$RELEASE/.git" ] && [ -d "$web" ] && [ ! -L "$web" ] || return 0
  for d in "$web"/*; do
    [ -d "$d" ] && [ ! -L "$d" ] || continue
    case "${d##*/}" in "$COMMIT"|"$PREV") continue ;; esac
    rm -rf -- "$d"
  done
}

if [ "$CHECKS" = 1 ]; then
  say "Checking $(short "$COMMIT")  $(subject "$COMMIT")"
  CHECK="$(mktemp -d "${TMPDIR:-/tmp}/ansai-release-check.XXXXXX")"
  LOG="$DATA/release-check.log"
  git -C "$RELEASE" worktree add --quiet --detach "$CHECK/ansai" "$COMMIT"
  step() { # name, command...
    local name="$1"; shift
    printf '  %-12s' "$name"
    # An agent running this must not hand its own session to the test servers.
    if (cd "$CHECK/ansai" && env -u ANSAI_SESSION_ID -u ANSAI_SESSION_KEY "$@") >"$LOG" 2>&1; then
      say "ok"
    else
      say "FAILED"
      tail -n 40 "$LOG" >&2
      die "$name failed, so nothing was changed. The full output is in $LOG"
    fi
  }
  step packages bun install --frozen-lockfile
  step typecheck bun run typecheck
  step tests bun test
  printf '  %-12s' "web build"; build_web "$CHECK/ansai"
  step "smoke test" bun run smoke # uses the build above: it is what goes live
  cleanup; CHECK=""
elif [ "$MODE" = release ]; then
  say "Skipping the checks, as asked."
fi

install_packages() { (cd "$RELEASE" && bun install --frozen-lockfile >/dev/null 2>&1); }

if [ "$MODE" = prepare ]; then
  git -C "$RELEASE" checkout --quiet --detach "$COMMIT"
  install_packages || die "couldn't install packages in $RELEASE"
  printf 'Building the web app: '; build_web "$RELEASE"
  prune_web
  say "Release folder $RELEASE is at $(short "$COMMIT")  $(subject "$COMMIT")"
  exit 0
fi

BACKUP=""
if [ -f "$DATA/ansai.db" ]; then
  mkdir -p "$DATA/backups"
  BACKUP="$DATA/backups/ansai-before-release-$(date +%Y%m%dT%H%M%S).db"
  SRC="$DATA/ansai.db" DST="$BACKUP" bun -e '
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.SRC);
    db.query("VACUUM INTO ?").run(process.env.DST);
    db.close();
  ' || die "couldn't copy the database, so nothing was changed"
  say "Database copied to $BACKUP"
fi

WHY=""
# Up and answering, from the release folder, and still the same process a few seconds on.
healthy() {
  local i pid cwd crashes first
  first="$(systemctl --user show "$SERVICE" -p NRestarts --value 2>/dev/null || echo 0)"
  for i in $(seq 1 40); do
    crashes=$(( $(systemctl --user show "$SERVICE" -p NRestarts --value 2>/dev/null || echo 0) - first ))
    if [ "$crashes" -ge 3 ]; then WHY="it stops as soon as it starts ($crashes times so far)"; return 1; fi
    if [ "$(systemctl --user is-active "$SERVICE" 2>/dev/null)" = active ] && curl -fs -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/me"; then
      pid="$(systemctl --user show "$SERVICE" -p MainPID --value)"
      cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
      if [ "$cwd" != "$RELEASE" ]; then WHY="it runs from ${cwd:-an unknown folder}, not from $RELEASE"; return 1; fi
      sleep 3
      if [ "$(systemctl --user show "$SERVICE" -p MainPID --value)" = "$pid" ] && curl -fs -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/me"; then return 0; fi
      WHY="it started and then stopped again"; return 1
    fi
    sleep 1
  done
  WHY="it didn't answer on port $PORT within 40 seconds"
  return 1
}

roll_back() { # why
  say ""
  say "The new version didn't come up: $1"
  journalctl --user -u "$SERVICE" -n 15 --no-pager -o cat 2>/dev/null | sed 's/^/    /' >&2 || true
  if [ "$PREV" = "$COMMIT" ]; then
    die "this is the commit that was already live, so there is nothing to go back to. Release an older commit: scripts/release.sh <commit>"
  fi
  say "Going back to $(short "$PREV")  $(subject "$PREV")"
  git -C "$RELEASE" checkout --quiet --detach "$PREV"
  install_packages || true
  systemctl --user restart "$SERVICE" || true
  if healthy; then
    say "ansai is running the version from before again. Nothing was released."
  else
    say "!! The version from before didn't come up either: $WHY"
    say "!! Look at: journalctl --user -u $SERVICE -n 50"
  fi
  [ -z "$BACKUP" ] || say "If the new version changed the database, the copy from before it is $BACKUP"
  exit 1
}

say "Releasing $(short "$COMMIT")  $(subject "$COMMIT")"
git -C "$RELEASE" checkout --quiet --detach "$COMMIT"
install_packages || roll_back "its packages couldn't be installed"
printf 'Building the web app: '; build_web "$RELEASE"
prune_web
systemctl --user restart "$SERVICE" || roll_back "systemd couldn't restart the service"
healthy || roll_back "$WHY"

say "ansai is now running $(short "$COMMIT")."
if [ "$PREV" != "$COMMIT" ]; then
  say "To go back:  scripts/release.sh $(short "$PREV")"
fi
