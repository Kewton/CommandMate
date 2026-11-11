#!/usr/bin/env bash
# agent-health daily entry point (Issue #2924).
#
#   bash scripts/agent-health/daily.sh [--out <file>] [--sync-only] [-- <run.ts args>...]
#
# Syncs this worktree to origin/develop, reinstalls dependencies only when
# package-lock.json changed, then runs scripts/agent-health/run.ts. When the
# sync fails the check is NOT run: a minimal report (with completedAt, so the
# watchdog does not mistake it for a missing run) is written and the exit is 2.
#
# stdout carries exactly one AGENT_HEALTH_SYNC line from this script; git and
# npm output goes to stderr.
#
# The shared run lock (scripts/uat/run-lock.sh, Issue #3359) is held from
# before the sync until run.ts has finished, so a UAT server or a manual
# run.ts never runs alongside. run.ts inherits it through CM_RUN_LOCK_TOKEN.
# run.ts runs as the leader of a process group of its own that the lock's
# owner names (Issue #4288 PR1b): the lock is released only when that group is
# empty, so a run.ts killed with this script still holds it while it runs.
# When another run holds it, the minimal report says so (reason run-locked)
# and the exit is 2, as for a failed sync.
#
# bash 3.2 compatible (macOS /bin/bash): no associative arrays, no mapfile.

cd "$(dirname "$0")/../.." || exit 2

OUT=""
SYNC_ONLY=0
RUN_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out)
      if [ $# -lt 2 ] || [ -z "$2" ]; then
        echo "daily.sh: --out requires a path" >&2
        exit 2
      fi
      OUT="$2"
      shift 2
      ;;
    --out=*)
      OUT="${1#--out=}"
      shift
      ;;
    --sync-only)
      SYNC_ONLY=1
      shift
      ;;
    --)
      shift
      RUN_ARGS=("$@")
      break
      ;;
    *)
      echo "daily.sh: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$OUT" ]; then
  OUT="$HOME/.commandmate/agent-health/reports/$(TZ=Asia/Tokyo date +%F).json"
fi

STARTED_AT="$(node -e 'process.stdout.write(new Date().toISOString())')"
BEFORE="$(git rev-parse HEAD)" || exit 2

# Writes the minimal report and exits 2. $1 = reason.
fail_sync() {
  reason="$1"
  echo "AGENT_HEALTH_SYNC status=failed reason=${reason} before=$(printf '%s' "$BEFORE" | cut -c1-8)"
  AH_OUT="$OUT" AH_STARTED_AT="$STARTED_AT" AH_BEFORE="$BEFORE" AH_REASON="$reason" node -e '
    const fs = require("fs");
    const path = require("path");
    const env = process.env;
    const report = {
      schemaVersion: 1,
      startedAt: env.AH_STARTED_AT,
      completedAt: new Date().toISOString(),
      host: { commandmateCommit: env.AH_BEFORE, node: process.version },
      tools: [],
      safety: { globalConfigRestored: [], tmuxSocket: "cm-agent-health" },
      scriptErrors: ["sync: " + env.AH_REASON],
      sync: { status: "failed", before: env.AH_BEFORE, after: env.AH_BEFORE, reason: env.AH_REASON },
    };
    fs.mkdirSync(path.dirname(env.AH_OUT), { recursive: true });
    fs.writeFileSync(env.AH_OUT, JSON.stringify(report, null, 2) + "\n");
  ' || echo "daily.sh: could not write the report to $OUT" >&2
  exit 2
}

# 3. One run at a time (UAT, this check, a manual run.ts).
# shellcheck source=scripts/uat/run-lock.sh
. scripts/uat/run-lock.sh || fail_sync "run-lock: scripts/uat/run-lock.sh not found"

HAND=""
CHILD=""
CHILD_REAPED=0

# A step of the handover to run.ts's process group failed while this script lives (design
# docs/design/run-lock-machine-lock-4288.md §4.5, table D). The child never works unsignalled. The
# KILL is followed by a `wait` that returns at once, so the child's own 30 s deadline is not waited.
daily_handoff_fail() { # <stage>
  local stage="$1"
  if [ "$stage" = abort ]; then
    # `go` was already there: did the child start (ack) or withdraw?
    case "$(run_lock_abort_settle "$CHILD" "$ACK")" in
      acked) stage=abort-acked ;;
      stuck) kill -s KILL "$CHILD" 2>/dev/null ;;
    esac
  fi
  case "$stage" in
    arg | token | group | tmp | mv)
      # before the publish: the child waits alone in its group, signal its pid only
      kill -s KILL "$CHILD" 2>/dev/null
      wait "$CHILD" 2>/dev/null
      CHILD_REAPED=1
      ;;
    verify | verify-unreadable | signal)
      # published, `go` not made: the group only when the child is alive and leads it, else its pid
      # (a group that is not shown to be ours is not drained either: the release then keeps the lock)
      if [ "$(lock_obs_kill0 pid "$CHILD")" = alive ] && [ "$(lock_obs_pgid handoff-group "$CHILD")" = "$CHILD" ]; then
        kill -s KILL -- "-$CHILD" 2>/dev/null
        wait "$CHILD" 2>/dev/null
        CHILD_REAPED=1
        lock_drain_group "$RUN_LOCK_G" 1
      else
        kill -s KILL "$CHILD" 2>/dev/null
        wait "$CHILD" 2>/dev/null
        CHILD_REAPED=1
      fi
      ;;
    abort)
      # the child withdrew without an ack and ended
      wait "$CHILD" 2>/dev/null
      CHILD_REAPED=1
      ;;
    abort-acked)
      # the child started under T1: wait for it as on the normal path, then drain its group
      wait "$CHILD" 2>/dev/null
      CHILD_REAPED=1
      [ -z "$RUN_LOCK_G" ] || lock_drain_group "$RUN_LOCK_G" 0
      ;;
  esac
  fail_sync "handoff-failed stage=${stage%%-*}"
}

