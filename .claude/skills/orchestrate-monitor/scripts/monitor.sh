#!/usr/bin/env bash
# monitor.sh — supervise one or more orchestrate workers with the tested
# decision core (classify-state.sh / verify-completion.sh).
#
# This is the operator entrypoint. The per-poll classification and the
# completion decision live in separate, unit-tested scripts; this file only
# owns the loop, the cross-poll state, and the interventions. It is checked by
# `bash -n` in the test suite and written for bash 3.2 (macOS /bin/bash):
#   - no associative arrays: per-worker state is held in integer-indexed
#     parallel arrays and in temp files under $STATE_DIR
#   - loop variables are never named `path` (that special-var name clobbers PATH
#     under zsh/bash and breaks curl/tmux lookups; feedback_zsh_path_loop_var)
#
# Interventions, in order of how much damage a false positive does:
#   PROMPT      -> Enter (silent auto-approve, counted)
#   RATE_LIMIT  -> "a" immediately, never sleep through a limit
#   IDLE + terminal API error at the idle threshold -> resend --resend-message,
#               capped by --max-resends. This is the only recovery from the CLI
#               exhausting its own retries (Issue #1522): a live backoff is
#               classified GENERATING and must NOT be touched, because input sent
#               mid-backoff is queued and then delivered after the retry succeeds.
#
# Every one of them goes through send_to_pane(), which verifies the session exists
# and reports a failed delivery instead of swallowing it, and every log line and
# counter describes what was DELIVERED rather than what was attempted (Issue
# #1601 — see monitor-lib.sh § "tmux session targeting" for what the old
# `2>/dev/null || true` hid).
#
# Usage:
#   monitor.sh [--interval 20] [--idle-threshold 8] [--session-prefix <prefix>] \
#              [--resend-message continue] [--max-resends 2] [--max-polls 0] \
#              [--verbose] [--hooks <file>] \
#              <worktree-id>[@<instance-id>] [<worktree-id>[@<instance-id>] ...]
#
#   <worktree-id>[@<instance-id>]
#                  the worker to watch, optionally a named agent instance
#                  (`w1@codex-2`, `w1@claude`). The instance selects BOTH the pane
#                  that is polled (`capture --agent <tool> --instance <id>`) and
#                  the pane an intervention is typed into, so classification and
#                  intervention can never drift onto different sessions. The same
#                  worktree may be listed more than once with different instances;
#                  per-worker state and log lines are keyed by `<id>@<instance>`.
#
#   --session-prefix <p>
#                  LEGACY escape hatch. Session names are derived from the capture
#                  payload's cliToolId by default (`mcbd-<cliToolId>-<worktree-id>`),
#                  which is what makes a heterogeneous fleet work without any flag.
#                  Passing this replaces the derived `mcbd-<cliToolId>` head with
#                  <p>; the instance suffix is still appended. Only needed for a
#                  session this tool did not create.
#
#   --max-polls N  stop after N poll rounds and exit 0 even if workers are still
#                  working; 0 (default) keeps polling until every worker is
#                  COMPLETE, i.e. the operator behaviour is unchanged. A bounded
#                  run ends on its own instead of having to be killed from the
#                  outside, which is what lets the loop be tested deterministically
#                  (Issue #1527) and doubles as a one-shot `--max-polls 1` probe.
#                  It only adds a stop condition — no state or intervention rule
#                  looks at it.
#
#   --verbose      emit one fixed-format line per poll per worker (see POLL_LINE
#                  below). Opt-in on purpose: the default output stays byte-identical
#                  so an operator reading the stream still sees only interventions
#                  and terminal verdicts (Issue #1533).
#
#   --hooks <file> source <file> after the built-in count_commits /
#                  count_uncommitted / read_task_status stubs, so an operator can
#                  supply the real data sources (Issue #1533, #1581). Repeatable,
#                  sourced left to right; giving it at all replaces MONITOR_HOOKS.
#                  Without it the counters return 0 and the task status is empty,
#                  which is what keeps the loop runnable standalone — and also what
#                  makes COMPLETE unreachable, since verify-completion.sh treats
#                  commits=0 && uncommitted=0 as the signature of an unstarted task.
#                  See hooks-git.sh (work counters) and hooks-task.sh (contract
#                  status) for ready-to-use implementations.
#
# Env:
#   CM             — commandmate launcher (default: "npx commandmate@latest"; pinned
#                    so the npx cache cannot resume a stale binary).
#   MONITOR_HOOKS  — default for --hooks (the flag wins when both are given).
set -u

