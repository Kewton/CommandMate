#!/usr/bin/env bash
# cmate-verify / verify-run — run the gates declared in .commandmate/verify.yaml
# and judge each one by its REAL exit code.
#
# Usage:
#   verify-run.sh [--config <path>] [--cwd <worktree-path>] [--base-ref <ref>]
#                 [--gates id1,id2] [--skip-work-evidence]
#
# stdout is machine-readable, one line per gate plus a final verdict:
#   GATE work-evidence PASS commits=3 uncommitted=2
#   GATE lint PASS exit=0 duration=12s
#   GATE unit FAIL exit=1 duration=45s
#   RESULT failed
# Failing output tails and diagnostics go to stderr so stdout stays parseable.
# Every FAIL/TIMEOUT prints a reason line on stderr — including gates that wrote
# nothing at all, which used to be reported by the status line alone (Issue #1607).
#
# Two further gate lines exist since Issues #223 / #224 (CommandMate #1771 /
# #1772), and both are the spelling verification-config.md section 9.3 / 10 fixed
# as canonical for THIS runner — the product CLI renders the same fields inside
# parentheses and always has, so the contract is the field names, their units and
# "never fold waited into duration", not the separator:
#   GATE e2e  PASS  exit=0    duration=190s waited=42s
#   GATE e2e  SKIP  reason=mutex-wait waited=600s
#   GATE unit FLAKY exit=1,0  duration=45s,44s
#
# Exit code: passed=0 / config error=2 / failed=20 / not_started=21 / skipped=22.
#
# `skipped` (22) covers a second case since #223: a gate that declared `mutex`
# and never got the lock reached NO VERDICT, so the run must not come back
# `passed` on the gates that did run. CommandMate's own runner says that with
# exit 99; this vocabulary has no 99, and 22 is the value already documented as
# "nothing was verified here, and this is not green" (section 3.3). A gate that
# actually failed still wins: a real verdict outranks a missing one.
#
# SCOPE: this is a standalone runner. It reads .commandmate/verify.yaml and nothing
# else — no CommandMate server, no database, no task contract. CommandMate's own
# execution contracts (.commandmate/tasks/*.yaml) can also demand a commit via
# `success.requireCommit`, and the product implementation ORs that with
# `options.requireCommit` (Issue #1642). Here only `options.requireCommit` exists,
# because a run started from a shell is not attached to any delegation. A
# repository that wants the requirement to hold for BOTH runners declares it in
# verify.yaml, which is the one file both implementations read (Issue #1639).
# `.commandmate/tasks/` is named once below, as a path work-evidence does not
# count (Issue #1651); no file under it is ever opened, so this stays true.
#
# Never decide pass/fail by grepping a command's output: `cmd | grep ...` hands $?
# to grep and hides a non-zero exit — vitest can print "Tests 100 passed" and still
# exit 1 on an Unhandled Rejection. Each gate is run as `sh -c "$cmd" > log 2>&1`
# and `$?` is read directly (same discipline as orchestrate-monitor/quality-gate.sh).
#
# bash 3.2 compatible on purpose (macOS ships /bin/bash 3.2.57): no `declare -A`,
# no `mapfile`/`readarray`, no `${var,,}`. macOS also has no timeout(1), so the
# per-gate timeout is a watchdog subshell over a job-controlled process group.
set -u

TAB=$(printf '\t')

EXIT_PASSED=0
EXIT_CONFIG=2
EXIT_FAILED=20
EXIT_NOT_STARTED=21
EXIT_SKIPPED=22

DEFAULT_TIMEOUT_SEC=600
MAX_TIMEOUT_SEC=7200
DEFAULT_MAX_LOG_TAIL_BYTES=8192
MAX_LOG_TAIL_BYTES_LIMIT=1048576
# Grace period between SIGTERM and SIGKILL for a timed-out gate.
KILL_GRACE_SEC=5

CONFIG=""
CWD=""
BASE_REF_OPT=""
GATES_OPT=""
SKIP_WORK_EVIDENCE=0

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
}

die_config() {
  echo "verify-run: $1" >&2
  exit "$EXIT_CONFIG"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --config) shift; CONFIG=${1:-}; [ -n "$CONFIG" ] || die_config "--config requires a path";;
    --cwd) shift; CWD=${1:-}; [ -n "$CWD" ] || die_config "--cwd requires a path";;
    --base-ref) shift; BASE_REF_OPT=${1:-}; [ -n "$BASE_REF_OPT" ] || die_config "--base-ref requires a ref";;
    --gates) shift; GATES_OPT=${1:-}; [ -n "$GATES_OPT" ] || die_config "--gates requires a comma-separated list";;
    --skip-work-evidence) SKIP_WORK_EVIDENCE=1;;
    -h|--help) usage; exit 0;;
    *) die_config "unknown argument: $1";;
  esac
  shift
done

if [ -z "$CWD" ]; then CWD=$PWD; fi
[ -d "$CWD" ] || die_config "--cwd is not a directory: $CWD"
CWD=$(cd "$CWD" && pwd)

if [ -z "$CONFIG" ]; then CONFIG="$CWD/.commandmate/verify.yaml"; fi
[ -f "$CONFIG" ] || die_config "config file not found: $CONFIG"

TMPBASE=${TMPDIR:-/tmp}
TMPBASE=${TMPBASE%/}
WORKDIR=$(mktemp -d "$TMPBASE/cmate-verify.XXXXXX") || die_config "cannot create a temporary directory under $TMPBASE"

# Removing $WORKDIR is the job of ONE process — the shell that created it —
# and of no other (Issue #228). bash keeps the EXIT trap STRING across a fork:
# a subshell gets its signal HANDLERS reset, not its traps, and a subshell that
# is killed by a catchable signal in the window between `fork()` and that reset
# runs the inherited string through termsig_handler -> run_exit_trap(). Measured
# on Linux/ARM64 (bash 5.2.21): 9203 of 18000 `( ... ) &` subshells signalled
# immediately after the fork ran this trap, every one of them before the first
# command of their own body. Unguarded, each of those deletes the run directory
# of a run that is still going, and every later gate then reports
# `No such file or directory` / `no output captured` with exit 1 — a verdict on
# nothing. BASH_SUBSHELL is 0 only in the top-level shell (measured: 443 of 443
# such firings reported 1), so it is what separates "this run is over" from
# "a forked child of this run is dying".
cleanup_workdir() {
  [ "${BASH_SUBSHELL:-0}" -eq 0 ] || return 0
  rm -rf "$WORKDIR"
}
trap cleanup_workdir EXIT

