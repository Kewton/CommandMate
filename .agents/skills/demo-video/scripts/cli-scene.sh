#!/usr/bin/env bash
#
# cli-scene.sh — the `contract-verify` terminal take (Issue #1810).
#
# Runs the real CLI against the isolated demo server, in a tmux pane that
# terminal-scene.ts photographs. Nothing here is staged: `wait --verify` starts
# a verification run on the server, that run executes the seed worktree's own
# `.commandmate/verify.yaml`, and the `GATE`/`RESULT` lines on screen are the
# ones the product printed. SKILL.md's design judgement — only the LLM is
# replaced — applies to the verification gates too, so there is no mock here.
#
# Two invocation modes:
#   --start   create the tmux session that runs this script, record its name,
#             and exit. This is what the recorder calls.
#   (default) the body, executed inside that pane.
#
# Three takes, selected with --mode (Issue #1813):
#   contract    (default) send --contract -> wait --verify -> exit 0
#   verify-red  the gate before any work exists: exit 20 on the seed worktree
#               that carries no fix, so the failing gate on screen is a real
#               `node --test` run and not a screenshot of one
#   evidence    the contract take, then the record it left behind:
#               `verify history` and `task show`
#
# The three share one body rather than three scripts because the isolation
# checks below are the load-bearing part and a copy of them is a copy that
# drifts.
#
# Isolation (all four are load-bearing):
#   * HOME is redirected under the demo state dir, so `~/.commandmate/.env`
#     cannot supply a port and point the CLI at the developer's live server on
#     3000 (#1743).
#   * CM_PORT is exported from state.env; loadClientEnv() lets an exported
#     variable win over the file.
#   * Step 1 asserts that `commandmate ls` sees nothing but this run's own seed
#     worktrees. A production connection fails here, before anything is sent.
#   * The session name is appended to $CM_DEMO_SESSIONS_FILE *before* the
#     session exists, so env-down.sh tears down what it finds recorded and
#     never has to sweep `mcbd-*` on a tmux server holding real work.
#
# bash 3.2 compatible: no associative arrays, no mapfile.

set -u

SESSION="cmdemo-cli"
STATE_FILE=""
TMUX_SOCKET=""
START=0
MODE="contract"
# The pane geometry the card is typeset for: 100 columns renders inside a
# 1280x800 frame at a size that is still legible after the h264 pass.
#
# The row count is a *budget*, not a fit (Issue #1811). templates/terminal.html
# lays the capture out from the top of a body pinned to 736px, one 23px row per
# captured line, so row N lands at roughly y = 42 + (N-1)*23 in the frame. The
# telop band is fixed at `margin-bottom: 7.5%` for every cut and its scrim
# covers y 612..720 (x 273..1006, measured off the rendered overlay PNG), so a
# 32-row pane puts the GATE block underneath it: at 32 rows the transcript ran
# to y 745 and `GATE scope PASS (exit=0, 0.0s)` lost its parenthesis to the
# scrim. 26 rows ends the transcript at y 634 in the worst case, which keeps
# every GATE line, RESULT and the exit code clear of it.
#
# This is a cap rather than an exact fit on purpose: `wait` prints one
# `Waiting: ...` line per poll, so the transcript's length is not fixed. Extra
# output now scrolls off the *top* — where the `ls` table already is — instead
# of pushing the verdict down into the band.
PANE_WIDTH=100
PANE_HEIGHT=26
HOLD_SECONDS="${CM_DEMO_CLI_HOLD:-6}"
WAIT_TIMEOUT="${CM_DEMO_CLI_WAIT_TIMEOUT:-180}"
# The evidence take's tail is the only part of it the cut keeps — compose.sh
# trims from the front — so its hold is what decides how long the record is
# readable, independent of how long the contract before it took to run.
EVIDENCE_HOLD="${CM_DEMO_CLI_EVIDENCE_HOLD:-8}"
# The red-gate take holds two frames, so it has two holds. The first is the
# longer of the two on purpose: compose.sh keeps the *tail* of an over-long
# take, so a short first hold is the one that gets trimmed away, and the frame
# carrying the exit code is the one the step is named after.
RED_FRAME_HOLD="${CM_DEMO_CLI_RED_HOLD:-6}"
RED_TAIL_HOLD="${CM_DEMO_CLI_RED_TAIL_HOLD:-3}"

