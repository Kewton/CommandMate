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
# stdout carries one AGENT_HEALTH_SYNC line from this script (the same line may appear twice when a signal
# lands between its echo and the mark; readers count identical lines as one); git and npm output goes to stderr.
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

# R-SIG (#4288): every end of this script after this point goes through daily_exit or one of the five handlers below,
# and each of them ignores INT, TERM, HUP, PIPE and QUIT as its first command, so a second signal cannot end the EXIT
# trap before the AGENT_HEALTH_SYNC line is out and the lock is released (an `exit` inside the EXIT trap does not come
# back). KILL cannot be caught and is outside this rule.
daily_exit() { # <code>
  trap '' INT TERM HUP PIPE QUIT
  exit "$1"
}

# The one AGENT_HEALTH_SYNC line. Every line goes out through emit_sync_line, the only place that prints one:
# the line about to be printed is put in SYNC_PLANNED_LINE, echoed, and only then marked in SYNC_LINE_PRINTED.
# SYNC_OK_LINE is set once the sync has succeeded. A signal between the echo and the mark makes daily_on_exit
# print the planned line again (the ok line if ok was planned, the failed line if failed was planned): the same
# line twice, never two different ones. All three are set here, before the EXIT trap, so the environment cannot.
SYNC_OK_LINE=""
SYNC_PLANNED_LINE=""
SYNC_LINE_PRINTED=0
emit_sync_line() { # <the whole line>
  SYNC_PLANNED_LINE="$1"
  echo "$SYNC_PLANNED_LINE"
  SYNC_LINE_PRINTED=1
}

# Writes the minimal report and exits 2. $1 = reason. KEEP_REPORT=1 (run.ts started and may have written its
# own report): that report is kept when it was written after the handover began (newer than `go`).
fail_sync() {
  reason="$1"
  emit_sync_line "AGENT_HEALTH_SYNC status=failed reason=${reason} before=$(printf '%s' "$BEFORE" | cut -c1-8)"
  if [ "${KEEP_REPORT:-0}" = 1 ] && [ -f "$OUT" ] && [ -n "${GO:-}" ] && [ "$OUT" -nt "$GO" ]; then
    daily_exit 2
  fi
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
  daily_exit 2
}

# 3. One run at a time (UAT, this check, a manual run.ts).
# shellcheck source=scripts/uat/run-lock.sh
. scripts/uat/run-lock.sh || fail_sync "run-lock: scripts/uat/run-lock.sh not found"

HAND=""
CHILD=""
CHILD_REAPED=0
# 1 once the group of the lock (RUN_LOCK_G) was drained after its leader was reaped: an EXIT that comes between
# the reaping and the end of the drain drains it again (it was not, before).
GROUP_DRAINED=0

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
      # before the publish: the child waits alone in its group, signal its pid only (no group to drain after it)
      GROUP_DRAINED=1
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
        GROUP_DRAINED=1
      else
        GROUP_DRAINED=1 # not shown to be ours: the EXIT trap does not drain it either
        kill -s KILL "$CHILD" 2>/dev/null
        wait "$CHILD" 2>/dev/null
        CHILD_REAPED=1
      fi
      ;;
    abort)
      # the child withdrew without an ack and ended (alone in its group: nothing to drain after it)
      GROUP_DRAINED=1
      wait "$CHILD" 2>/dev/null
      CHILD_REAPED=1
      ;;
    abort-acked)
      # the child started under T1: wait for it as on the normal path, then drain its group; the report
      # run.ts wrote is not overwritten by the minimal one
      KEEP_REPORT=1
      wait "$CHILD" 2>/dev/null
      CHILD_REAPED=1
      [ -z "$RUN_LOCK_G" ] || lock_drain_group "$RUN_LOCK_G" 0
      GROUP_DRAINED=1
      ;;
  esac
  fail_sync "handoff-failed stage=${stage%%-*}"
}