# --- YAML subset parser -------------------------------------------------------
# Emits one TSV record per parsed item; the free-form field (a gate command) is
# always last so `read -r kind a b rest` cannot split it. Anything the bash subset
# forbids becomes an ERR record instead of a best-effort guess.
AWK_PARSER='
function err(msg) { printf "ERR\tline %d: %s\n", NR, msg }
function trim(s) { sub(/^[ ]+/, "", s); sub(/[ ]+$/, "", s); return s }
function unquote(s,   q) {
  if (length(s) >= 2) {
    q = substr(s, 1, 1)
    if ((q == "\"" || q == SQ) && substr(s, length(s), 1) == q)
      return substr(s, 2, length(s) - 2)
  }
  return s
}
function splitkv(s) {
  KV_I = index(s, ":")
  if (KV_I == 0) return 0
  KV_K = trim(substr(s, 1, KV_I - 1))
  KV_V = trim(substr(s, KV_I + 1))
  if (KV_K !~ /^[A-Za-z][A-Za-z0-9]*$/) return 0
  return 1
}
function checkvalue(key, v,   c) {
  if (v == "") { err(key ": has an empty value"); return 0 }
  c = substr(v, 1, 1)
  if (c == "&" || c == "*") { err(key ": YAML anchors/aliases are not supported"); return 0 }
  if (c == "[" || c == "{") { err(key ": flow-style values are not supported"); return 0 }
  if (v ~ /^[|>][-+0-9]*$/) { err(key ": block scalars are not supported"); return 0 }
  return 1
}
function gatekv(s) {
  if (!splitkv(s)) { err("expected \"key: value\" inside a gate"); return }
  if (!checkvalue(KV_K, KV_V)) return
  if (KV_K == "id") {
    if (gid != "") { err("duplicate id: in one gate"); return }
    gid = unquote(KV_V)
  } else if (KV_K == "command") {
    if (gcmd != "") { err("duplicate command: in one gate"); return }
    gcmd = unquote(KV_V)
  } else if (KV_K == "timeoutSec") {
    if (gto != "") { err("duplicate timeoutSec: in one gate"); return }
    gto = unquote(KV_V)
  } else if (KV_K == "mutex") {
    if (gmx != "") { err("duplicate mutex: in one gate"); return }
    gmx = unquote(KV_V)
  } else if (KV_K == "retryOnFail") {
    if (gretry != "") { err("duplicate retryOnFail: in one gate"); return }
    gretry = unquote(KV_V)
  } else if (KV_K == "flakyIsPass") {
    if (gflaky != "") { err("duplicate flakyIsPass: in one gate"); return }
    gflaky = unquote(KV_V)
  } else {
    err("unknown gate key: " KV_K)
  }
}
function flushgate() {
  if (!gate_open) return
  if (gid == "") err("gate is missing id:")
  if (gcmd == "") err("gate is missing command:")
  if (gid != "" && gcmd != "") {
    # Fixed-arity TSV with the free-form command last. Absent optional fields are
    # "-" rather than empty: IFS=<tab> collapses runs of tabs in `read`, so an
    # empty field would silently shift every field after it. "-" is a legal
    # `mutex` name, so a declared one is emitted with a "+" prefix — a character
    # GATE_MUTEX_PATTERN cannot contain, which keeps "absent" and "named -"
    # distinguishable.
    printf "GATE\t%s\t%s\t%s\t%s\t%s\t%s\n", gid, (gto == "" ? "-" : gto), \
      (gmx == "" ? "-" : "+" gmx), (gretry == "" ? "-" : gretry), \
      (gflaky == "" ? "-" : gflaky), gcmd
    ngates++
  }
  gid = ""; gcmd = ""; gto = ""; gmx = ""; gretry = ""; gflaky = ""; gate_open = 0
}
BEGIN { SQ = sprintf("%c", 39); section = ""; gate_open = 0; ngates = 0; nversion = 0
        gid = ""; gcmd = ""; gto = ""; gmx = ""; gretry = ""; gflaky = "" }
{
  line = $0
  sub(/\r$/, "", line)
  if (index(line, "\t") > 0) { err("tab characters are not allowed"); next }
  if (line ~ /^[ ]*$/) next
  if (line ~ /^[ ]*#/) next
  match(line, /^ */)
  ind = RLENGTH
  if (ind % 2 != 0) { err("indentation must be a multiple of 2 spaces"); next }
  body = substr(line, ind + 1)

  if (ind == 0) {
    flushgate()
    if (!splitkv(body)) { err("expected \"key: value\" at the top level"); next }
    if (KV_K == "version") {
      nversion++
      if (nversion > 1) err("duplicate top-level version:")
      else if (unquote(KV_V) != "1") err("version must be 1 (got: " KV_V ")")
      section = ""
    } else if (KV_K == "gates") {
      if (KV_V != "") err("gates: must be followed by an indented list")
      section = "gates"
    } else if (KV_K == "options") {
      if (KV_V != "") err("options: must be followed by indented keys")
      section = "options"
    } else {
      err("unknown top-level key: " KV_K)
    }
    next
  }

  if (ind == 2) {
    if (section == "gates") {
      if (substr(body, 1, 2) != "- ") { err("gate list items must start with \"- \""); next }
      flushgate()
      gate_open = 1
      gatekv(trim(substr(body, 3)))
      next
    }
    if (section == "options") {
      if (!splitkv(body)) { err("expected \"key: value\" inside options:"); next }
      if (!checkvalue(KV_K, KV_V)) next
      if (KV_K == "baseRef" || KV_K == "skipInPrimaryCheckout" || KV_K == "maxLogTailBytes" || KV_K == "requireCommit" || KV_K == "requireEnvClean")
        printf "OPT\t%s\t%s\n", KV_K, unquote(KV_V)
      else
        err("unknown options key: " KV_K)
      next
    }
    err("indented line outside of gates: / options:")
    next
  }

  if (ind == 4 && section == "gates") {
    if (!gate_open) { err("gate field outside of a list item"); next }
    gatekv(body)
    next
  }

  err("unexpected indentation (" ind " spaces)")
}
END {
  flushgate()
  if (nversion == 0) printf "ERR\tmissing top-level \"version: 1\"\n"
  if (ngates == 0) printf "ERR\tno gates are defined\n"
}
'

PARSED="$WORKDIR/parsed.tsv"
awk "$AWK_PARSER" "$CONFIG" > "$PARSED" || die_config "failed to read $CONFIG"

if grep -q "^ERR$TAB" "$PARSED"; then
  echo "verify-run: invalid config: $CONFIG" >&2
  sed -n "s/^ERR$TAB/  - /p" "$PARSED" >&2
  exit "$EXIT_CONFIG"
fi

GATE_IDS=()
GATE_TOS=()
GATE_MUTEXES=()
GATE_RETRIES=()
GATE_FLAKY_IS_PASS=()
GATE_CMDS=()
OPT_BASE_REF=""
OPT_SKIP_PRIMARY="true"
OPT_MAX_TAIL="$DEFAULT_MAX_LOG_TAIL_BYTES"
OPT_REQUIRE_COMMIT="false"
OPT_REQUIRE_ENV_CLEAN="false"

while IFS="$TAB" read -r kind a b c d e rest; do
  case "$kind" in
    GATE)
      GATE_IDS+=("$a")
      GATE_TOS+=("$b")
      # "-" is absent; "+name" is a declared mutex (see flushgate).
      case "$c" in
        -) GATE_MUTEXES+=("");;
        *) GATE_MUTEXES+=("${c#+}");;
      esac
      GATE_RETRIES+=("$d")
      GATE_FLAKY_IS_PASS+=("$e")
      GATE_CMDS+=("$rest")
      ;;
    OPT)
      case "$a" in
        baseRef) OPT_BASE_REF=$b;;
        skipInPrimaryCheckout) OPT_SKIP_PRIMARY=$b;;
        maxLogTailBytes) OPT_MAX_TAIL=$b;;
        requireCommit) OPT_REQUIRE_COMMIT=$b;;
        requireEnvClean) OPT_REQUIRE_ENV_CLEAN=$b;;
      esac
      ;;
  esac