die() {
  printf 'cli-scene: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: cli-scene.sh --state FILE [--session NAME] [--tmux-socket NAME]
                    [--mode contract|verify-red|evidence] [--start]

  --state FILE        state.env written by env-up.sh (required)
  --session NAME      tmux session name (default cmdemo-cli)
  --tmux-socket NAME  tmux -L socket; default is the ambient tmux server
  --mode MODE         which take to run (default contract)
  --start             create the session and exit, instead of being the body
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --state) [ $# -ge 2 ] || die "--state needs a value"; STATE_FILE="$2"; shift 2 ;;
    --session) [ $# -ge 2 ] || die "--session needs a value"; SESSION="$2"; shift 2 ;;
    --tmux-socket) [ $# -ge 2 ] || die "--tmux-socket needs a value"; TMUX_SOCKET="$2"; shift 2 ;;
    --mode) [ $# -ge 2 ] || die "--mode needs a value"; MODE="$2"; shift 2 ;;
    --start) START=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

[ -n "$STATE_FILE" ] || { usage >&2; die "--state is required"; }
[ -f "$STATE_FILE" ] || die "no state file at $STATE_FILE — run env-up.sh first"
case "$SESSION" in
  *[!a-zA-Z0-9_-]*) die "session name must match [a-zA-Z0-9_-]+, got '$SESSION'" ;;
esac
case "$MODE" in
  contract|verify-red|evidence) : ;;
  *) die "--mode must be contract, verify-red or evidence, got '$MODE'" ;;
esac

CM_DEMO_PORT=""
CM_DEMO_STATE_DIR=""
CM_DEMO_SEED_REPO=""
CM_DEMO_SESSIONS_FILE=""
CM_DEMO_PRIMARY_WORKTREE_ID=""
CM_DEMO_WORKTREE_ID=""
CM_DEMO_LOGIN_WORKTREE_ID=""
CM_DEMO_UNSYNCED_WORKTREE_ID=""
CM_DEMO_WORKTREE_PATH=""
# shellcheck source=/dev/null
. "$STATE_FILE"

