#!/usr/bin/env bash
#
# env-down.sh — stop the isolated demo instance started by env-up.sh.
#
# Teardown is driven entirely by the state file env-up.sh wrote. It never
# pattern-kills (`pkill -f commandmate` has taken unrelated processes down
# before) and it refuses to signal a PID whose command line no longer matches
# what was recorded, so a recycled PID cannot be shot by a stale state file.
#
# bash 3.2 compatible: no associative arrays, no mapfile.

set -u

FORBIDDEN_PORT=3000
KEEP_SEED=0
PURGE=0

die() {
  printf 'env-down: %s\n' "$1" >&2
  exit 1
}

log() {
  printf 'env-down: %s\n' "$1"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --keep-seed) KEEP_SEED=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help)
      cat <<'USAGE'
Usage: env-down.sh [--keep-seed] [--purge]

  --keep-seed  leave the throwaway repository in place (default: delete it)
  --purge      also delete the demo DB, log and recorded videos
USAGE
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
done

STATE_DIR="${CM_DEMO_HOME:-$HOME/.commandmate-demo}"
STATE_FILE="$STATE_DIR/state.env"
[ -f "$STATE_FILE" ] || die "no state file at $STATE_FILE — nothing to stop"

CM_DEMO_PORT=""
CM_DEMO_PID=""
CM_DEMO_PGID=""
CM_DEMO_PROC_MATCH=""
CM_DEMO_SEED_ROOT=""
CM_DEMO_SESSIONS_FILE=""
CM_DEMO_PRIMARY_WORKTREE_ID=""
CM_DEMO_WORKTREE_ID=""
CM_DEMO_LOGIN_WORKTREE_ID=""
CM_DEMO_UNSYNCED_WORKTREE_ID=""
# shellcheck source=/dev/null
. "$STATE_FILE"

[ -n "$CM_DEMO_PID" ] || die "state file has no CM_DEMO_PID"
[ "$CM_DEMO_PID" -gt 1 ] 2>/dev/null || die "refusing to signal pid '$CM_DEMO_PID'"
[ "${CM_DEMO_PORT:-0}" != "$FORBIDDEN_PORT" ] || die "state file records port $FORBIDDEN_PORT; refusing to touch a live CommandMate instance"

stop_server() {
  if ! kill -0 "$CM_DEMO_PID" 2>/dev/null; then
    log "server pid $CM_DEMO_PID is already gone"
    return 0
  fi

  cmdline="$(ps -o command= -p "$CM_DEMO_PID" 2>/dev/null)"
  case "$cmdline" in
    *"$CM_DEMO_PROC_MATCH"*) : ;;
    *)
      die "pid $CM_DEMO_PID no longer looks like the demo server (expected '$CM_DEMO_PROC_MATCH' in its command line, got: ${cmdline:-<none>}); refusing to kill it"
      ;;
  esac

  # Signal the whole group only when the recorded PID really is the group
  # leader; otherwise `kill -- -PID` would reach processes this script never
  # started.
  live_pgid="$(ps -o pgid= -p "$CM_DEMO_PID" 2>/dev/null | tr -d ' ')"
  if [ -n "$live_pgid" ] && [ "$live_pgid" = "$CM_DEMO_PID" ]; then
    kill -TERM "-$live_pgid" 2>/dev/null || true
  else
    log "pid $CM_DEMO_PID is not a process-group leader; signalling it alone"
    kill -TERM "$CM_DEMO_PID" 2>/dev/null || true
  fi

  attempt=0
  while [ "$attempt" -lt 20 ]; do
    attempt=$((attempt + 1))
    kill -0 "$CM_DEMO_PID" 2>/dev/null || { log "server stopped"; return 0; }
    sleep 0.5
  done

  log "server did not exit on SIGTERM; sending SIGKILL"
  if [ -n "$live_pgid" ] && [ "$live_pgid" = "$CM_DEMO_PID" ]; then
    kill -KILL "-$live_pgid" 2>/dev/null || true
  else
    kill -KILL "$CM_DEMO_PID" 2>/dev/null || true
  fi
}