done < "$PARSED"

case "$OPT_SKIP_PRIMARY" in
  true|false) ;;
  *) die_config "options.skipInPrimaryCheckout must be true or false (got: $OPT_SKIP_PRIMARY)";;
esac
case "$OPT_REQUIRE_COMMIT" in
  true|false) ;;
  *) die_config "options.requireCommit must be true or false (got: $OPT_REQUIRE_COMMIT)";;
esac
case "$OPT_REQUIRE_ENV_CLEAN" in
  true|false) ;;
  *) die_config "options.requireEnvClean must be true or false (got: $OPT_REQUIRE_ENV_CLEAN)";;
esac
case "$OPT_MAX_TAIL" in
  ''|*[!0-9]*) die_config "options.maxLogTailBytes must be an integer (got: $OPT_MAX_TAIL)";;
esac
if [ "$OPT_MAX_TAIL" -gt "$MAX_LOG_TAIL_BYTES_LIMIT" ]; then
  die_config "options.maxLogTailBytes must be 0..$MAX_LOG_TAIL_BYTES_LIMIT (got: $OPT_MAX_TAIL)"
fi

GATE_ID_RE='^[a-z0-9][a-z0-9-]{0,31}$'
# Wider than GATE_ID_RE on purpose: a mutex names a RESOURCE, not a gate, so two
# repositories that both bind port 60303 can agree on `port.60303` and serialize
# against each other. Narrow enough to be safe as a path segment, because both
# runners turn it into `<lock-root>/<name>.lock` (CommandMate #1771,
# verification-config.md section 9.2).
GATE_MUTEX_RE='^[A-Za-z0-9_.-]+$'
MAX_GATE_MUTEX_LENGTH=64
# The ceiling IS the feature (CommandMate #1772). A gate that may re-run until it
# passes reports the machine's luck, not the work, so 2 is a config error rather
# than a larger number of attempts.
MAX_RETRY_ON_FAIL=1
SEEN_IDS="$WORKDIR/seen-ids"
: > "$SEEN_IDS"
gate_count=${#GATE_IDS[@]}
i=0
while [ "$i" -lt "$gate_count" ]; do
  vid=${GATE_IDS[$i]}
  case "$vid" in
    work-evidence|scope|env-clean) die_config "gate id is reserved: $vid";;
  esac
  [[ $vid =~ $GATE_ID_RE ]] || die_config "invalid gate id: $vid (must match $GATE_ID_RE)"
  if grep -Fxq "$vid" "$SEEN_IDS"; then die_config "duplicate gate id: $vid"; fi
  printf '%s\n' "$vid" >> "$SEEN_IDS"

  vto=${GATE_TOS[$i]}
  if [ "$vto" = "-" ]; then vto=$DEFAULT_TIMEOUT_SEC; fi
  case "$vto" in
    ''|*[!0-9]*) die_config "timeoutSec must be an integer (gate $vid, got: $vto)";;
  esac
  if [ "$vto" -lt 1 ] || [ "$vto" -gt "$MAX_TIMEOUT_SEC" ]; then
    die_config "timeoutSec must be 1..$MAX_TIMEOUT_SEC (gate $vid, got: $vto)"
  fi
  GATE_TOS[$i]=$vto

  vmx=${GATE_MUTEXES[$i]}
  if [ -n "$vmx" ]; then
    if [ ${#vmx} -gt "$MAX_GATE_MUTEX_LENGTH" ]; then
      die_config "mutex must be at most $MAX_GATE_MUTEX_LENGTH characters (gate $vid, got: ${#vmx})"
    fi
    [[ $vmx =~ $GATE_MUTEX_RE ]] || die_config "invalid mutex name: $vmx (gate $vid, must match $GATE_MUTEX_RE)"
  fi

  vretry=${GATE_RETRIES[$i]}
  if [ "$vretry" = "-" ]; then vretry=0; fi
  case "$vretry" in
    0|1) ;;
    # Not "at most N": the range is the contract, so the message states it.
    *) die_config "retryOnFail must be 0 or $MAX_RETRY_ON_FAIL (gate $vid, got: $vretry)";;
  esac
  GATE_RETRIES[$i]=$vretry

  vflaky=${GATE_FLAKY_IS_PASS[$i]}
  if [ "$vflaky" = "-" ]; then vflaky=false; fi
  case "$vflaky" in
    true|false) ;;
    *) die_config "flakyIsPass must be true or false (gate $vid, got: $vflaky)";;
  esac
  # A knob that can never fire is a config bug, not a preference: with no retry
  # the gate has no FLAKY outcome to reclassify, so the declaration reads as
  # "flakes are tolerated here" while changing nothing. `flakyIsPass: false`
  # alone is only the default written out, so it passes.
  if [ "$vflaky" = "true" ] && [ "$vretry" != "$MAX_RETRY_ON_FAIL" ]; then
    die_config "flakyIsPass: true requires retryOnFail: $MAX_RETRY_ON_FAIL (gate $vid, without a retry a gate can never be FLAKY)"
  fi
  GATE_FLAKY_IS_PASS[$i]=$vflaky
  i=$((i + 1))