[ -n "$CM_DEMO_PORT" ] || die "state file has no CM_DEMO_PORT"
[ "$CM_DEMO_PORT" != "3000" ] || die "state file records port 3000; refusing to drive a live CommandMate instance"
[ -n "$CM_DEMO_WORKTREE_ID" ] || die "state file has no CM_DEMO_WORKTREE_ID — re-run env-up.sh"
[ -n "$CM_DEMO_STATE_DIR" ] || die "state file has no CM_DEMO_STATE_DIR"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${CM_DEMO_REPO_ROOT:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"
[ -f "$REPO_ROOT/src/cli/index.ts" ] || die "no src/cli/index.ts under $REPO_ROOT (set CM_DEMO_REPO_ROOT)"

tmux_cmd() {
  if [ -n "$TMUX_SOCKET" ]; then
    tmux -L "$TMUX_SOCKET" "$@"
  else
    tmux "$@"
  fi
}

# --------------------------------------------------------------- start -------

if [ "$START" -eq 1 ]; then
  command -v tmux >/dev/null 2>&1 || die "tmux not found"
  if tmux_cmd has-session -t "=$SESSION" 2>/dev/null; then
    die "tmux session already exists: $SESSION"
  fi
  # Recorded before the session exists, for the same reason fake-agent.sh does
  # it: a session created and then not written down is exactly the leak the
  # record-based teardown was built to prevent (#1809).
  if [ -n "$CM_DEMO_SESSIONS_FILE" ]; then
    printf '%s\n' "$SESSION" >>"$CM_DEMO_SESSIONS_FILE" \
      || die "could not record the session name in $CM_DEMO_SESSIONS_FILE"
  fi
  SELF="$SCRIPT_DIR/$(basename "$0")"
  if [ -n "$TMUX_SOCKET" ]; then
    tmux -L "$TMUX_SOCKET" new-session -d -s "$SESSION" -c "$REPO_ROOT" \
      -x "$PANE_WIDTH" -y "$PANE_HEIGHT" \
      "$SELF" --state "$STATE_FILE" --session "$SESSION" --mode "$MODE" --tmux-socket "$TMUX_SOCKET"
  else
    tmux new-session -d -s "$SESSION" -c "$REPO_ROOT" \
      -x "$PANE_WIDTH" -y "$PANE_HEIGHT" \
      "$SELF" --state "$STATE_FILE" --session "$SESSION" --mode "$MODE"
  fi
  printf '%s\n' "$SESSION"
  exit 0
fi

# ---------------------------------------------------------------- body -------

# `env -u` drops the ambient overrides that would otherwise point the CLI at the
# developer's database or default port, and HOME is redirected so getEnvPath()
# resolves inside the demo state dir.
CLI_HOME="$CM_DEMO_STATE_DIR/cli-home"
mkdir -p "$CLI_HOME" || die "cannot create the isolated CLI home at $CLI_HOME"

# The pane is created with `-c "$REPO_ROOT"` because `tsx src/cli/index.ts`
# resolves from there, but the redirects in the steps below are opened by *this*
# shell, in *this* directory. Moving out of the repository first is what keeps
# `task-id.txt` and `prompt.json` from landing in a working tree the run is
# supposed to leave clean. `cm` re-enters the repository in its own subshell, so
# nothing else is affected.
PANE_CWD="$CM_DEMO_STATE_DIR/cli-scene-out"
mkdir -p "$PANE_CWD" || die "cannot create the scratch directory at $PANE_CWD"
cd "$PANE_CWD" || die "cannot enter $PANE_CWD"

cm() {
  ( cd "$REPO_ROOT" && env -u DATABASE_PATH -u MCBD_DB_PATH -u MCBD_PORT -u CM_AUTH_TOKEN \
      HOME="$CLI_HOME" CM_PORT="$CM_DEMO_PORT" CM_BIND=127.0.0.1 \
      "$REPO_ROOT/node_modules/.bin/tsx" src/cli/index.ts "$@" )
}

banner() {
  printf '\033[1;36m$\033[0m \033[1m%s\033[0m\n' "$1"
}

# Step 1 doubles as the proof that this pane is not talking to a production
# server: every id the CLI reports has to be one of the ids env-up.sh derived
# from the throwaway seed. `wt-api-cache` is deliberately absent until the
# sync-worktrees scene registers it, so the check is "subset of the seed, and
# the boot-synced ones are all there" rather than an exact four.
assert_only_seed_worktrees() {
  listed="$CM_DEMO_STATE_DIR/.cli-scene-ids"
  cm ls --quiet >"$listed" 2>/dev/null || die "'commandmate ls' failed against port $CM_DEMO_PORT"
  seen=0
  while IFS= read -r listed_id; do
    [ -n "$listed_id" ] || continue
    seen=$((seen + 1))
    case "$listed_id" in
      "$CM_DEMO_PRIMARY_WORKTREE_ID"|"$CM_DEMO_WORKTREE_ID"|"$CM_DEMO_LOGIN_WORKTREE_ID"|"$CM_DEMO_UNSYNCED_WORKTREE_ID") : ;;
      *)
        rm -f "$listed"
        die "'$listed_id' is not one of this run's seed worktrees; refusing to film a session that is not isolated"
        ;;
    esac
  done <"$listed"
  for required in "$CM_DEMO_PRIMARY_WORKTREE_ID" "$CM_DEMO_WORKTREE_ID" "$CM_DEMO_LOGIN_WORKTREE_ID"; do
    grep -Fqx -- "$required" "$listed" || { rm -f "$listed"; die "seed worktree '$required' is missing from 'commandmate ls'"; }
  done
  rm -f "$listed"
  [ "$seen" -gt 0 ] || die "'commandmate ls' listed no worktrees at all"
}

assert_only_seed_worktrees