# CommandMate names sessions `mcbd-<cliTool>-<worktreeId>[-<instance suffix>]`
# (`getSessionName`, src/lib/session/claude-session.ts) and mints the worktree id
# from the **directory**: `sanitize(basename(path))` (`deriveWorktreeId`,
# src/lib/git/worktree-id.ts — Issue #1621/#1644). The branch is not in the name
# any more, so the substring match this used to do (`-cmdemo-app-`) does not
# contain `mcbd-claude-wt-dark-mode` and left the demo's own session running.
#
# Teardown is therefore driven by what this run recorded, in two passes, and
# never by a bare `mcbd-*` sweep — this tmux server is the developer's own and
# holds their live worktree sessions:
#
#   1. every name fake-agent.sh appended to $CM_DEMO_SESSIONS_FILE;
#   2. `mcbd-<tool>-<id>[-<suffix>]` for the worktree ids env-up.sh derived,
#      which also catches a session the demo *server* started (a real CLI, or an
#      extra agent instance) and a leftover from the retired branch-derived
#      scheme, whose ids all began with the seed repository's name.
#
# Both are anchored on ids minted from `$HOME/.commandmate-demo/seed/*`, so a
# name has to be about this demo's own directories to match at all.
# `-F` and `-x`: the name is compared as a whole literal line, so a record file
# that somehow held a metacharacter could not turn into a pattern that matches
# somebody else's session.
kill_session_if_live() {
  grep -Fqx -- "$1" "$LIVE_SESSIONS" || return 0
  log "killing demo tmux session: $1"
  tmux kill-session -t "=$1" 2>/dev/null || true
  # Killed sessions are dropped from the list so the second pass cannot report
  # the same name twice.
  grep -Fvx -- "$1" "$LIVE_SESSIONS" >"$LIVE_SESSIONS.tmp" 2>/dev/null || :
  mv "$LIVE_SESSIONS.tmp" "$LIVE_SESSIONS" 2>/dev/null || :
}

kill_demo_sessions() {
  command -v tmux >/dev/null 2>&1 || return 0
  LIVE_SESSIONS="$STATE_DIR/.live-sessions"
  tmux list-sessions -F '#{session_name}' >"$LIVE_SESSIONS" 2>/dev/null || : >"$LIVE_SESSIONS"

  if [ -n "$CM_DEMO_SESSIONS_FILE" ] && [ -f "$CM_DEMO_SESSIONS_FILE" ]; then
    while IFS= read -r session; do
      [ -n "$session" ] || continue
      kill_session_if_live "$session"
    done <"$CM_DEMO_SESSIONS_FILE"
  fi

  for demo_id in "$CM_DEMO_PRIMARY_WORKTREE_ID" "$CM_DEMO_WORKTREE_ID" \
                 "$CM_DEMO_LOGIN_WORKTREE_ID" "$CM_DEMO_UNSYNCED_WORKTREE_ID"; do
    [ -n "$demo_id" ] || continue
    # Worktree ids are `[a-z0-9-]+` (sanitizeIdSegment), so interpolating one
    # into the pattern cannot introduce a regex metacharacter.
    grep -E "^mcbd-[a-z0-9]+-${demo_id}(-[a-zA-Z0-9_-]+)?\$" "$LIVE_SESSIONS" \
      >"$STATE_DIR/.matched-sessions" 2>/dev/null || : >"$STATE_DIR/.matched-sessions"
    while IFS= read -r session; do
      [ -n "$session" ] || continue
      kill_session_if_live "$session"
    done <"$STATE_DIR/.matched-sessions"
    rm -f "$STATE_DIR/.matched-sessions"
  done

  rm -f "$LIVE_SESSIONS"
}

stop_server
kill_demo_sessions

# Removed unconditionally — including when tmux is absent and kill_demo_sessions
# returned early. A record left behind would make the next run's teardown chase
# names that no longer exist. Only inside the state dir, on the same reasoning as
# purge_path below: nothing read out of the state file gets to name a path this
# script deletes outside its own directory.
case "${CM_DEMO_SESSIONS_FILE:-}" in
  "$STATE_DIR"/*) rm -f "$CM_DEMO_SESSIONS_FILE" ;;
  '') : ;;
  *) log "session record '$CM_DEMO_SESSIONS_FILE' is outside $STATE_DIR; leaving it alone" ;;
esac

if [ "$KEEP_SEED" -eq 0 ] && [ -n "$CM_DEMO_SEED_ROOT" ]; then
  case "$CM_DEMO_SEED_ROOT" in
    "$STATE_DIR"/*)
      rm -rf "$CM_DEMO_SEED_ROOT"
      log "removed seed repository"
      ;;
    *) log "seed root '$CM_DEMO_SEED_ROOT' is outside $STATE_DIR; leaving it alone" ;;
  esac
fi

rm -f "$STATE_FILE"

purge_path() {
  [ -n "$1" ] || return 0
  case "$1" in
    "$STATE_DIR"/*) rm -rf "$1" ;;
    *) log "skipping purge of '$1': outside $STATE_DIR" ;;
  esac
}

if [ "$PURGE" -eq 1 ]; then
  purge_path "${CM_DEMO_LOG_FILE:-}"
  purge_path "${CM_DEMO_VIDEO_DIR:-}"
  if [ -n "${CM_DEMO_DB_PATH:-}" ]; then
    # SQLite runs in WAL mode, so the -wal/-shm sidecars sit next to the DB and
    # can be far larger than it. Removing only cm.db leaves them behind.
    purge_path "$CM_DEMO_DB_PATH"
    purge_path "$CM_DEMO_DB_PATH-wal"
    purge_path "$CM_DEMO_DB_PATH-shm"
  fi
  log "purged demo database, log and videos"
fi

log "done"