done

SELECTED="$WORKDIR/selected-ids"
: > "$SELECTED"
if [ -n "$GATES_OPT" ]; then
  printf '%s\n' "$GATES_OPT" | tr ',' '\n' | sed 's/^ *//; s/ *$//' | grep -v '^$' > "$SELECTED"
  [ -s "$SELECTED" ] || die_config "--gates selects no gate"
  # An unknown id here would silently run nothing and report `passed`.
  while read -r want; do
    grep -Fxq "$want" "$SEEN_IDS" || die_config "--gates refers to an unknown gate id: $want"
  done < "$SELECTED"
fi

# --- git context --------------------------------------------------------------
git_in() { git -C "$CWD" "$@"; }

git_in rev-parse --git-dir >/dev/null 2>&1 || die_config "not a git repository: $CWD"

BASE_REF=$BASE_REF_OPT
[ -n "$BASE_REF" ] || BASE_REF=$OPT_BASE_REF
if [ -z "$BASE_REF" ]; then
  BASE_REF=$(git_in symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null) || BASE_REF=""
fi
[ -n "$BASE_REF" ] || die_config "cannot determine baseRef: set options.baseRef or pass --base-ref (refs/remotes/origin/HEAD is unset)"
git_in rev-parse --verify --quiet "$BASE_REF^{commit}" >/dev/null 2>&1 \
  || die_config "baseRef does not resolve to a commit: $BASE_REF"

# --- work-evidence ------------------------------------------------------------
# `.commandmate/tasks/` holds CommandMate's execution contracts. They are the
# ORCHESTRATOR's evidence, not the agent's: a worktree whose only change is the
# contract file that was just dropped into it has to keep reading as "nothing
# happened here", or exit 21 stops meaning anything. Both counters exclude the
# directory — the product engine has done so since Issue #1580, and this runner
# reported `RESULT passed` over a contract-only worktree until #1651 ported it.
CONTRACT_DIR_PREFIX=".commandmate/tasks/"

is_contract_path() {
  case "$1" in
    "$CONTRACT_DIR_PREFIX"*) return 0;;
    *) return 1;;
  esac
}