INTERVAL=20
IDLE_THRESHOLD=8          # 150s+ of idle at 20s polls; xhigh workers think long
SESSION_PREFIX=""         # empty = derive from the poll's cliToolId (the default)
RESEND_MESSAGE="continue"  # sent after the CLI exhausts its own retries
MAX_RESENDS=2
MAX_POLLS=0               # 0 = poll until every worker is COMPLETE (operator default)
VERBOSE=0                 # 0 = default stream (interventions + verdicts only)
CM=${CM:-"npx commandmate@latest"}

# bash 3.2: plain indexed array, appended with += so an empty array is never
# expanded under `set -u`.
HOOKS_FILES=()
if [ -n "${MONITOR_HOOKS:-}" ]; then
  HOOKS_FILES+=("$MONITOR_HOOKS")
fi
hooks_from_flag=0

while [ $# -gt 0 ]; do
  case "$1" in
    --interval) shift; INTERVAL=${1:-20};;
    --idle-threshold) shift; IDLE_THRESHOLD=${1:-8};;
    --session-prefix) shift; SESSION_PREFIX=${1:-};;
    --resend-message) shift; RESEND_MESSAGE=${1:-continue};;
    --max-resends) shift; MAX_RESENDS=${1:-2};;
    --max-polls) shift; MAX_POLLS=${1:-0};;
    --verbose) VERBOSE=1;;
    --hooks)
      shift
      # The first flag drops the MONITOR_HOOKS default (the flag wins); later
      # ones add to it, so work counters and task status can come from two files.
      if [ "$hooks_from_flag" = "0" ]; then
        HOOKS_FILES=()
        hooks_from_flag=1
      fi
      HOOKS_FILES+=("${1:-}")
      ;;
    --) shift; break;;
    -*) echo "monitor.sh: unknown flag $1" >&2; exit 2;;
    *) break;;
  esac
  shift
done

if [ $# -eq 0 ]; then
  echo "monitor.sh: at least one worktree-id is required" >&2
  exit 2
fi

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CLASSIFY="$SCRIPT_DIR/classify-state.sh"
VERIFY="$SCRIPT_DIR/verify-completion.sh"
. "$SCRIPT_DIR/monitor-lib.sh"

STATE_DIR=$(mktemp -d -t cm-monitor.XXXXXX)
cleanup() { rm -rf "$STATE_DIR"; }
trap cleanup EXIT INT TERM

# Integer-indexed parallel arrays (bash 3.2 has no associative arrays).
#   IDS       worktree id  — what capture and the completion hooks are given
#   INSTANCES agent instance id, "" for the tool's primary instance
#   CAP_ARGS  the extra `capture` flags for this worker ("" for the primary)
#   LABELS    the state/log key: "<id>" or "<id>@<instance>", so the same worktree
#             can be watched on two panes without the two sharing a streak
IDS=()
INSTANCES=()
CAP_ARGS=()
LABELS=()

# Both patterns mirror the server-side validators the ids end up in
# (WORKTREE_ID_PATTERN / INSTANCE_ID_PATTERN in src/cli/utils/api-client.ts). They
# are enforced here because these ids are interpolated into a tmux target: the
# product validates a session name before running tmux (validateSessionName,
# src/lib/cli-tools/validation.ts) and this loop must not be the weaker path.
for spec in "$@"; do
  case "$spec" in
    *@*)
      spec_wid=${spec%%@*}
      spec_instance=${spec#*@}
      if [ -z "$spec_instance" ]; then
        echo "monitor.sh: '$spec' has no instance id after '@'" >&2
        exit 2
      fi
      ;;
    *)
      spec_wid=$spec
      spec_instance=""
      ;;
  esac

  if ! printf '%s' "$spec_wid" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9_-]*$'; then
    echo "monitor.sh: invalid worktree id '$spec_wid' (expected [a-zA-Z0-9][a-zA-Z0-9_-]*)" >&2
    exit 2
  fi
  if [ -n "$spec_instance" ] && ! printf '%s' "$spec_instance" | grep -qE '^[a-zA-Z0-9_-]+$'; then
    echo "monitor.sh: invalid instance id '$spec_instance' (expected [a-zA-Z0-9_-]+)" >&2
    exit 2
  fi

  spec_args=""
  spec_label=$spec_wid
  if [ -n "$spec_instance" ]; then
    spec_label="$spec_wid@$spec_instance"
    spec_args="--instance $spec_instance"
    # The server resolves the CLI tool from the worktree row when `--agent` is
    # omitted (src/app/api/worktrees/[id]/current-output/route.ts), NOT from the
    # instance id — so polling a codex instance of a claude-default worktree
    # without --agent looks at mcbd-claude-<wt>-codex-2, a pane that does not
    # exist. Recovering the agent from the instance id keeps the poll on the
    # instance's own session.
    spec_agent=$(ml_agent_from_instance "$spec_instance") || spec_agent=""
    if [ -n "$spec_agent" ]; then
      spec_args="--agent $spec_agent $spec_args"
    fi
  fi

  IDS+=("$spec_wid")
  INSTANCES+=("$spec_instance")
  CAP_ARGS+=("$spec_args")
  LABELS+=("$spec_label")