CONTRACT=".commandmate/tasks/dark-mode.yaml"
WT="$CM_DEMO_WORKTREE_ID"

# ------------------------------------------------------- verify-red ---------
#
# The red gate the tutorial opens on (Issue #1813). It runs against the seed
# worktree that branched off `main` *without* the fix, so `node --test` there
# really does fail: the same `unit` gate that passes in wt-dark-mode.
#
# `--gates unit` rather than the default selection, and that is the measured
# behaviour rather than a stylistic choice. The default is work-evidence plus
# every declared gate, and work-evidence fails first on a checkout that carries
# no work at all — the run then reports `not_started` and **exit 21**, with the
# declared gates recorded as skipped. Naming the gate is what makes the failure
# on screen the one the tutorial is about: the declared criterion, red.
#
# Two held frames rather than one, and the `clear` between them is the reason.
# A failing gate prints up to 40 lines of its log tail
# (MAX_PRINTED_LOG_TAIL_LINES, src/cli/utils/verify-runner.ts), so in a 26-row
# pane the `GATE unit FAIL` line has scrolled off by the time `RESULT failed`
# and the exit code arrive. Frame 1 is therefore the verdict and the code;
# frame 2 is the same run read back out of the history, where one short line
# names the gate that failed. Both are the product's own output — nothing is
# reprinted by this script.
if [ "$MODE" = "verify-red" ]; then
  RED_WT="$CM_DEMO_LOGIN_WORKTREE_ID"
  [ -n "$RED_WT" ] || die "state file has no CM_DEMO_LOGIN_WORKTREE_ID — nothing to fail a gate in"

  clear
  banner "commandmate verify $RED_WT --gates unit"
  cm verify "$RED_WT" --gates unit
  RED_EXIT=$?

  banner "echo \$?"
  printf '%s\n' "$RED_EXIT"
  sleep "$RED_FRAME_HOLD"

  clear
  banner "commandmate verify history --worktree $RED_WT"
  cm verify history --worktree "$RED_WT"
  sleep "$RED_TAIL_HOLD"

  [ "$RED_EXIT" -eq 20 ] || die "expected exit 20 (a declared gate failed) from the pre-work verify, got $RED_EXIT"
  exit 0
fi

# `wait` returns as soon as it observes a completed session, and the capture it
# reads is cached for 5s (Issue #1623). Called straight after `send`, it can
# therefore read the pane as it was *before* the cassette repainted and report
# `Completed` without the agent having started — measured: the first wait
# returned 0 instead of 10, and verified an agent that had not yet run.
#
# So the harness does what the recorder's `prepare` does for a browser scene:
# synchronise on observable state before the step that films it. This is the
# product's own `ls --json`, redirected, so nothing extra appears on camera.
#
# What must not be true is `isWaitingForResponse`: that is the stale approval
# frame, and continuing on it makes the next `wait` report exit 10 for a prompt
# that was already answered. `isProcessing` was the original evidence that the
# pane had repainted — but it is not the only safe state, and waiting for it
# alone is what broke the #1811 re-shoot. The cassette can finish its stretch
# before the poll first looks, and then `isProcessing` is never observed true:
# the loop span 90 times, gave up, killed the pane mid-take, and left a take
# that ended at `Response sent.` with no verdict on it. That take still
# composed — a session that ends is how the recorder knows the script finished
# — and shipped as a cut whose telop promises a verdict the footage never
# reaches. So the probe now reports three states and the loop accepts two.
PROBE="$CM_DEMO_STATE_DIR/.cli-scene-probe.mjs"
cat >"$PROBE" <<'PROBEJS'
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let list;
  try { list = JSON.parse(raw); } catch { process.exit(1); }
  const worktree = Array.isArray(list) ? list.find((entry) => entry.id === process.argv[2]) : null;
  const status = worktree && worktree.sessionStatusByCli && worktree.sessionStatusByCli.claude;
  // 1: unreadable, or still parked on a prompt — never safe to continue from.
  if (!status || status.isWaitingForResponse) process.exit(1);
  // 0: generating. 2: settled with no prompt, which the caller accepts only
  // after it has held long enough to outlive the 5s capture cache.
  process.exit(status.isProcessing ? 0 : 2);
});
PROBEJS