# Reads `git status --porcelain -z --untracked-files=all` on stdin and prints how
# many entries are about something other than a contract file.
#
# `-z` and `-uall` are not cosmetic. The human format C-quotes any path holding a
# space and joins a rename with ` -> `; the default untracked mode collapses a
# brand-new `.commandmate/tasks/` into the single entry `?? .commandmate/`. All
# three hand the prefix test something that is not a path, and the third is
# exactly the case this exclusion exists for — the contract would come back as
# work under a directory name that does not match the prefix.
#
# A record is `XY<space><path>NUL`, and a rename or copy appends the ORIGINAL
# path as the next NUL field (measured on git 2.49: `R  new\0old\0`, the reverse
# of the human `old -> new` rendering). An entry counts as work when ANY of its
# paths is not a contract file, so renaming a contract into real work is still a
# change — same rule as the TS `parsePorcelainEntries` filter.
count_work_entries() {
  cw_count=0
  while IFS= read -r -d '' cw_entry; do
    # "XY " plus at least one path character.
    [ ${#cw_entry} -ge 4 ] || continue
    cw_work=0
    is_contract_path "${cw_entry:3}" || cw_work=1
    cw_x=${cw_entry:0:1}
    cw_y=${cw_entry:1:1}
    if [ "$cw_x" = "R" ] || [ "$cw_x" = "C" ] || [ "$cw_y" = "R" ] || [ "$cw_y" = "C" ]; then
      cw_orig=""
      if IFS= read -r -d '' cw_orig && [ -n "$cw_orig" ]; then
        is_contract_path "$cw_orig" || cw_work=1
      fi
    fi
    [ "$cw_work" -eq 0 ] || cw_count=$((cw_count + 1))
  done
  printf '%s\n' "$cw_count"
}

if [ "$SKIP_WORK_EVIDENCE" -eq 1 ]; then
  echo "GATE work-evidence SKIP reason=flag"
else
  merge_base=$(git_in merge-base "$BASE_REF" HEAD 2>/dev/null) \
    || die_config "cannot compute merge-base($BASE_REF, HEAD)"
  # Unfiltered, for the diagnosis below only. It is never the verdict.
  commits_all=$(git_in rev-list --count "$merge_base..HEAD" 2>/dev/null) \
    || die_config "cannot count commits since $BASE_REF"
  # `:(top)` is an explicit "everything under the repository root": it keeps the
  # pathspec from being exclusions alone, and it anchors both patterns at the
  # root rather than at --cwd. A setup commit carrying only the contract must not
  # read as a commit's worth of work.
  commits=$(git_in rev-list --count "$merge_base..HEAD" -- \
    ':(top)' ":(exclude,top)$CONTRACT_DIR_PREFIX" 2>/dev/null) \
    || die_config "cannot count commits since $BASE_REF excluding $CONTRACT_DIR_PREFIX"
  git_in status --porcelain -z --untracked-files=all > "$WORKDIR/status.z" 2>/dev/null \
    || die_config "git status failed in $CWD"
  uncommitted=$(count_work_entries < "$WORKDIR/status.z")
  # Printed only when the option is on, so the default output is unchanged and
  # the TS implementation's summary line stays comparable word for word.
  we_flag=""
  if [ "$OPT_REQUIRE_COMMIT" = "true" ]; then we_flag=" requireCommit=true"; fi
  if [ "$commits" -eq 0 ] && [ "$uncommitted" -eq 0 ]; then
    echo "GATE work-evidence FAIL commits=$commits uncommitted=$uncommitted$we_flag"
    # Two zeroes over a tree that `git status` shows as dirty would otherwise read
    # as a bug in the gate. `-s` on the porcelain dump settles the working-tree
    # side on its own: every entry it holds was filtered out, so all of them were
    # contract files.
    if [ -s "$WORKDIR/status.z" ] || [ "$commits_all" -gt 0 ]; then
      echo "verify-run: the only changes here are execution contracts under $CONTRACT_DIR_PREFIX. They are the orchestrator's evidence, not the agent's, so work-evidence does not count them." >&2
    fi
    echo "RESULT not_started"
    exit "$EXIT_NOT_STARTED"
  fi
  # Issue #1639 / #1628 (D-4): `commits=0 uncommitted=1` reads as "work exists",
  # which is the right answer to "did anything happen here" and the wrong one to
  # "is this finished". A repository that wants the second question asked says so
  # with options.requireCommit. The reason goes to stderr because, unlike the
  # zero-work case above, `FAIL commits=0 uncommitted=3` does not explain itself.
  if [ "$OPT_REQUIRE_COMMIT" = "true" ] && [ "$commits" -eq 0 ]; then
    echo "GATE work-evidence FAIL commits=$commits uncommitted=$uncommitted$we_flag"
    echo "verify-run: options.requireCommit is set: uncommitted changes are not work evidence, commit them." >&2
    echo "RESULT not_started"
    exit "$EXIT_NOT_STARTED"
  fi
  echo "GATE work-evidence PASS commits=$commits uncommitted=$uncommitted$we_flag"
fi

# A linked worktree has its own git dir under <common>/worktrees/<name>; the
# primary checkout is the one where they are the same path. Both sides are
# resolved with `pwd -P`: on macOS $TMPDIR lives under the /var -> /private/var
# symlink, and comparing a logical path against a physical one makes every
# checkout look linked (i.e. silently disables the primary-checkout guard).
resolve_dir() { ( cd "$CWD" && cd "$1" 2>/dev/null && pwd -P ); }
git_dir=$(git_in rev-parse --git-dir 2>/dev/null) || die_config "cannot resolve the git directory of $CWD"
common_git_dir=$(git_in rev-parse --git-common-dir 2>/dev/null) || die_config "cannot resolve the common git directory of $CWD"
abs_git_dir=$(resolve_dir "$git_dir")
abs_common_git_dir=$(resolve_dir "$common_git_dir")
is_primary=0
if [ -n "$abs_git_dir" ] && [ "$abs_git_dir" = "$abs_common_git_dir" ]; then
  is_primary=1
fi

# --- machine-wide gate lock (Issue #223 / CommandMate #1771) -------------------
# A gate that owns a fixed resource — a hard-coded port, a local database, an
# emulator — can only run once per machine. Two parallel worktrees running it at
# once make the second fail on the resource, and `GATE e2e FAIL exit=1` is
# indistinguishable from the change being broken.
#
# The path convention and the primitive are part of the CONTRACT, not an
# implementation detail (verification-config.md section 9.2): CommandMate's own
# runner and this one are started independently against the same machine, so a
# lock that differs in either respect is not a lock at all. `mkdir` is the
# primitive because macOS ships no flock(1) and mkdir is atomic on every POSIX
# filesystem — the same reason the TS implementation uses it.
LOCK_ROOT=${CM_VERIFY_LOCK_ROOT:-}
if [ -z "$LOCK_ROOT" ]; then LOCK_ROOT="${HOME:-/tmp}/.commandmate/locks"; fi
# How often a waiter re-tries the claim. Matches DEFAULT_LOCK_POLL_INTERVAL_MS.
LOCK_POLL_SEC=0.25
LOCK_HOST=$(hostname 2>/dev/null || echo unknown)

# One field out of the owner record, which is the JSON object below. Read with
# awk rather than a shell regex so a value containing `:` or `,` cannot corrupt
# the next field.
lock_owner_field() { # <lock-path> <key>
  [ -f "$1/owner" ] || return 0
  awk -v key="$2" '
    {
      k = "\"" key "\":"
      i = index($0, k)
      if (i == 0) next
      v = substr($0, i + length(k))
      if (substr(v, 1, 1) == "\"") {
        v = substr(v, 2)
        j = index(v, "\"")
        if (j > 0) v = substr(v, 1, j - 1)
      } else {
        j = 1
        while (j <= length(v) && index("0123456789", substr(v, j, 1)) > 0) j++
        v = substr(v, 1, j - 1)
      }
      print v
      exit
    }' "$1/owner" 2>/dev/null
}

# Is the recorded holder gone? Only decidable on the machine that wrote the
# record: a pid from another host says nothing about a process here, and breaking
# a lock on that guess lets two machines sharing a network home run the gate at
# once. An unreadable or ambiguous answer means "alive", which costs a wait —
# the safe direction.
lock_owner_is_dead() { # <pid> <host>
  [ -n "$1" ] || return 1
  [ "$2" = "$LOCK_HOST" ] || return 1
  lod_out=$(kill -0 "$1" 2>&1) && return 1
  # EPERM means the process exists and belongs to someone else; only ESRCH is
  # evidence of a dead holder.
  case "$lod_out" in
    *[Nn]o\ such\ process*) return 0;;
    *) return 1;;
  esac
}

# lock_acquire <name> <budget-seconds>
# Sets LOCK_PATH / LOCK_TOKEN / LOCK_WAITED / LOCK_HELD_BY.
# Returns 0 when the lock is held by this process, 1 when the budget ran out.
lock_acquire() {
  la_name=$1
  la_budget=$2
  LOCK_PATH="$LOCK_ROOT/$la_name.lock"
  LOCK_TOKEN="$$-$(date +%s)-${RANDOM}${RANDOM}"
  LOCK_WAITED=0
  LOCK_HELD_BY=""
  mkdir -p "$LOCK_ROOT" 2>/dev/null || true
  la_start=$(date +%s)
  la_broken=""
  while :; do
    if mkdir "$LOCK_PATH" 2>/dev/null; then
      printf '{"pid":%s,"host":"%s","token":"%s","acquiredAt":%s}\n' \
        "$$" "$LOCK_HOST" "$LOCK_TOKEN" "$(( $(date +%s) * 1000 ))" > "$LOCK_PATH/owner"
      LOCK_WAITED=$(( $(date +%s) - la_start ))
      return 0
    fi
    la_pid=$(lock_owner_field "$LOCK_PATH" pid)
    la_host=$(lock_owner_field "$LOCK_PATH" host)
    la_token=$(lock_owner_field "$LOCK_PATH" token)
    if [ -n "$la_token" ]; then LOCK_HELD_BY="pid ${la_pid:-unknown} on ${la_host:-unknown host}"; fi
    # A stale record is broken at most once per token, so a directory nobody can
    # remove degrades into ordinary waiting instead of a spin loop.
    if [ -n "$la_token" ] && [ "$la_token" != "$la_broken" ] && lock_owner_is_dead "$la_pid" "$la_host"; then
      la_broken=$la_token
      # Only ever remove the record just read: the holder may have released and
      # a new one taken it between the two reads.
      if [ "$(lock_owner_field "$LOCK_PATH" token)" = "$la_token" ]; then
        rm -rf "$LOCK_PATH" 2>/dev/null || true
        echo "verify-run: broke a stale lock at $LOCK_PATH (recorded holder pid $la_pid on this host no longer exists)" >&2
      fi
      continue
    fi
    la_now=$(date +%s)
    if [ $(( la_now - la_start )) -ge "$la_budget" ]; then
      LOCK_WAITED=$(( la_now - la_start ))
      return 1
    fi
    sleep "$LOCK_POLL_SEC" 2>/dev/null || sleep 1
  done
}