done

n_ids=${#IDS[@]}

i=0
while [ "$i" -lt "$n_ids" ]; do
  lbl=${LABELS[$i]}
  echo "0" > "$STATE_DIR/$lbl.streak"
  echo "0" > "$STATE_DIR/$lbl.started"
  echo "0" > "$STATE_DIR/$lbl.approvals"
  echo "0" > "$STATE_DIR/$lbl.resends"
  i=$((i + 1))
done

# read_state <label> <suffix> -> echoes stored value (0 if missing)
read_state() {
  cat "$STATE_DIR/$1.$2" 2>/dev/null || echo 0
}

# send_to_pane <label> <session> <what> <key> [<key> ...]
#
# The ONLY place this loop types into a worker, and the reason every caller can
# log a result instead of an intention (Issue #1601). It returns 0 only when tmux
# accepted the keys, so a caller may count an approval or spend a resend only on
# a real delivery.
#
# Three distinct failures, each reported rather than swallowed, because each needs
# a different fix from the operator: no session name could be derived, the session
# does not exist, tmux itself refused. The previous `2>/dev/null || true` made all
# three indistinguishable from success — which is how a default prefix that
# matched nothing survived: the loop kept printing "sending 'a'" at a session that
# had never existed.
#
# Failures go to stderr: stdout is the operator's intervention/verdict stream and
# a failed intervention is not an intervention. The documented run captures both
# (`2>&1 | tee monitor.log`).
send_to_pane() {
  sp__label=$1
  sp__session=$2
  sp__what=$3
  shift 3

  if [ -z "$sp__session" ]; then
    echo "monitor[$sp__label]: $sp__what NOT delivered — no tmux session could be derived (capture payload carries no cliToolId; pass --session-prefix)" >&2
    return 1
  fi

  sp__target=$(ml_tmux_target "$sp__session")
  if ! tmux has-session -t "$sp__target" 2>/dev/null; then
    echo "monitor[$sp__label]: $sp__what NOT delivered — no tmux session '$sp__session' (check 'tmux ls'; watch <worktree-id>@<instance-id> or pass --session-prefix)" >&2
    return 1
  fi
  if ! tmux send-keys -t "$sp__target" "$@"; then
    echo "monitor[$sp__label]: $sp__what NOT delivered — tmux send-keys to '$sp__session' failed" >&2
    return 1
  fi
  return 0
}

# count_uncommitted <worktree-id>: best-effort change count. Left to the operator
# to wire to the worker's checkout; returns 0 here so the loop stays runnable.
count_uncommitted() {
  echo 0
}
count_commits() {
  echo 0
}

# read_task_status <worktree-id>: the status the server recorded for the
# worktree's newest execution contract, or empty when there is no answer. Stubbed
# to empty so a contract-less run behaves exactly as before — verify-completion.sh
# then falls back to the capture heuristics. See hooks-task.sh (Issue #1581).
read_task_status() {
  echo ""
}

# Completion hooks. The stubs above are the reason a stock run never reports
# COMPLETE: verify-completion.sh reads commits=0 && uncommitted=0 as "the task was
# never sent" (the STARTED-guard signature), so the COMPLETE branch is unreachable
# until the counters are wired to the worker's checkout. Sourcing happens *after*
# the stubs so a hooks file that defines any of the names wins, and a hooks file
# that defines only one leaves the others stubbed.
if [ ${#HOOKS_FILES[@]} -gt 0 ]; then
  for hooks_file in "${HOOKS_FILES[@]}"; do
    if [ ! -f "$hooks_file" ]; then
      echo "monitor.sh: hooks file not found: $hooks_file" >&2
      exit 2
    fi
    . "$hooks_file"
  done
fi

echo "monitor: watching $n_ids worker(s), interval=${INTERVAL}s, idle-threshold=${IDLE_THRESHOLD}, max-resends=${MAX_RESENDS}"

poll_round=0
done_count=0
while [ "$done_count" -lt "$n_ids" ]; do
  done_count=0
  i=0
  while [ "$i" -lt "$n_ids" ]; do
    wid=${IDS[$i]}
    inst=${INSTANCES[$i]}
    cap_args=${CAP_ARGS[$i]}
    lbl=${LABELS[$i]}
    i=$((i + 1))

    if [ -f "$STATE_DIR/$lbl.done" ]; then
      done_count=$((done_count + 1))
      continue
    fi

    poll="$STATE_DIR/$lbl.poll.json"
    # cap_args is unquoted on purpose: it is either empty or the validated
    # `--agent <tool> --instance <id>` pair, neither of which can contain a space.
    # shellcheck disable=SC2086
    if ! $CM capture "$wid" --json $cap_args > "$poll" 2>/dev/null; then
      # Transient empty/parse frame (redraw): do not advance the idle streak,
      # do not treat as idle (feedback_orchestrate_monitor_recipe).
      echo "monitor[$lbl]: capture failed, skipping poll"
      continue
    fi

    state=$("$CLASSIFY" --json "$poll")

    # The intervention target, derived from THIS poll: the tool the server just
    # resolved for this worktree/instance, so the pane we may type into is the
    # pane we just classified. Announced once per worker because a misdirected
    # intervention is otherwise invisible until the first one is needed — and by
    # then a missed approval has already stalled the worker (Issue #1601).
    cli_tool=$(ml_json_scalar "$poll" cliToolId)
    session=$(ml_session_name "$wid" "$cli_tool" "$inst" "$SESSION_PREFIX") || session=""
    if [ ! -f "$STATE_DIR/$lbl.target" ] && [ -n "$session" ]; then
      echo "$session" > "$STATE_DIR/$lbl.target"
      echo "monitor[$lbl]: intervention target = $session"
    fi

    started=$(read_state "$lbl" started)
    streak=$(read_state "$lbl" streak)

    case "$state" in
      GENERATING)
        echo "1" > "$STATE_DIR/$lbl.started"
        echo "0" > "$STATE_DIR/$lbl.streak"
        ;;
      RATE_LIMIT)
        # Resume immediately; never sleep through a rate limit. The log follows
        # the send and names the session, so "resumed" cannot be claimed for keys
        # that went nowhere.
        if send_to_pane "$lbl" "$session" "rate limit 'a'" a Enter; then
          echo "monitor[$lbl]: rate limit -> sent 'a' to $session"
        fi
        echo "0" > "$STATE_DIR/$lbl.streak"
        ;;
      PROMPT)
        # Silent auto-approve, so the notifier is not flooded — but the counter
        # moves ONLY on a delivered Enter, so `approvals=` on the COMPLETE line is
        # a count of approvals that happened. Before #1601 it counted attempts at
        # a session that did not exist, i.e. the loop reported approvals it had
        # never made. Silence still means "approved"; a miss is on stderr.
        if send_to_pane "$lbl" "$session" "prompt approval Enter" Enter; then
          approvals=$(read_state "$lbl" approvals)
          approvals=$((approvals + 1))
          echo "$approvals" > "$STATE_DIR/$lbl.approvals"
        fi
        echo "0" > "$STATE_DIR/$lbl.streak"
        ;;
      IDLE)
        streak=$((streak + 1))
        echo "$streak" > "$STATE_DIR/$lbl.streak"
        # Retry-exhaustion death: the CLI burned through its own backoff
        # (`attempt 10/10`), printed a terminal API error and fell back to an idle
        # prompt. Nothing resumes from here on its own, and without a resend the
        # worker is either left forever or — worse — reported COMPLETE with
        # half-finished uncommitted work once the streak crosses the threshold.
        # Deliberately narrow, because this branch injects input:
        #   - IDLE only, so a live backoff (GENERATING via ml_is_retrying) and an
        #     open prompt are never interrupted;
        #   - the idle threshold must already be reached, so a transient frame
        #     cannot trigger it;
        #   - ml_has_terminal_api_error reads the current pane only, so an error
        #     that has scrolled out of view after a successful resume no longer
        #     counts;
        #   - capped by --max-resends, then escalated to the operator.
        if [ "$streak" -ge "$IDLE_THRESHOLD" ] && ml_has_terminal_api_error "$poll"; then
          resends=$(read_state "$lbl" resends)
          if [ "$resends" -lt "$MAX_RESENDS" ]; then
            # Budget and streak move only on a delivered resend: a resend that
            # never reached a pane must not spend the budget and then escalate as
            # "budget spent", which would report an exhausted recovery that was
            # never attempted. An undelivered one keeps the streak, so the next
            # poll retries and keeps reporting the failure.
            if send_to_pane "$lbl" "$session" "resend '$RESEND_MESSAGE'" "$RESEND_MESSAGE" Enter; then
              resends=$((resends + 1))
              echo "$resends" > "$STATE_DIR/$lbl.resends"
              echo "monitor[$lbl]: terminal API error at an idle prompt -> resent to $session ($resends/$MAX_RESENDS)"
              echo "0" > "$STATE_DIR/$lbl.streak"
            fi
          else
            echo "monitor[$lbl]: terminal API error and resend budget spent ($MAX_RESENDS) — operator needed"
          fi
        fi
        ;;
      NOT_RUNNING)
        # No pane to type into; the streak drives the NOT_STARTED report instead.
        streak=$((streak + 1))
        echo "$streak" > "$STATE_DIR/$lbl.streak"
        ;;
    esac

    post_started=$(read_state "$lbl" started)
    post_streak=$(read_state "$lbl" streak)
    commits=$(count_commits "$wid")
    uncommitted=$(count_uncommitted "$wid")
    task_status=$(read_task_status "$wid")

    verdict=$("$VERIFY" \
      --started "$post_started" \
      --state "$state" \
      --idle-streak "$post_streak" \
      --idle-threshold "$IDLE_THRESHOLD" \
      --commits "$commits" \
      --uncommitted "$uncommitted" \
      --task-status "$task_status")

    # POLL_LINE — one line per poll per worker, opt-in via --verbose. Fixed field
    # order so a run can be reduced mechanically, e.g.
    #   grep -o 'poll [0-9]* -> [A-Z_]*' log | awk '{print $4}' | sort | uniq -c
    # gives the state distribution, and the trailing key=value pairs carry the
    # inputs verify-completion.sh actually saw, i.e. the evidence behind the
    # verdict rather than the verdict alone (Issue #1533, #1513 G2).
    if [ "$VERBOSE" = "1" ]; then
      echo "monitor[$lbl]: poll $((poll_round + 1)) -> $state started=$post_started streak=$post_streak commits=$commits uncommitted=$uncommitted task=${task_status:--} verdict=$verdict"
    fi

    case "$verdict" in
      COMPLETE)
        echo "monitor[$lbl]: COMPLETE (approvals=$(read_state "$lbl" approvals))"
        touch "$STATE_DIR/$lbl.done"
        done_count=$((done_count + 1))
        ;;
      VERIFY_FAILED)
        # Terminal like COMPLETE — the contract has been adjudicated, so there is
        # nothing left to wait for — but explicitly not mergeable. Named
        # differently so an operator scanning the stream cannot read it as a pass.
        echo "monitor[$lbl]: VERIFY_FAILED — contract gates failed; do not merge. Run 'commandmate verify $wid --json' for the failing gate, then re-instruct"
        touch "$STATE_DIR/$lbl.done"
        done_count=$((done_count + 1))
        ;;
      NOT_STARTED)
        if [ "$(read_state "$lbl" streak)" -ge "$IDLE_THRESHOLD" ]; then
          echo "monitor[$lbl]: NOT_STARTED — idle with no work; check the composer / Enter"
        fi
        ;;
    esac
  done

  poll_round=$((poll_round + 1))
  # Deterministic stop for bounded runs: end the loop from the inside after
  # MAX_POLLS rounds rather than relying on something outside to kill it. Checked
  # after the completion tally so a run that finishes on its final round still
  # reports "all complete"; skipped entirely when MAX_POLLS is 0.
  if [ "$done_count" -lt "$n_ids" ] && [ "$MAX_POLLS" -gt 0 ] && [ "$poll_round" -ge "$MAX_POLLS" ]; then
    echo "monitor: reached --max-polls ($MAX_POLLS) after $poll_round poll round(s); stopping"
    exit 0
  fi

  [ "$done_count" -lt "$n_ids" ] && sleep "$INTERVAL"
done

echo "monitor: all $n_ids worker(s) complete"