# EXIT (INT, TERM, HUP, PIPE and QUIT end in `exit 128+n` after ignoring all five, the other ends in daily_exit, so
# the five are ignored before this runs): a line that was planned but not marked as printed is printed as planned (the ok line;
# never failed). A run that synced, has no planned line and has not said anything yet (interrupted before the
# child's receipt) says it failed, once - the one AGENT_HEALTH_SYNC line is never missing after the sync. Then a
# child not yet waited for is stopped first (its group when the lock names it), a group whose leader was reaped but
# that was not drained is drained, and the lock is released once - D12 keeps it while the group has a member, and a
# release that did not remove it (not released / none) is said on stderr.
# Only the main shell runs it: bash keeps the EXIT trap string across a fork, and a subshell signalled between the
# fork and the reset of its handlers would run it (verify-run.sh cleanup_workdir, Issue #228).
# shellcheck disable=SC2329 # run by the EXIT trap below
daily_on_exit() { # <exit code>
  [ "${BASH_SUBSHELL:-0}" -eq 0 ] || return 0
  # R-SIG: the five are already ignored by every way in (the handlers, daily_exit); this keeps it so for any other.
  trap '' INT TERM HUP PIPE QUIT
  local rc="$1"
  if [ -n "$SYNC_PLANNED_LINE" ] && [ "$SYNC_LINE_PRINTED" != 1 ]; then
    emit_sync_line "$SYNC_PLANNED_LINE"
  elif [ -n "$SYNC_OK_LINE" ] && [ -z "$SYNC_PLANNED_LINE" ] && [ "$SYNC_LINE_PRINTED" != 1 ]; then
    emit_sync_line "AGENT_HEALTH_SYNC status=failed reason=interrupted exit=${rc} before=$(printf '%s' "$BEFORE" | cut -c1-8)"
  fi
  if [ -n "$CHILD" ] && [ "$CHILD_REAPED" != 1 ]; then
    if [ -n "$RUN_LOCK_G" ]; then
      lock_stop_gate "$RUN_LOCK_G" "$CHILD"
      GROUP_DRAINED=1
    else
      kill -s KILL "$CHILD" 2>/dev/null
      wait "$CHILD" 2>/dev/null
    fi
    CHILD_REAPED=1
  fi
  if [ -n "$RUN_LOCK_G" ] && [ "$GROUP_DRAINED" != 1 ]; then
    # the leader was reaped but its group was not drained (or the drain was cut short): TERM again, then KILL
    lock_drain_group "$RUN_LOCK_G" 0
    GROUP_DRAINED=1
  fi
  run_lock_release "$T0"
  case "$RUN_LOCK_RESULT" in
    released | none) ;;
    *) echo "daily.sh: the run lock was not released (${RUN_LOCK_RESULT:-unknown}${RUN_LOCK_ERROR:+: $RUN_LOCK_ERROR}); it is left for the next run to take over" >&2 ;;
  esac
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
trap 'daily_on_exit "$?"' EXIT
# R-SIG: an explicit handler for each of the five, whose first command ignores all five; then exit 128+n.
# Without one (bash 3.2): TERM/HUP/PIPE run EXIT with $?=0 then die, QUIT skips EXIT (lock left), INT may not end it.
trap 'trap "" INT TERM HUP PIPE QUIT; exit 130' INT
trap 'trap "" INT TERM HUP PIPE QUIT; exit 143' TERM
trap 'trap "" INT TERM HUP PIPE QUIT; exit 129' HUP
trap 'trap "" INT TERM HUP PIPE QUIT; exit 141' PIPE
trap 'trap "" INT TERM HUP PIPE QUIT; exit 131' QUIT

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

SYNC_OK_LINE="AGENT_HEALTH_SYNC status=ok before=$(printf '%s' "$BEFORE" | cut -c1-8) after=$(printf '%s' "$AFTER" | cut -c1-8) npm_install=${NPM_INSTALL}"

if [ "$SYNC_ONLY" -eq 1 ]; then
  emit_sync_line "$SYNC_OK_LINE"
  daily_exit 0
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
# ${arr[@]+...} keeps an empty array from expanding to "" on bash 3.2. The child is a subshell that execs at once
# (same pid, the leader of its group): in the fork window it is a subshell (BASH_SUBSHELL=1), so the EXIT trap string
# it inherits returns at once in daily_on_exit's guard if a signal to the group lands there.
set -m
( exec /bin/bash -c '. "$1" || exit 75; lock_child_wait "$2" "$3" "$4" "$5" || exit 75; export CM_RUN_LOCK_TOKEN="$CM_RUN_LOCK_TOKEN-g$$"; shift 6; exec "$@"' \
  cm-daily-child "$PWD/scripts/lib/machine-lock.sh" "$GO" "$ACK" "$DEADLINE" "$$" -- \
  npx tsx scripts/agent-health/run.ts --out "$OUT" --synced-from "$BEFORE" ${RUN_ARGS[@]+"${RUN_ARGS[@]}"} ) </dev/null &
CHILD=$!
set +m
run_lock_set_pid "$T0" "$$" "$CHILD" "$GO" || daily_handoff_fail "$RUN_LOCK_STAGE"
# The one AGENT_HEALTH_SYNC line: the `ok` line is made once the child has made its receipt (it will exec
# run.ts) or has ended. A handover that failed has already written its own (status=failed). A child that ends
# with 75 and no receipt never exec'd: that is the failed line only (stage=ack, below). A child that ends with
# any other code and no receipt (a signal from outside before it exec'd) gets the `ok` line once it is reaped:
# the sync itself succeeded and its exit code is passed on. An interruption of this script before any line is
# made is the failed line of daily_on_exit. A planned line that was not marked printed is printed again as planned by
# daily_on_exit: at most the same line twice, never ok and failed together.
while [ ! -e "$ACK" ]; do
  CHILD_STAT="$(ps -o stat= -p "$CHILD" 2>/dev/null | tr -d ' ')"
  case "$CHILD_STAT" in '' | Z*) break ;; esac
  [ "$(date +%s)" -le $((DEADLINE + 2)) ] || break
  sleep 0.05
done
if [ -e "$ACK" ]; then
  emit_sync_line "$SYNC_OK_LINE"
fi
wait "$CHILD"
CODE=$?
CHILD_REAPED=1
# The leader is reaped: what is left of its group is drained (nothing is sent when it is empty).
[ -z "$RUN_LOCK_G" ] || lock_drain_group "$RUN_LOCK_G" 0
GROUP_DRAINED=1
# The child ended with 75 before it made its receipt: it never exec'd run.ts (it could not make `ack`, or could
# not read machine-lock.sh of the pulled tree). That is a failed handover, not run.ts's exit code (table D, ack).
if [ "$CODE" -eq 75 ] && [ ! -e "$ACK" ]; then
  fail_sync "handoff-failed stage=ack"
fi
if [ "$SYNC_LINE_PRINTED" != 1 ]; then
  emit_sync_line "$SYNC_OK_LINE"
fi
daily_exit "$CODE"