# Release only while this acquisition still owns the directory. Without the token
# check, a holder whose lock was broken as stale would delete the NEXT holder's
# directory and hand the resource to two runs at once.
lock_release() { # <lock-path> <token>
  [ -d "$1" ] || return 0
  lr_current=$(lock_owner_field "$1" token)
  if [ -n "$lr_current" ] && [ "$lr_current" != "$2" ]; then return 0; fi
  rm -rf "$1" 2>/dev/null || true
}

# --- gate execution -----------------------------------------------------------
# Never returns without a word. A gate that failed while printing nothing used to
# leave the status line as the only trace, so a CI log showed "this gate did not
# pass" and no reason at all (Issue #1607). "Nothing was captured" is itself the
# diagnosis worth reading — it separates "the command failed and explained itself"
# from "the command produced no output", which point at different causes.
emit_log_tail() {
  el_id=$1
  el_status=$2
  el_log=$3
  if [ "$OPT_MAX_TAIL" -le 0 ]; then
    echo "--- gate $el_id ($el_status): log tail disabled (maxLogTailBytes=$OPT_MAX_TAIL) ---" >&2
    return 0
  fi
  if [ ! -s "$el_log" ]; then
    echo "--- gate $el_id ($el_status): no output captured ---" >&2
    return 0
  fi
  echo "--- gate $el_id ($el_status): last $OPT_MAX_TAIL bytes ---" >&2
  tail -c "$OPT_MAX_TAIL" "$el_log" >&2
  echo "--- end gate $el_id ---" >&2
}

any_failed=0
gates_ran=0
# A gate that never got its mutex reached no verdict. Tracked separately from
# `any_failed` because the two are different facts and the RESULT below ranks
# them: a real failure outranks a missing verdict.
no_verdict=0

# One decimal second, the spelling the machine-readable markers use. This runner
# measures whole seconds (bash 3.2 on macOS has no sub-second `date`), so the
# decimal is always .0 — the FIELD and its unit are the contract, and `45.0s`
# parses under CommandMate's own `([0-9]+(\.[0-9]+)?)s` reader.
marker_seconds() { printf '%s.0s' "$1"; }

# --- one attempt --------------------------------------------------------------
# Sets RGA_STATUS (pass|fail|timeout|mutex-skip), RGA_CODE, RGA_DUR, RGA_LOG and
# RGA_WAITED (-1 when the gate declared no mutex, so "not exclusive" and "waited
# nothing" stay distinguishable).
#
# The wait happens OUTSIDE the measured interval: `duration` is what the gate's
# own command took, and adding another run's queueing to it corrupts the number
# every timeout budget and every "did this gate get slower" judgement is read
# from (verification-config.md section 9.3). Never fold waited into duration.
run_gate_attempt() {
  rga_id=$1
  rga_cmd=$2
  rga_to=$3
  rga_mutex=$4
  rga_log=$5
  RGA_LOG=$rga_log
  RGA_WAITED=-1
  RGA_LOCK_PATH=""
  rga_lock_token=""

  if [ -n "$rga_mutex" ]; then
    # The gate's own timeout is the wait budget: a gate allowed 600s of execution
    # has already declared how long this run may spend on it, and a second knob
    # would only let the two disagree.
    if lock_acquire "$rga_mutex" "$rga_to"; then
      RGA_WAITED=$LOCK_WAITED
      RGA_LOCK_PATH=$LOCK_PATH
      rga_lock_token=$LOCK_TOKEN
    else
      RGA_STATUS=mutex-skip
      RGA_CODE=""
      RGA_DUR=0
      RGA_WAITED=$LOCK_WAITED
      RGA_LOCK_PATH=$LOCK_PATH
      RGA_HELD_BY=$LOCK_HELD_BY
      : > "$rga_log"
      return 0
    fi
  fi

  rga_mark="$rga_log.timedout"
  rm -f "$rga_mark"
  rga_start=$(date +%s)

  # `set -m` puts the gate in its own process group so the watchdog can kill the
  # whole tree. Without it, `npm run x` dies but the node/sleep children it forked
  # survive the timeout (measured: 2 orphans left behind).
  #
  # CM_WORKTREE_INDEX / CM_WORKTREE_ID are NOT set here (Issue #223): this runner
  # does not number worktrees and must not invent a number, because a number that
  # disagrees with CommandMate's would put the gate on a port the product run has
  # already claimed. Whatever the caller exported is inherited unchanged; a gate
  # carries its own default (`${CM_WORKTREE_INDEX:-0}`).
  set -m
  ( cd "$CWD" && exec /bin/sh -c "$rga_cmd" ) > "$rga_log" 2>&1 &
  rga_pid=$!
  set +m

  # `kill -TERM -N` signals whatever process group has id N. If job control could
  # not be enabled, the gate stays in this shell's group and N is just a pid —
  # then the group with that id belongs to some unrelated process tree, and
  # signalling it blindly would kill a bystander. So confirm the gate really is
  # its own group leader before using the group form.
  rga_pgid=$(ps -o pgid= -p "$rga_pid" 2>/dev/null | tr -d ' ')
  if [ "$rga_pgid" = "$rga_pid" ]; then rga_target="-$rga_pid"; else rga_target="$rga_pid"; fi

  ( sleep "$rga_to"
    : > "$rga_mark"
    kill -s TERM -- "$rga_target" 2>/dev/null
    sleep "$KILL_GRACE_SEC"
    kill -s KILL -- "$rga_target" 2>/dev/null
  ) >/dev/null 2>&1 &
  rga_wpid=$!

  # 2>/dev/null suppresses the shell job-control "Terminated" notice.
  wait "$rga_pid" 2>/dev/null
  rga_code=$?
  # KILL, not TERM (Issue #228). The watchdog is a bash subshell that inherited
  # this shell's EXIT trap string, and for a fast gate the normal case — not the
  # rare one — is that the gate is already over before the watchdog was even
  # forked: `wait` above then returns at once, so this kill lands inside the
  # window where the child still carries bash's terminating-signal handler. A
  # catchable signal there makes the child run the EXIT trap and delete
  # $WORKDIR out from under this run; SIGKILL cannot be caught, so no shell
  # code runs in the doomed process at all. Measured on Linux/ARM64: 560 stray
  # trap firings in 18000 attempts with TERM, 0 with KILL. Nothing else about the
  # watchdog changes — TERM already ended it here rather than letting it reach its
  # own grace KILL, and a 48-gate run leaves 0 stray `sleep` processes behind
  # under either signal.
  kill -s KILL "$rga_wpid" 2>/dev/null
  wait "$rga_wpid" 2>/dev/null

  RGA_DUR=$(( $(date +%s) - rga_start ))
  # Released per ATTEMPT, not per gate: a retry must not keep a machine-wide
  # resource out of another worktree's hands for a run that already failed once.
  if [ -n "$rga_lock_token" ]; then lock_release "$RGA_LOCK_PATH" "$rga_lock_token"; fi

  if [ -f "$rga_mark" ]; then
    RGA_STATUS=timeout
    RGA_CODE=124
  elif [ "$rga_code" -eq 0 ]; then
    RGA_STATUS=pass
    RGA_CODE=0
  else
    RGA_STATUS=fail
    RGA_CODE=$rga_code
  fi
  rm -f "$rga_mark"
}