# Six consecutive settled readings, a second apart plus the cost of the call
# itself. The capture a status is derived from is cached for 5s (#1623), so one
# settled reading could still be describing the pane as it was before the
# message landed; six of them cannot all predate it.
SETTLED_POLLS=6

wait_until_busy() {
  attempt=0
  settled=0
  while [ "$attempt" -lt 90 ]; do
    attempt=$((attempt + 1))
    cm ls --json 2>/dev/null | node "$PROBE" "$WT"
    case $? in
      0) return 0 ;;
      2)
        settled=$((settled + 1))
        [ "$settled" -lt "$SETTLED_POLLS" ] || return 0
        ;;
      *) settled=0 ;;
    esac
    sleep 1
  done
  die "$WT never left the approval frame after the message was delivered"
}

# Two things below are there to keep the transcript inside the row budget, and
# both are honest about it: the banner prints the command that is actually run,
# redirect included.
#
# `send --contract` and `wait` put their *machine-readable* payload on stdout
# and everything a reader needs on stderr (src/cli/commands/send.ts writes
# `Task created: <id>` with console.error and the bare id with console.log;
# wait.ts does the same with the prompt JSON). Sending stdout to a file
# therefore removes eight rows — the duplicate task id, and seven wrapped rows
# of prompt JSON — without removing a single line the shot is about. The blank
# separator rows this script used to print are gone for the same reason; the
# bold `$` banners already separate the steps.
clear
banner "commandmate ls"
cm ls

banner "commandmate send $WT --contract $CONTRACT >task-id.txt"
cm send "$WT" --contract "$CONTRACT" >task-id.txt || die "send failed"
wait_until_busy

banner "commandmate wait $WT --verify --timeout $WAIT_TIMEOUT >prompt.json"
cm wait "$WT" --verify --timeout "$WAIT_TIMEOUT" >prompt.json
FIRST_WAIT=$?
printf '\033[2mexit %s (10 = the agent is asking)\033[0m\n' "$FIRST_WAIT"
[ "$FIRST_WAIT" -eq 10 ] || die "expected exit 10 (prompt detected) from the first wait, got $FIRST_WAIT"

banner "commandmate respond $WT 1"
cm respond "$WT" 1 || die "respond failed"
wait_until_busy

banner "commandmate wait $WT --verify --timeout $WAIT_TIMEOUT"
cm wait "$WT" --verify --timeout "$WAIT_TIMEOUT"
SECOND_WAIT=$?

banner "echo \$?"
printf '%s\n' "$SECOND_WAIT"
rm -f "$PROBE"

# ---------------------------------------------------------- evidence --------
#
# Issue #1813. The verdict is on screen by now; this tail shows where it is
# kept once the pane is closed. `clear` first, because compose.sh keeps the
# *tail* of an over-long take: without it the cut would end on the run rather
# than on the record, which is the opposite of what the beat claims.
#
# The exit code is asserted before anything is printed — a red run would make
# the record on screen a record of a failure, and the take should die here
# rather than ship.
if [ "$MODE" = "evidence" ]; then
  [ "$SECOND_WAIT" -eq 0 ] || die "expected exit 0 from the verified wait, got $SECOND_WAIT"
  TASK_ID="$(tr -d ' \n' <task-id.txt)"
  [ -n "$TASK_ID" ] || die "send wrote no task id to task-id.txt"

  sleep 2
  clear
  banner "commandmate verify history --worktree $WT"
  cm verify history --worktree "$WT"

  banner "commandmate task show $TASK_ID"
  cm task show "$TASK_ID"

  sleep "$EVIDENCE_HOLD"
  exit 0
fi

# Held so the last frame — the one carrying RESULT and the exit code — is on
# screen long enough for the capture loop to photograph it. The scene's real
# length is still the storyboard's; compose.sh trims from the front.
sleep "$HOLD_SECONDS"

[ "$SECOND_WAIT" -eq 0 ] || die "expected exit 0 from the verified wait, got $SECOND_WAIT"
exit 0