# EXIT (INT and TERM end in `exit 130/143`, so they come here): a child not yet waited for is stopped
# first (its group when the lock names it), then the lock is released once - D12 keeps it while the
# group has a member.
# shellcheck disable=SC2329 # run by the EXIT trap below
daily_on_exit() {
  if [ -n "$CHILD" ] && [ "$CHILD_REAPED" != 1 ]; then
    if [ -n "$RUN_LOCK_G" ]; then
      lock_stop_gate "$RUN_LOCK_G" "$CHILD"
    else
      kill -s KILL "$CHILD" 2>/dev/null
      wait "$CHILD" 2>/dev/null
    fi
    CHILD_REAPED=1
  fi
  run_lock_release "$T0"
  [ -z "$HAND" ] || rm -rf "$HAND"
}

# Not a child of another run: a token left in the environment would "inherit" a live run's lock.
unset CM_RUN_LOCK_TOKEN
T0="daily-$$-$(date -u +%Y%m%d%H%M%S)-$RANDOM"
if ! run_lock_acquire daily $$ "$T0"; then
  echo "daily.sh: $RUN_LOCK_ERROR" >&2
  fail_sync "run-locked: $RUN_LOCK_ERROR"
fi
# run.ts inherits the lock through this; the child makes it T1 (<T0>-g<its group>) before it execs.
export CM_RUN_LOCK_TOKEN="$T0"
trap daily_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# 4. Never pull over local edits to tracked files.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short --untracked-files=no >&2
  fail_sync "dirty-worktree"
fi

# 5. Fast-forward only. git's stdout goes to stderr; its stderr is captured
#    (and echoed) so the last line can be the failure reason.
exec 3>&2
PULL_ERR="$(git pull --ff-only origin develop 2>&1 1>&3)"
PULL_STATUS=$?
exec 3>&-
if [ -n "$PULL_ERR" ]; then
  printf '%s\n' "$PULL_ERR" >&2
fi
if [ "$PULL_STATUS" -ne 0 ]; then
  LAST_LINE="$(printf '%s\n' "$PULL_ERR" | sed '/^[[:space:]]*$/d' | tail -n 1)"
  fail_sync "pull-failed: ${LAST_LINE:-git pull exited $PULL_STATUS}"
fi

AFTER="$(git rev-parse HEAD)" || fail_sync "pull-failed: git rev-parse HEAD failed"

# 7. Compare the two commits directly (HEAD@{1} points at an older move on a no-op day).
NPM_INSTALL="skipped"
if ! git diff --quiet "$BEFORE" "$AFTER" -- package-lock.json; then
  NPM_INSTALL_CMD="${AGENT_HEALTH_NPM_INSTALL_CMD:-npm install --include=dev}"
  # A subshell, so an `exit` in the override cannot end this script.
  if ! (eval "$NPM_INSTALL_CMD") >&2; then
    fail_sync "npm-install-failed"
  fi
  NPM_INSTALL="done"
fi

echo "AGENT_HEALTH_SYNC status=ok before=$(printf '%s' "$BEFORE" | cut -c1-8) after=$(printf '%s' "$AFTER" | cut -c1-8) npm_install=${NPM_INSTALL}"

if [ "$SYNC_ONLY" -eq 1 ]; then
  exit 0
fi

# run.ts is the one process this lock protects, so it is started as the leader of a group of its own
# that waits for a signal; the owner is rewritten with that group (T1) and only then is the signal
# made (run_lock_set_pid). The child execs only after it, and sets CM_RUN_LOCK_TOKEN to T1 first, which
# run.ts inherits as a member of that group. Its stdin is /dev/null: a background group that read the
# terminal would be stopped (SIGTTIN) with the lock held. The child reads the machine-lock.sh of the
# tree after the pull; this script keeps the one it loaded before it.
HAND="$(mktemp -d "${TMPDIR:-/tmp}/cm-daily-hand.XXXXXX")" || fail_sync "handoff-failed stage=arg"
GO="$HAND/go"
ACK="$HAND/ack"
DEADLINE=$(($(date +%s) + HANDOFF_WAIT_SEC))
# ${arr[@]+...} keeps an empty array from expanding to "" on bash 3.2.
set -m
/bin/bash -c '. "$1" || exit 75; lock_child_wait "$2" "$3" "$4" "$5" || exit 75; export CM_RUN_LOCK_TOKEN="$CM_RUN_LOCK_TOKEN-g$$"; shift 6; exec "$@"' \
  cm-daily-child "$PWD/scripts/lib/machine-lock.sh" "$GO" "$ACK" "$DEADLINE" "$$" -- \
  npx tsx scripts/agent-health/run.ts --out "$OUT" --synced-from "$BEFORE" ${RUN_ARGS[@]+"${RUN_ARGS[@]}"} </dev/null &
CHILD=$!
set +m
run_lock_set_pid "$T0" "$$" "$CHILD" "$GO" || daily_handoff_fail "$RUN_LOCK_STAGE"
wait "$CHILD"
CODE=$?
CHILD_REAPED=1
# The leader is reaped: what is left of its group is drained (nothing is sent when it is empty).
[ -z "$RUN_LOCK_G" ] || lock_drain_group "$RUN_LOCK_G" 0
exit "$CODE"