# The `waited=` field of a GATE line, or nothing when the gate declared no mutex.
# A mutexed gate that did not wait still prints `waited=0s`: "serialized and got
# the lock straight away" and "not serialized at all" are different facts, and a
# reader has to be able to tell them apart (section 9.3).
waited_field() {
  if [ "$1" -lt 0 ]; then printf ''; else printf ' waited=%ss' "$1"; fi
}

# The spawn hint of Issue #1607, unchanged: 126/127 with an EMPTY log points at
# the spawn rather than at the command's own failure. A lead to follow, never a
# verdict.
spawn_hint() { # <id> <exit> <log> <command>
  if [ ! -s "$3" ] && { [ "$2" -eq 126 ] || [ "$2" -eq 127 ]; }; then
    echo "verify-run: gate $1 exited $2 with no output; the command may not have started (exec/spawn failure). Check that it exists and is executable in $CWD: $4" >&2
  fi
}

run_gate() {
  rg_id=$1
  rg_cmd=$2
  rg_to=$3
  rg_mutex=$4
  rg_retry=$5
  rg_flaky_is_pass=$6

  run_gate_attempt "$rg_id" "$rg_cmd" "$rg_to" "$rg_mutex" "$WORKDIR/gate-$rg_id.log"
  rg1_status=$RGA_STATUS
  rg1_code=$RGA_CODE
  rg1_dur=$RGA_DUR
  rg1_waited=$RGA_WAITED

  # The lock never came free. NOT a TIMEOUT — the command was never started, so
  # "it ran long" is not a fact — and NOT a FAIL, because keeping a resource
  # conflict from wearing the same face as a broken change is the whole point.
  if [ "$rg1_status" = "mutex-skip" ]; then
    echo "GATE $rg_id SKIP reason=mutex-wait waited=${rg1_waited}s"
    no_verdict=1
    {
      echo "--- gate $rg_id (SKIP reason=mutex-wait) ---"
      echo "[mutex] name=$rg_mutex waited=$(marker_seconds "$rg1_waited") lock=$RGA_LOCK_PATH"
      if [ -n "${RGA_HELD_BY:-}" ]; then echo "[mutex] held by $RGA_HELD_BY"; fi
      echo "verify-run: gate $rg_id declares mutex '$rg_mutex' and the machine-wide lock stayed held for its whole ${rg_to}s budget, so the command was never started. This is a resource conflict, not a verdict on the work: re-run once the other run finishes, or raise the gate's timeoutSec."
      echo "--- end gate $rg_id ---"
    } >&2
    return 0
  fi

  gates_ran=$((gates_ran + 1))

  # Only a FAIL is retried (CommandMate #1772). A TIMEOUT is not: the gate has
  # already spent its whole budget, and a second attempt doubles the wall clock
  # of exactly the gates whose budgets are largest. A mutex SKIP never started a
  # command, so there is no verdict to seek a second opinion on.
  if [ "$rg_retry" = "1" ] && [ "$rg1_status" = "fail" ]; then
    run_gate_attempt "$rg_id" "$rg_cmd" "$rg_to" "$rg_mutex" "$WORKDIR/gate-$rg_id.retry.log"
    rg2_status=$RGA_STATUS
    rg2_code=$RGA_CODE
    rg2_dur=$RGA_DUR

    if [ "$rg2_status" = "pass" ] || [ "$rg2_status" = "fail" ]; then
      if [ "$rg2_status" = "pass" ]; then rg_outcome=flaky; else rg_outcome=fail; fi
      rg_verdict=fail
      if [ "$rg_outcome" = "flaky" ] && [ "$rg_flaky_is_pass" = "true" ]; then rg_verdict=pass; fi
      # FLAKY displaces PASS/FAIL rather than being appended to it: neither word
      # was true of this gate, it failed and then it passed. The spelling does
      # NOT change with flakyIsPass — that decides the RESULT and the exit code,
      # never what happened. A gate that failed twice keeps FAIL: the retry
      # agreed, and nothing about it was flaky.
      if [ "$rg_outcome" = "flaky" ]; then rg_label=FLAKY; else rg_label=FAIL; fi
      echo "GATE $rg_id $rg_label exit=$rg1_code,$rg2_code duration=${rg1_dur}s,${rg2_dur}s$(waited_field "$rg1_waited")"
      if [ "$rg_verdict" = "fail" ]; then any_failed=1; fi
      # Written for outcome=fail too, not only for outcome=flaky: a gate that
      # failed twice is evidence AGAINST flakiness, and an advisor mining this
      # needs both halves of the ratio. A marker present only on the flaky half
      # makes every retried gate look flaky.
      {
        echo "[flaky] runs=2 outcome=$rg_outcome exit=$rg1_code,$rg2_code duration=$(marker_seconds "$rg1_dur"),$(marker_seconds "$rg2_dur") verdict=$rg_verdict"
        if [ "$rg1_waited" -ge 0 ]; then
          echo "[mutex] name=$rg_mutex waited=$(marker_seconds "$rg1_waited") lock=$RGA_LOCK_PATH"
        fi
        echo "--- [flaky] run 1/2: failed exit=$rg1_code duration=$(marker_seconds "$rg1_dur") ---"
      } >&2
      emit_log_tail "$rg_id" "$rg_label run 1/2 exit=$rg1_code" "$WORKDIR/gate-$rg_id.log"
      echo "--- [flaky] run 2/2: $([ "$rg2_status" = pass ] && echo passed || echo failed) exit=$rg2_code duration=$(marker_seconds "$rg2_dur") ---" >&2
      emit_log_tail "$rg_id" "$rg_label run 2/2 exit=$rg2_code" "$WORKDIR/gate-$rg_id.retry.log"
      spawn_hint "$rg_id" "$rg2_code" "$WORKDIR/gate-$rg_id.retry.log" "$rg_cmd"
      return 0
    fi

    # The retry reached no verdict of its own (it timed out, or the lock never
    # came free), so there is nothing to compare the first run against. The first
    # run's FAIL stands unchanged — reporting the retry instead would turn a gate
    # that judged the work into one that judged nothing, which is strictly weaker.
    echo "GATE $rg_id FAIL exit=$rg1_code duration=${rg1_dur}s$(waited_field "$rg1_waited")"
    any_failed=1
    echo "[flaky] retry reached no verdict ($rg2_status); the first run's FAIL stands" >&2
    if [ "$rg1_waited" -ge 0 ]; then
      echo "[mutex] name=$rg_mutex waited=$(marker_seconds "$rg1_waited") lock=$RGA_LOCK_PATH" >&2
    fi
    emit_log_tail "$rg_id" "FAIL exit=$rg1_code" "$WORKDIR/gate-$rg_id.log"
    spawn_hint "$rg_id" "$rg1_code" "$WORKDIR/gate-$rg_id.log" "$rg_cmd"
    return 0
  fi

  if [ "$rg1_status" = "timeout" ]; then
    echo "GATE $rg_id TIMEOUT exit=124 duration=${rg1_dur}s$(waited_field "$rg1_waited")"
    any_failed=1
    if [ "$rg1_waited" -ge 0 ]; then
      echo "[mutex] name=$rg_mutex waited=$(marker_seconds "$rg1_waited") lock=$RGA_LOCK_PATH" >&2
    fi
    emit_log_tail "$rg_id" "TIMEOUT after ${rg_to}s" "$WORKDIR/gate-$rg_id.log"
  elif [ "$rg1_status" = "pass" ]; then
    echo "GATE $rg_id PASS exit=0 duration=${rg1_dur}s$(waited_field "$rg1_waited")"
    # The wait is on the record even when the command printed nothing, and even
    # when the gate passed: it is the only evidence that the machine made this
    # run queue. The GATE line above carries it too; this is the line-anchored
    # form a log reader parses (section 9.3).
    if [ "$rg1_waited" -ge 0 ]; then
      echo "[mutex] name=$rg_mutex waited=$(marker_seconds "$rg1_waited") lock=$RGA_LOCK_PATH" >&2
    fi
  else
    echo "GATE $rg_id FAIL exit=$rg1_code duration=${rg1_dur}s$(waited_field "$rg1_waited")"
    any_failed=1
    if [ "$rg1_waited" -ge 0 ]; then
      echo "[mutex] name=$rg_mutex waited=$(marker_seconds "$rg1_waited") lock=$RGA_LOCK_PATH" >&2
    fi
    emit_log_tail "$rg_id" "FAIL exit=$rg1_code" "$WORKDIR/gate-$rg_id.log"
    spawn_hint "$rg_id" "$rg1_code" "$WORKDIR/gate-$rg_id.log" "$rg_cmd"
  fi
}

