#!/usr/bin/env bash
#
# env-up.sh — bring up an isolated CommandMate instance for demo recording.
#
# Isolation rests on four things that must stay together:
#   1. A dedicated port. Port 3000 (a developer's live instance) is refused.
#   2. CM_DB_PATH pinned under $HOME, so no demo run can touch the real cm.db.
#      $HOME rather than a temp dir because validateDbPath rejects /tmp and /var
#      as system directories (src/config/system-directories.ts).
#   3. WORKTREE_REPOS pinned to a throwaway seed repository. WORKTREE_REPOS is
#      the *only* discovery source (src/lib/git/worktrees.ts getRepositoryPaths);
#      CM_ROOT_DIR is a container path and is deliberately not scanned (#1328).
#   4. The server runs in its own process group, so env-down.sh can stop exactly
#      what this script started without pattern-killing anything else.
#
# bash 3.2 compatible: no associative arrays, no mapfile.

set -u

FORBIDDEN_PORT=3000
DEFAULT_PORT=3399
PORT_SCAN_LIMIT=40

die() {
  printf 'env-up: %s\n' "$1" >&2
  exit 1
}

log() {
  printf 'env-up: %s\n' "$1"
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# The skill is installed at <repo>/.claude/skills/demo-video/scripts and
# byte-identically at <repo>/.agents/skills/demo-video/scripts — both are four
# levels below the repository root, so one expression serves both copies.
REPO_ROOT="${CM_DEMO_REPO_ROOT:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"
[ -f "$REPO_ROOT/server.ts" ] || die "no server.ts under $REPO_ROOT (set CM_DEMO_REPO_ROOT)"

STATE_DIR="${CM_DEMO_HOME:-$HOME/.commandmate-demo}"
case "$STATE_DIR" in
  "$HOME"/*) : ;;
  *) die "CM_DEMO_HOME must live under \$HOME (got '$STATE_DIR'); the DB path validator rejects /tmp and /var" ;;
esac

SEED_ROOT="$STATE_DIR/seed"
SEED_REPO="$SEED_ROOT/cmdemo-app"
DB_PATH="$STATE_DIR/cm.db"
LOG_FILE="$STATE_DIR/server.log"
STATE_FILE="$STATE_DIR/state.env"
VIDEO_DIR="$STATE_DIR/videos"
READY_TIMEOUT="${CM_DEMO_READY_TIMEOUT:-180}"

require() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}
require git
require curl
require awk

if [ -f "$STATE_FILE" ]; then
  die "$STATE_FILE already exists — run env-down.sh first (or delete it if the previous run crashed)"
fi

# ---------------------------------------------------------------- port -------

port_free() {
  # A successful connect means something is already listening.
  if (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

pick_port() {
  local requested="${CM_DEMO_PORT:-}"
  local candidate offset
  if [ -n "$requested" ]; then
    case "$requested" in
      ''|*[!0-9]*) die "CM_DEMO_PORT must be an integer, got '$requested'" ;;
    esac
    [ "$requested" -ne "$FORBIDDEN_PORT" ] || die "CM_DEMO_PORT must not be $FORBIDDEN_PORT: that is the default CommandMate port and a live instance would be driven by the demo"
    [ "$requested" -ge 1024 ] || die "CM_DEMO_PORT must be >= 1024, got '$requested'"
    port_free "$requested" || die "port $requested is already in use"
    printf '%s' "$requested"
    return 0
  fi
  offset=0
  while [ "$offset" -lt "$PORT_SCAN_LIMIT" ]; do
    candidate=$((DEFAULT_PORT + offset))
    offset=$((offset + 1))
    [ "$candidate" -ne "$FORBIDDEN_PORT" ] || continue
    if port_free "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  die "no free port found in ${DEFAULT_PORT}..$((DEFAULT_PORT + PORT_SCAN_LIMIT - 1))"
}

# ---------------------------------------------------------------- seed -------

seed_commit() {
  git -C "$SEED_REPO" -c user.name='CommandMate Demo' -c user.email='demo@example.invalid' \
    commit -q -m "$1"
}

create_seed_repo() {
  rm -rf "$SEED_ROOT"
  mkdir -p "$SEED_REPO"
  git -C "$SEED_REPO" init -q
  # `git init -b` needs git >= 2.28; setting HEAD before the first commit works
  # on every version.
  git -C "$SEED_REPO" symbolic-ref HEAD refs/heads/main

  mkdir -p "$SEED_REPO/src"
  printf '# cmdemo-app\n\nThrowaway repository used to record CommandMate demo footage.\n' >"$SEED_REPO/README.md"
  printf 'export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n' >"$SEED_REPO/src/greet.ts"
  git -C "$SEED_REPO" add -A
  seed_commit 'feat: initial demo app'

  printf 'export const THEME_STORAGE_KEY = "cmdemo.theme";\n' >"$SEED_REPO/src/theme.ts"
  git -C "$SEED_REPO" add -A
  seed_commit 'feat: add theme storage key'

  git -C "$SEED_REPO" worktree add -q -b feature/demo-dark-mode "$SEED_ROOT/wt-dark-mode" >/dev/null
  git -C "$SEED_REPO" worktree add -q -b fix/demo-login-error "$SEED_ROOT/wt-login-error" >/dev/null
}

# ---------------------------------------------------------------- boot -------

PORT="$(pick_port)" || exit 1
BASE_URL="http://127.0.0.1:$PORT"

mkdir -p "$STATE_DIR" "$VIDEO_DIR"
log "state dir: $STATE_DIR"
log "seeding throwaway repository"
create_seed_repo

SERVER_CMD="${CM_DEMO_SERVER_CMD:-$REPO_ROOT/node_modules/.bin/tsx server.ts}"
# env-down refuses to kill a PID whose command line does not contain this
# marker, so a recycled PID cannot be shot by a stale state file.
PROC_MATCH="${CM_DEMO_PROC_MATCH:-server.ts}"

log "starting server on $BASE_URL"
# `set -m` puts the background job in its own process group, so env-down can
# signal the whole tree (tsx forks a child that owns the listener) by PGID.
set -m
(
  cd "$REPO_ROOT" || exit 1
  # `env -u` drops the ambient overrides that would otherwise point the demo at
  # the developer's real database or a real repository list.
  exec env -u DATABASE_PATH -u MCBD_DB_PATH -u MCBD_PORT -u MCBD_ROOT_DIR \
    -u CM_AUTH_TOKEN_HASH -u CM_HTTPS_CERT -u CM_HTTPS_KEY -u CM_ALLOWED_IPS \
    NODE_ENV=development \
    CM_PORT="$PORT" \
    CM_BIND=127.0.0.1 \
    CM_DB_PATH="$DB_PATH" \
    WORKTREE_REPOS="$SEED_REPO" \
    CM_ROOT_DIR="$SEED_ROOT" \
    CM_LOG_LEVEL=warn \
    $SERVER_CMD
) >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
set +m

SERVER_PGID="$(ps -o pgid= -p "$SERVER_PID" 2>/dev/null | tr -d ' ')"

cleanup_failed_boot() {
  if [ -n "${SERVER_PGID:-}" ] && [ "$SERVER_PGID" = "$SERVER_PID" ]; then
    kill -TERM "-$SERVER_PGID" 2>/dev/null || true
  else
    kill -TERM "$SERVER_PID" 2>/dev/null || true
  fi
}

# `/` is requested rather than trusting the "Ready" log line: under `tsx
# server.ts` the route is compiled on first request, and a bootstrap crash only
# surfaces then (see the AsyncLocalStorage note in server.ts).
attempt=0
ready=0
while [ "$attempt" -lt "$READY_TIMEOUT" ]; do
  attempt=$((attempt + 1))
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    printf '%s\n' "--- last 30 lines of $LOG_FILE ---" >&2
    tail -n 30 "$LOG_FILE" >&2 2>/dev/null || true
    die "server exited before becoming ready"
  fi
  if curl -fsS -o /dev/null --max-time 10 "$BASE_URL/" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  cleanup_failed_boot
  printf '%s\n' "--- last 30 lines of $LOG_FILE ---" >&2
  tail -n 30 "$LOG_FILE" >&2 2>/dev/null || true
  die "server did not answer $BASE_URL/ within ${READY_TIMEOUT}s"
fi

cat >"$STATE_FILE" <<EOF
CM_DEMO_PORT=$PORT
CM_DEMO_BASE_URL=$BASE_URL
CM_DEMO_PID=$SERVER_PID
CM_DEMO_PGID=${SERVER_PGID:-}
CM_DEMO_PROC_MATCH=$PROC_MATCH
CM_DEMO_STATE_DIR=$STATE_DIR
CM_DEMO_SEED_ROOT=$SEED_ROOT
CM_DEMO_SEED_REPO=$SEED_REPO
CM_DEMO_DB_PATH=$DB_PATH
CM_DEMO_VIDEO_DIR=$VIDEO_DIR
CM_DEMO_LOG_FILE=$LOG_FILE
EOF

log "ready at $BASE_URL (pid $SERVER_PID)"
log "state written to $STATE_FILE"