i=0
while [ "$i" -lt "$gate_count" ]; do
  cur_id=${GATE_IDS[$i]}
  cur_to=${GATE_TOS[$i]}
  cur_mutex=${GATE_MUTEXES[$i]}
  cur_retry=${GATE_RETRIES[$i]}
  cur_flaky=${GATE_FLAKY_IS_PASS[$i]}
  cur_cmd=${GATE_CMDS[$i]}
  i=$((i + 1))

  if [ -s "$SELECTED" ] && ! grep -Fxq "$cur_id" "$SELECTED"; then
    continue
  fi
  if [ "$is_primary" -eq 1 ] && [ "$OPT_SKIP_PRIMARY" = "true" ]; then
    echo "GATE $cur_id SKIP reason=primary-checkout"
    continue
  fi
  # Every gate runs even after one fails, so a single run reports every finding.
  run_gate "$cur_id" "$cur_cmd" "$cur_to" "$cur_mutex" "$cur_retry" "$cur_flaky"
done

# --- built-in env-clean (options.requireEnvClean) -----------------------------
# Accepted so one verify.yaml is readable by BOTH runners (CommandMate #1740 added
# the key and this runner rejected it with exit 2 until #223), and reported rather
# than silently swallowed. It is NOT evaluated here and cannot be: the gate
# compares the machine against a snapshot taken when the TASK was created by
# `send --contract`, and a run started from a shell is attached to no task, so
# there is no baseline to compare against.
#
# It does not change the verdict. Blocking every run of a repository that opted in
# would replace one unusable config (exit 2) with another (never green), and the
# gate this stands in for judges the machine, not the work in this worktree — the
# authority on it is `commandmate verify`, which has the baseline.
if [ "$OPT_REQUIRE_ENV_CLEAN" = "true" ]; then
  echo "GATE env-clean SKIP reason=no-baseline"
  echo "verify-run: options.requireEnvClean is set, but the built-in env-clean gate needs the baseline snapshot CommandMate records at task creation. This standalone run has no task, so the gate is reported as SKIP and judged by nothing here — run \`commandmate verify\` for its verdict." >&2
fi

if [ "$gates_ran" -eq 0 ]; then
  echo "RESULT skipped"
  exit "$EXIT_SKIPPED"
fi
if [ "$any_failed" -ne 0 ]; then
  echo "RESULT failed"
  exit "$EXIT_FAILED"
fi
# A declared gate that never got its mutex was never judged, so the gates that did
# run are not the whole answer and `passed` would be a green over a hole. Ranked
# below `failed` on purpose: a real verdict outranks a missing one.
if [ "$no_verdict" -ne 0 ]; then
  echo "RESULT skipped"
  exit "$EXIT_SKIPPED"
fi
echo "RESULT passed"
exit "$EXIT_PASSED"
