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
# KILL_GRACE_SEC (the grace between SIGTERM and SIGKILL) is set in the machine-wide lock section
# below: lock_drain_group / lock_stop_gate read it, and scripts/lib/machine-lock.sh loads that
# section alone (#4288 PR1a).

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
  # Defined with the machine-wide lock below; absent only before it is parsed.
  if command -v lock_cleanup_on_exit >/dev/null 2>&1; then lock_cleanup_on_exit; fi
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
# Validates one options.envCleanIgnoreHomeEntries element (Issue #2901): the
# same rule as the TS loader (verify-config.ts validateHomeEntryNames) minus
# the NUL check, which this awk cannot enforce — a raw NUL byte truncates the
# input line before any string op here ever sees it (measured: `length($0)`
# stops at the NUL), so the same is already true of every other field this
# parser reads (gate id, command, ...).
function home_entry(item) {
  if (item == "") { err("options.envCleanIgnoreHomeEntries: entry must not be empty"); return }
  if (item == "." || item == "..") { err("options.envCleanIgnoreHomeEntries: entry must not be \"" item "\""); return }
  if (index(item, "/") > 0) { err("options.envCleanIgnoreHomeEntries: entry must not contain \"/\": " item); return }
  home_count++
  if (home_count > 32) { err("options.envCleanIgnoreHomeEntries: at most 32 entries (got " home_count ")"); return }
  printf "OPT\tenvCleanIgnoreHomeEntries\t%s\n", item
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
        gid = ""; gcmd = ""; gto = ""; gmx = ""; gretry = ""; gflaky = ""
        home_open = 0; home_count = 0 }
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
    home_open = 0
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
      if (KV_K == "envCleanIgnoreHomeEntries") {
        # Issue #2901: this key alone allows a list value, in either of the two
        # forms verification-config.md documents — a flow one-liner (KV_V is
        # "[...]", empty "[]" included) or a block list, whose "- " items follow
        # at ind==4 while home_open stays set (see that branch below).
        if (KV_V == "") { home_open = 1; next }
        home_open = 0
        if (match(KV_V, /^\[.*\]$/)) {
          home_list = trim(substr(KV_V, 2, length(KV_V) - 2))
          if (home_list != "") {
            home_n = split(home_list, home_parts, ",")
            for (home_i = 1; home_i <= home_n; home_i++) home_entry(unquote(trim(home_parts[home_i])))
          }
        } else {
          err("options.envCleanIgnoreHomeEntries: must be a flow list \"[...]\" or an indented \"- \" block")
        }
        next
      }
      home_open = 0
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

  if (ind == 4 && section == "options" && home_open) {
    if (substr(body, 1, 2) != "- ") { err("envCleanIgnoreHomeEntries: list items must start with \"- \""); next }
    home_entry(unquote(trim(substr(body, 3))))
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
# Grace period between SIGTERM and SIGKILL for a timed-out gate — and for a group the lock waits on
# to empty (lock_drain_group). Set inside this section because scripts/lib/machine-lock.sh loads the
# section alone, and a loader that did not set it would stop on `set -u` or drain with no grace
# (#4288 PR1a, Codex review-4288h P2-1).
KILL_GRACE_SEC=5
LOCK_HOST=$(hostname 2>/dev/null || echo unknown)

# Waiters are served in the order they came (CommandMate #4277). A waiter takes
# a ticket (`<root>/<name>.queue/<12 digits>`, published with `ln`, which refuses
# an existing name) and only the holder of the smallest live ticket tries the
# `mkdir` — and only it recovers a dead holder's lock. Before, whoever polled
# first after a release won, and this runner's bare `mkdir` could also step in
# while the TS runner had moved a dead holder's lock aside to recover it, so two
# runs held the lock at once. The ticket shapes, the retire rules and the
# recovery are the same as src/lib/verification/machine-lock.ts and
# scripts/orchestrate/machine-lock-sync.mjs (docs/design/merge-queue-fair-lock-4277.md §2).
LOCK_SAME_HOST_GRACE_MS=60000
LOCK_OTHER_HOST_GRACE_MS=600000
LOCK_PID_REUSE_SLACK_MS=2000
LOCK_LINK_TRIES=32
# An owner of 0 bytes older than this is taken out by the head (#4288 PR1a-f I4; fixed, for every head:
# an older writer's `: >` and its write are microseconds apart).
LOCK_EMPTY_OWNER_GRACE_MS=600000
# The pid whose own tickets are never judged "reused" (it is this process).
LOCK_SELF_PID=$$
# The lock last acquired (lock_acquire_path sets them; empty until then, so a loaded section's
# operations run under `set -u` before any acquisition — #4288 PR1a).
LOCK_PATH=""
LOCK_TOKEN=""
LOCK_WAITED=0
LOCK_HELD_BY=""
# A live ticket / a held lock of this process, so the EXIT trap can hand them back.
LOCK_TICKET=""
LOCK_HELD_PATH=""
LOCK_HELD_TOKEN=""
LOCK_GONE_SERIAL=0
# The gate's process group published to the owner (#4288, docs/design/verify-lock-holder-group-4288.md):
# LOCK_PENDING_TOKEN is the token of an owner being published (T1) before the gate is signalled,
# LOCK_GATE_GROUP / LOCK_GATE_LEADER / LOCK_GATE_WATCHDOG the running gate's group, its leader and
# its watchdog, LOCK_UNDRAINED the "<lock>\t<token>\t<group>" lines whose group could not be emptied
# (kept to the end of the run: the lock is never released over them).
LOCK_PENDING_TOKEN=""
LOCK_GATE_GROUP=""
LOCK_GATE_LEADER=""
LOCK_GATE_WATCHDOG=""
LOCK_UNDRAINED=""
LOCK_ACQUIRED_AT=0
LOCK_UNKNOWN=""
LOCK_GONE_PENDING=""
LOCK_WARNED=""
LOCK_TAB=$(printf '\t')
# How long a gate's child waits for the signal that its group is on the owner record (§2.4).
HANDOFF_WAIT_SEC=30
# Options for the callers that load this section through scripts/lib/machine-lock.sh — run-lock and
# supervisor.lock (#4288 PR1a, docs/design/lock-reservation-rest-4288.md §1.6). Every one is off
# here and set by the caller after the load: verify-run.sh's own gates use none of them.
#   LOCK_WANT_TOKEN          the token to acquire under (empty: a new one)
#   LOCK_OWNER_PID           empty or $$ (#4288 PR1a-f I1-b: the first acquisition records its own pid
#                            only; another pid is refused before the ticket — the hand-off records others)
#   LOCK_OWNERLESS_GRACE_MS  an owner-less, empty <lock> older than this is taken out by the head (D3)
#   LOCK_OWNER_CODEC         non-empty: the owner is read by lock_parse_owner_text (D1)
LOCK_WANT_TOKEN=""
LOCK_OWNER_PID=""
LOCK_OWNERLESS_GRACE_MS=""
LOCK_OWNER_CODEC=""
# The caller's own lines of a kv record (scripts/lib/machine-lock.sh's codec: label=, run_dir=, lstart=).
# A key the section writes itself is refused (#4288 PR1a-f I1-c, lock_owner_extra_reserved). Not taken
# from the environment (like the options above): set by the caller after the load, so an exported value
# never reaches a record nor refuses the verify gate's JSON acquisition.
LOCK_OWNER_EXTRA=""
case "${CM_VERIFY_TEST_HANDOFF_WAIT_SEC:-}" in ''|*[!0-9]*) ;; *) HANDOFF_WAIT_SEC=$CM_VERIFY_TEST_HANDOFF_WAIT_SEC;; esac

# Milliseconds since the epoch. `date +%s%3N` where date has it (GNU), else
# seconds * 1000 (macOS) — the ticket deadline is then whole seconds, which is
# also how this runner counts its budget.
lock_now_ms() {
  lnm=$(date +%s%3N 2>/dev/null)
  case "$lnm" in
    ''|*[!0-9]*) echo $(( $(date +%s) * 1000 ));;
    *) echo "$lnm";;
  esac
}

# One field out of a JSON record (an owner or a ticket): strings, digits, true /
# false. Read with awk rather than a shell regex so a value containing `:` or `,`
# cannot corrupt the next field.
LOCK_JSON_AWK='
    {
      k = "\"" key "\":"
      i = index($0, k)
      if (i == 0) next
      v = substr($0, i + length(k))
      if (substr(v, 1, 1) == "\"") {
        v = substr(v, 2)
        j = index(v, "\"")
        if (j > 0) v = substr(v, 1, j - 1)
      } else if (substr(v, 1, 4) == "true") {
        v = "true"
      } else if (substr(v, 1, 5) == "false") {
        v = "false"
      } else {
        j = 1
        while (j <= length(v) && index("0123456789", substr(v, j, 1)) > 0) j++
        v = substr(v, 1, j - 1)
      }
      print v
      exit
    }'
lock_json_field() { # <file> <key>
  [ -f "$1" ] || return 0
  awk -v key="$2" "$LOCK_JSON_AWK" "$1" 2>/dev/null
}

# The same, over a record already read into a variable.
lock_json_text_field() { # <text> <key>
  printf '%s\n' "$1" | awk -v key="$2" "$LOCK_JSON_AWK" 2>/dev/null
}

lock_owner_field() { # <lock-path> <key>
  lock_json_field "$1/owner" "$2"
}

# --- three-valued observations (#4288 §2.8) ----------------------------------
# Every observation a decision to take, recover or release the lock reads goes
# through one of the lock_obs_* functions below and answers in three values.
# "No" needs positive evidence — ESRCH from kill -0, ENOENT, a listing that
# succeeded — and anything else (EPERM, EACCES, EIO, a listing that failed) is
# "unknown", which never takes, deletes or releases. The first argument is the
# observation point's name: the table in docs/design/verify-lock-holder-group-4288.md
# §2.8 lists every point, and tests/unit/verification/lock-observation-points-4288.test.ts
# fails when a raw kill -0 / mkdir / mv / listing / owner read bypasses it.

# The errno name a failed command's message stands for (messages are read under LC_ALL=C).
lock_errno_of() { # <message>
  case "$1" in
    *cannot\ overwrite\ existing\ file*) echo EEXIST;;
    *[Nn]o\ such\ process*) echo ESRCH;;
    *[Oo]peration\ not\ permitted*) echo EPERM;;
    *[Pp]ermission\ denied*) echo EACCES;;
    *[Nn]o\ such\ file*) echo ENOENT;;
    *[Ff]ile\ exists*) echo EEXIST;;
    *[Ii]nput/output\ error*) echo EIO;;
    *[Ii]s\ a\ directory*) echo EISDIR;;
    *[Nn]ot\ a\ directory*) echo ENOTDIR;;
    *[Dd]irectory\ not\ empty*) echo ENOTEMPTY;;
    *[Nn]o\ space\ left*) echo ENOSPC;;
    *[Tt]oo\ many\ levels*) echo ELOOP;;
    *[Rr]ead-only*) echo EROFS;;
    *) echo EUNKNOWN;;
  esac
}

# The message a failed call prints for <errno> (what an injected fault reads as).
lock_errno_text() { # <errno>
  case "$1" in
    ESRCH) echo "No such process";;
    EPERM) echo "Operation not permitted";;
    EACCES) echo "Permission denied";;
    ENOENT) echo "No such file or directory";;
    EEXIST) echo "File exists";;
    EIO) echo "Input/output error";;
    EISDIR) echo "Is a directory";;
    ENOTDIR) echo "Not a directory";;
    ENOTEMPTY) echo "Directory not empty";;
    ENOSPC) echo "No space left on device";;
    ELOOP) echo "Too many levels of symbolic links";;
    *) echo "Unknown error $1";;
  esac
}

# An errno carried in an exit code (lock_obs_create answers from a pipeline's last element): its
# index in LOCK_ERRNOS (LEI_INDEX; a name not listed is EUNKNOWN's), and back. The bands of
# lock_obs_create (10+i, 40+i, 70+i, 85+i, 100+i; 99 is F11's ENOENT) hold for at most 14 names:
# a 15th would make 85+14 read as 99 (tests/unit/verification/lock-pr1af-impl2-4288.test.ts fixes it).
LOCK_ERRNOS="ESRCH EPERM EACCES ENOENT EEXIST EIO EISDIR ENOTDIR ENOTEMPTY ENOSPC ELOOP EROFS EINVAL EUNKNOWN"
lock_errno_index() { # <errno>
  LEI_INDEX=0
  for lei_e in $LOCK_ERRNOS; do
    [ "$lei_e" = "$1" ] && return 0
    LEI_INDEX=$(( LEI_INDEX + 1 ))
  done
  LEI_INDEX=$(( LEI_INDEX - 1 ))
}
lock_errno_at() { # <index>
  lea_i=0
  for lea_e in $LOCK_ERRNOS; do
    if [ "$lea_i" = "$1" ]; then echo "$lea_e"; return 0; fi
    lea_i=$(( lea_i + 1 ))
  done
  echo EUNKNOWN
}

# Test seam only: CM_VERIFY_TEST_OBS_FAULT (and the file CM_VERIFY_TEST_OBS_FAULT_FILE, read at
# every call so a test can change it while a run waits) holds `<point>=<ERRNO>` or
# `<point>@<substring of the target>=<ERRNO>` items, separated by blanks or newlines. A matching
# observation fails with that errno and goes through the same classification as a real failure.
# Sets LTF_CODE (empty when nothing is injected).
lock_test_obs_fault() { # <point> <target>
  LTF_CODE=""
  ltf_spec=${CM_VERIFY_TEST_OBS_FAULT:-}
  if [ -n "${CM_VERIFY_TEST_OBS_FAULT_FILE:-}" ] && [ -f "$CM_VERIFY_TEST_OBS_FAULT_FILE" ]; then
    ltf_spec="$ltf_spec $(< "$CM_VERIFY_TEST_OBS_FAULT_FILE")"
  fi
  case "$ltf_spec" in *[!\ ]*) ;; *) return 0;; esac
  for ltf_item in $ltf_spec; do
    ltf_key=${ltf_item%%=*}
    case "$ltf_key" in
      "$1") LTF_CODE=${ltf_item#*=}; return 0;;
      "$1@"*) case "$2" in *"${ltf_key#*@}"*) LTF_CODE=${ltf_item#*=}; return 0;; esac;;
    esac
  done
}

# Test seams only: CM_VERIFY_TEST_HANDOFF=pause:<stage>,fault:<stage> with CM_VERIFY_TEST_HANDOFF_DIR.
# A pause writes <dir>/<stage>.reached and waits for <dir>/<stage>.go.
lock_test_pause() { # <stage>
  [ -n "${CM_VERIFY_TEST_HANDOFF_DIR:-}" ] || return 0
  case ",${CM_VERIFY_TEST_HANDOFF:-}," in *",pause:$1,"*) ;; *) return 0;; esac
  : > "$CM_VERIFY_TEST_HANDOFF_DIR/$1.reached"
  while [ ! -e "$CM_VERIFY_TEST_HANDOFF_DIR/$1.go" ]; do sleep 0.05 2>/dev/null || sleep 1; done
}
lock_test_fault() { # <stage>
  case ",${CM_VERIFY_TEST_HANDOFF:-}," in *",fault:$1,"*) return 0;; esac
  return 1
}

# kill -0 <target>, raw: LKR_RC and LKR_OUT (the message). Both judgements over a process — the
# current one and any other — read this, so an injected EPERM reaches them alike. The message is
# read under LC_ALL=C: bash's kill prints strerror(), which a translated C library prints in the
# user's language ("No such process" would then never match, and ESRCH would read as unknown — a
# drain that never ends and a lock nobody recovers; #4288 PM review P2-1). Test seam only:
# CM_VERIFY_TEST_KILL0_CMD names a command run in kill's place, in the same environment, so a test
# can hand back the raw text another locale would print.
lock_kill0_raw() { # <point> <target>
  lock_test_obs_fault "$1" "$2"
  if [ -n "$LTF_CODE" ]; then
    LKR_RC=1
    LKR_OUT="kill: $2: $(lock_errno_text "$LTF_CODE")"
    return 0
  fi
  if [ -n "${CM_VERIFY_TEST_KILL0_CMD:-}" ]; then
    LKR_OUT=$(export LC_ALL=C; "$CM_VERIFY_TEST_KILL0_CMD" -0 -- "$2" 2>&1); LKR_RC=$?
  else
    LKR_OUT=$(export LC_ALL=C; kill -0 -- "$2" 2>&1); LKR_RC=$?
  fi
}

# alive | gone (ESRCH) | unknown:<point>:<errno>. EPERM means the process exists and belongs to
# someone else; only ESRCH is evidence that nothing is there.
lock_obs_kill0() { # <point> <pid or -pgid>
  lock_kill0_raw "$1" "$2"
  if [ "$LKR_RC" -eq 0 ]; then echo alive; return 0; fi
  case "$LKR_OUT" in
    *[Nn]o\ such\ process*) echo gone;;
    *) echo "unknown:$1:$(lock_errno_of "$LKR_OUT")";;
  esac
}

# A directory's entries with the listing's own exit code (never a glob, which expands to itself
# when the directory cannot be read): LOL_STATE=listed|absent|unknown, LOL_NAMES, LOL_CODE.
lock_obs_list() { # <point> <dir>
  LOL_NAMES=""
  LOL_CODE=""
  lock_test_obs_fault "$1" "$2"
  if [ -n "$LTF_CODE" ]; then
    lol_out=$(lock_errno_text "$LTF_CODE")
  elif lol_out=$(LC_ALL=C ls -1A -- "$2" 2>&1); then
    LOL_STATE=listed
    LOL_NAMES=$lol_out
    return 0
  fi
  LOL_CODE=$(lock_errno_of "$lol_out")
  if [ "$LOL_CODE" = ENOENT ]; then LOL_STATE=absent; else LOL_STATE=unknown; fi
}

# dir | other (a file, a symlink: not followed) | absent | unknown:<errno>
lock_obs_lstat() { # <point> <path>
  lock_test_obs_fault "$1" "$2"
  if [ -n "$LTF_CODE" ]; then
    lls_out=$(lock_errno_text "$LTF_CODE")
  elif lls_out=$(LC_ALL=C ls -ld -- "$2" 2>&1); then
    case "$lls_out" in d*) echo dir;; *) echo other;; esac
    return 0
  fi
  lls_code=$(lock_errno_of "$lls_out")
  if [ "$lls_code" = ENOENT ]; then echo absent; else echo "unknown:$lls_code"; fi
}

# <dir>/owner: LOB_CLASS=record (pid and token read) | missing (ENOENT, not a symlink) |
# corrupt (read, but not a record) | unknown (any other failure), and LOB_CODE, LOB_PID,
# LOB_HOST, LOB_TOKEN, LOB_PGID (read the way lock_json_field reads them).
# Every step inside is three-valued too (#4288 Codex re-review P1): the read, each field's
# extraction and the pgid's number check. An extraction that failed (awk not started, killed, out
# of memory: a non-zero exit with nothing printed) is unknown (EUNKNOWN), never an empty field — an
# empty pgid means "no group", and a dead runner's lock would be recovered past its live gate. A
# pgid key that is there but is not a number of digits is unknown (EINVAL) for the same reason.
# Only a record read whole and WITHOUT a pgid key (an older owner) is judged by its pid alone.
# #4288 PR1a-f: LOB_EMPTY=1 when the owner read is of 0 bytes (corrupt: the head takes it out past
# LOCK_EMPTY_OWNER_GRACE_MS, I4), LOB_V the writer's version (I9; empty on an older copy's record) and
# LOB_STARTED_AT the kv record's started_at= (D7). Every one is emptied on every read (F40).
lock_obs_owner_fail() { # <errno>
  LOB_CLASS=unknown
  LOB_CODE=$1
  LOB_PID=""
  LOB_HOST=""
  LOB_TOKEN=""
  LOB_PGID=""
  LOB_LSTART=""
  LOB_STARTED_AT=""
  LOB_V=""
  LOB_EMPTY=""
}
lock_obs_owner() { # <point> <dir>
  lock_obs_owner_fail ""
  lock_test_obs_fault "$1" "$2/owner"
  if [ -n "$LTF_CODE" ]; then
    lob_out=$(lock_errno_text "$LTF_CODE")
    lob_rc=1
  else
    # The `.` keeps the trailing newlines `$(…)` would drop: an owner of only newlines is not of 0
    # bytes (corrupt and named, as the JS reads it; never I4's to take out).
    lob_out=$(LC_ALL=C cat -- "$2/owner" 2>&1 && echo .)
    lob_rc=$?
  fi
  if [ "$lob_rc" -ne 0 ]; then
    LOB_CODE=$(lock_errno_of "$lob_out")
    if [ "$LOB_CODE" = ENOENT ] && [ ! -L "$2/owner" ]; then LOB_CLASS=missing; fi
    return 0
  fi
  lob_out=${lob_out%.}
  if [ -z "$lob_out" ]; then
    LOB_CLASS=corrupt
    LOB_EMPTY=1
    return 0
  fi
  while [ "${lob_out%$'\n'}" != "$lob_out" ]; do lob_out=${lob_out%$'\n'}; done
  if [ -z "$lob_out" ]; then
    LOB_CLASS=corrupt
    return 0
  fi
  # A caller's own record format (#4288 PR1a D1: run-lock / supervisor.lock keep key=value lines). The
  # codec reads the same one read, and answers an extraction it could not make as unknown too.
  if [ -n "$LOCK_OWNER_CODEC" ]; then
    lock_parse_owner_text "$lob_out"
    case $? in
      0) ;;
      2) lock_obs_owner_fail EINVAL; return 0;;
      *) lock_obs_owner_fail EUNKNOWN; return 0;;
    esac
    LOB_PID=$LPO_PID
    LOB_HOST=$LPO_HOST
    LOB_TOKEN=$LPO_TOKEN
    LOB_PGID=$LPO_PGID
    LOB_LSTART=$LPO_LSTART
    LOB_STARTED_AT=${LPO_STARTED_AT:-}
    LOB_V=${LPO_V:-}
    if [ -n "$LOB_PID" ] && [ -n "$LOB_TOKEN" ]; then LOB_CLASS=record; else LOB_CLASS=corrupt; fi
    return 0
  fi
  LOB_PID=$(lock_json_text_field "$lob_out" pid) || { lock_obs_owner_fail EUNKNOWN; return 0; }
  LOB_HOST=$(lock_json_text_field "$lob_out" host) || { lock_obs_owner_fail EUNKNOWN; return 0; }
  LOB_TOKEN=$(lock_json_text_field "$lob_out" token) || { lock_obs_owner_fail EUNKNOWN; return 0; }
  LOB_PGID=$(lock_json_text_field "$lob_out" pgid) || { lock_obs_owner_fail EUNKNOWN; return 0; }
  if ! LOB_V=$(lock_json_text_field "$lob_out" v); then lock_obs_owner_fail EUNKNOWN; return 0; fi
  if [ -n "$LOB_PID" ] && [ -n "$LOB_TOKEN" ]; then LOB_CLASS=record; else LOB_CLASS=corrupt; fi
  if [ "$LOB_CLASS" = record ] && ! lock_pgid_field_ok "$lob_out" "$LOB_PGID"; then lock_obs_owner_fail EINVAL; fi
}

# A record's pgid as extracted: absent (no "pgid": key — an older record) or digits. Anything else
# — the key there and the value empty or not digits (`"pgid":-5`, `"pgid":"x"`) — is not a pgid
# this runner can judge, and the caller reads it as unknown.
lock_pgid_field_ok() { # <record text> <extracted pgid>
  case "$2" in
    '') case "$1" in *'"pgid":'*) return 1;; esac; return 0;;
    *[!0-9]*) return 1;;
  esac
  return 0
}

# The owner codec (#4288 PR1a D1). verify-run.sh's own owner is the JSON record: lock_format_owner
# writes it and lock_obs_owner reads it inline, so every step of that one read stays in the observer
# (§2.8). A caller that keeps another record format (scripts/lib/machine-lock.sh: key=value lines for
# run-lock and supervisor.lock) sets LOCK_OWNER_CODEC and redefines both after loading this section:
#   lock_parse_owner_text <text>  sets LPO_PID LPO_HOST LPO_TOKEN LPO_PGID LPO_LSTART (and, #4288
#     PR1a-f, LPO_STARTED_AT LPO_V) from the one read; 0 = parsed, 1 = an extraction failed (unknown,
#     EUNKNOWN), 2 = a pgid that is there and is not a number (unknown, EINVAL)
#   lock_format_owner <pid> <token> <acquiredAt-ms> [<pgid>]  prints the record, with the writer's
#     version (`"v":1` / `v=1`, #4288 PR1a-f I9: published whole with link, the own pid, the rename undo)
lock_parse_owner_text() { # <text>
  return 1
}
lock_format_owner() { # <pid> <token> <acquiredAt-ms> [<pgid>]
  if [ -n "${4:-}" ]; then
    printf '{"pid":%s,"host":"%s","token":"%s","acquiredAt":%s,"pgid":%s,"v":1}\n' "$1" "$LOCK_HOST" "$2" "$3" "$4"
  else
    printf '{"pid":%s,"host":"%s","token":"%s","acquiredAt":%s,"v":1}\n' "$1" "$LOCK_HOST" "$2" "$3"
  fi
}

# created | exists (EEXIST) | unknown:<errno>
lock_obs_mkdir() { # <point> <path>
  lock_test_obs_fault "$1" "$2"
  if [ -n "$LTF_CODE" ]; then
    lom_out=$(lock_errno_text "$LTF_CODE")
  elif lom_out=$(LC_ALL=C mkdir -- "$2" 2>&1); then
    echo created
    return 0
  fi
  lom_code=$(lock_errno_of "$lom_out")
  if [ "$lom_code" = EEXIST ]; then echo exists; else echo "unknown:$lom_code"; fi
}

# moved | absent (ENOENT: the source is not there) | unknown:<errno>
lock_obs_mv() { # <point> <from> <to>
  lock_test_obs_fault "$1" "$2"
  if [ -n "$LTF_CODE" ]; then
    lmv_out=$(lock_errno_text "$LTF_CODE")
  elif lmv_out=$(LC_ALL=C mv -f -- "$2" "$3" 2>&1); then
    echo moved
    return 0
  fi
  lmv_code=$(lock_errno_of "$lmv_out")
  if [ "$lmv_code" = ENOENT ]; then echo absent; else echo "unknown:$lmv_code"; fi
}

# link(2) of <from> as <to> (#4288 PR1a-f I2): linked | exists (EEXIST — whatever is there: a file, a
# directory, a symlink to either; nothing is made inside it, as `ln` would) | absent (ENOENT) |
# unknown:<errno>. /bin/link calls link(2) as it is (macOS and coreutils).
lock_obs_link() { # <point> <from> <to>
  lock_test_obs_fault "$1" "$3"
  if [ -n "$LTF_CODE" ]; then
    lok_out=$(lock_errno_text "$LTF_CODE")
  elif lok_out=$(LC_ALL=C /bin/link -- "$2" "$3" 2>&1); then
    echo linked
    return 0
  fi
  lok_code=$(lock_errno_of "$lok_out")
  case "$lok_code" in
    EEXIST) echo exists;;
    ENOENT) echo absent;;
    *) echo "unknown:$lok_code";;
  esac
}

# unlink of one name (never a directory, never -f): removed | absent (ENOENT) | unknown:<errno>.
lock_obs_unlink() { # <point> <file>
  lock_test_obs_fault "$1" "$2"
  if [ -n "$LTF_CODE" ]; then
    lou_out=$(lock_errno_text "$LTF_CODE")
  elif lou_out=$(LC_ALL=C rm -- "$2" 2>&1 </dev/null); then
    echo removed
    return 0
  fi
  lou_code=$(lock_errno_of "$lou_out")
  if [ "$lou_code" = ENOENT ]; then echo absent; else echo "unknown:$lou_code"; fi
}

# The entry itself (a symlink is not followed): "<kind> <size> <mtime-ms>" with kind file | link | dir |
# other — or absent | unknown:<errno>. GNU stat first (-c), then BSD (-f); mtime in whole seconds.
lock_obs_stat() { # <point> <path>
  lock_test_obs_fault "$1" "$2"
  if [ -n "$LTF_CODE" ]; then
    los_out=$(lock_errno_text "$LTF_CODE")
  elif los_out=$(LC_ALL=C stat -c '%F|%s|%Y' -- "$2" 2>/dev/null) && [ -n "$los_out" ]; then
    lock_stat_line "$los_out"
    return 0
  elif los_out=$(LC_ALL=C stat -f '%HT|%z|%m' -- "$2" 2>&1) && [ -n "$los_out" ]; then
    lock_stat_line "$los_out"
    return 0
  fi
  los_code=$(lock_errno_of "$los_out")
  if [ "$los_code" = ENOENT ]; then echo absent; else echo "unknown:$los_code"; fi
}
lock_stat_line() { # <type|size|mtime-s>
  lsl_type=${1%%|*}
  lsl_rest=${1#*|}
  lsl_size=${lsl_rest%%|*}
  lsl_m=${lsl_rest#*|}
  case "$lsl_type" in
    [Rr]egular*) lsl_type=file;;
    [Ss]ymbolic*) lsl_type=link;;
    [Dd]irectory) lsl_type=dir;;
    *) lsl_type=other;;
  esac
  case "$lsl_size$lsl_m" in ''|*[!0-9]*) echo unknown:EINVAL; return 0;; esac
  echo "$lsl_type $lsl_size $(( lsl_m * 1000 ))"
}

# The owner, published whole (#4288 PR1a D3, PR1a-f I1): the record on stdin is read once
# (`$(cat)`), written with printf into <lock>/.owner-<token> created exclusively (`set -C`), read
# back the same way and compared (a short write is caught there), then published with link(2)
# (lock_obs_link: an owner there — a file, a directory, a symlink — is never written over or into)
# and read back (point owner-readback): the lock is taken only when it is this acquisition's record.
# <lock>/owner is never seen empty or half written. The tmp is removed after the read-back. What a
# failure removes is only this call's own (design §3): its tmp; when the read-back cannot be judged,
# the owner it published is renamed to its own name .undo-<token> and removed only when that is the
# tmp's inode (`[ ! -L ] && [ -ef ]`), else linked back (I2-b). It runs as the last element of a
# pipeline, so it answers by its exit code — i is lock_errno_index's:
#   0 taken | 3 exists (the link met an owner; own tmp removed) | 6 another record read back (own tmp
#   removed) | 10+i the tmp not created (nothing of ours: the caller's rmdir removes the <lock> only
#   when empty) | 40+i opened, the write failed or read back short (the tmp removed unless that
#   failed too) | 70+i published, the read-back unknown, the own owner undone (the caller rmdir-s) |
#   85+i the link failed (owner-publish; the tmp removed, the caller rmdir-s) | 99 the link answered
#   ENOENT (F11: no rmdir — a <lock> there now is not ours) | 100+i the read-back unknown and the owner
#   not shown to be ours (linked back, or the undo failed: no rmdir).
# Test seams: CM_VERIFY_TEST_HANDOFF=fault:owner-write / fault:owner-unlink and the pauses of §2.6
# (owner-tmp-opened, owner-tmp-written, owner-linked, owner-tmp-removed; owner-lock-made is the
# caller's); CM_VERIFY_TEST_OBS_FAULT at owner-create, owner-write, owner-write-short, owner-publish,
# owner-readback, owner-unlink, owner-undo-rename, owner-undo-lstat, owner-undo-link.
lock_obs_create() { # <point> <file> <token>
  lco_lock=${2%/*}
  lco_tmp="$lco_lock/.owner-$3"
  lco_undo="$lco_lock/.undo-$3"
  if ! lco_text=$(cat); then
    lock_errno_index EIO
    return $(( 10 + LEI_INDEX ))
  fi
  lock_test_obs_fault "$1" "$2"
  if [ -n "$LTF_CODE" ]; then
    lock_errno_index "$LTF_CODE"
    return $(( 10 + LEI_INDEX ))
  fi
  if ! lco_out=$(export LC_ALL=C; set -C; : 2>&1 > "$lco_tmp"); then
    lock_errno_index "$(lock_errno_of "$lco_out")"
    return $(( 10 + LEI_INDEX ))
  fi
  lock_test_pause owner-tmp-opened
  lco_fail=""
  if lock_test_fault owner-write; then lco_fail=EIO; fi
  if [ -z "$lco_fail" ]; then
    lock_test_obs_fault owner-write "$2"
    lco_fail=$LTF_CODE
  fi
  if [ -z "$lco_fail" ]; then
    lock_test_obs_fault owner-write-short "$2"
    lco_short=$LTF_CODE
    if [ -n "$lco_short" ]; then lco_write=${lco_text%?}; else lco_write=$lco_text; fi
    if ! lco_out=$(export LC_ALL=C; { printf '%s\n' "$lco_write" >> "$lco_tmp"; } 2>&1); then
      lco_fail=$(lock_errno_of "$lco_out")
    elif ! lco_back=$(LC_ALL=C cat -- "$lco_tmp" 2>&1); then
      lco_fail=$(lock_errno_of "$lco_back")
    elif [ "$lco_back" != "$lco_text" ]; then
      lco_fail=${lco_short:-EIO}
    fi
  fi
  if [ -n "$lco_fail" ]; then
    if ! lock_test_fault owner-unlink; then lco_rm=$(lock_obs_unlink owner-unlink "$lco_tmp") || lco_rm=""; fi
    lock_errno_index "$lco_fail"
    return $(( 40 + LEI_INDEX ))
  fi
  lock_test_pause owner-tmp-written
  lco_ln=$(lock_obs_link owner-publish "$lco_tmp" "$2") || lco_ln=unknown:EUNKNOWN
  case "$lco_ln" in
    linked) ;;
    exists) lco_rm=$(lock_obs_unlink owner-unlink "$lco_tmp") || lco_rm=""; return 3;;
    absent) lco_rm=$(lock_obs_unlink owner-unlink "$lco_tmp") || lco_rm=""; return 99;;
    *)
      lco_rm=$(lock_obs_unlink owner-unlink "$lco_tmp") || lco_rm=""
      lock_errno_index "${lco_ln#unknown:}"
      return $(( 85 + LEI_INDEX ));;
  esac
  lock_test_pause owner-linked
  lock_obs_owner owner-readback "$lco_lock"
  if [ "$LOB_CLASS" = record ] && [ "$LOB_TOKEN" = "$3" ]; then
    if ! lock_test_fault owner-unlink; then lco_rm=$(lock_obs_unlink owner-unlink "$lco_tmp") || lco_rm=""; fi
    lock_test_pause owner-tmp-removed
    return 0
  fi
  if [ "$LOB_CLASS" != unknown ]; then
    lco_rm=$(lock_obs_unlink owner-unlink "$lco_tmp") || lco_rm=""
    return 6
  fi
  lock_errno_index "$LOB_CODE"
  lco_i=$LEI_INDEX
  # I2-b: never removed by its name after a check — renamed to this call's own name first.
  lco_mv=$(lock_obs_mv owner-undo-rename "$2" "$lco_undo") || lco_mv=unknown:EUNKNOWN
  if [ "$lco_mv" != moved ]; then
    lco_rm=$(lock_obs_unlink owner-unlink "$lco_tmp") || lco_rm=""
    return $(( 100 + lco_i ))
  fi
  lock_test_obs_fault owner-undo-lstat "$lco_undo"
  if [ -z "$LTF_CODE" ] && [ ! -L "$lco_undo" ] && [ "$lco_undo" -ef "$lco_tmp" ]; then
    lco_rm=$(lock_obs_unlink owner-unlink "$lco_undo") || lco_rm=""
    lco_rm=$(lock_obs_unlink owner-unlink "$lco_tmp") || lco_rm=""
    return $(( 70 + lco_i ))
  fi
  lco_back=$(lock_obs_link owner-undo-link "$lco_undo" "$2") || lco_back=unknown:EUNKNOWN
  lco_rm=$(lock_obs_unlink owner-unlink "$lco_tmp") || lco_rm=""
  if [ "$lco_back" = linked ]; then
    lco_rm=$(lock_obs_unlink owner-unlink "$lco_undo") || lco_rm=""
  else
    echo "verify-run: machine-lock-undo-restore-failed $lco_lock kept=$lco_undo ($lco_back)" >&2
  fi
  return $(( 100 + lco_i ))
}

# The modification time of <path> itself (not followed) in ms — <ms> | absent | unknown:<errno>.
# GNU stat first (-c %Y), then BSD (-f %m); whole seconds, like lock_now_ms on macOS.
lock_obs_mtime() { # <point> <path>
  lock_test_obs_fault "$1" "$2"
  if [ -n "$LTF_CODE" ]; then
    lot_out=$(lock_errno_text "$LTF_CODE")
  elif lot_out=$(LC_ALL=C stat -c %Y -- "$2" 2>/dev/null) && [ -n "$lot_out" ] && [ -z "${lot_out//[0-9]/}" ]; then
    echo $(( lot_out * 1000 ))
    return 0
  elif lot_out=$(LC_ALL=C stat -f %m -- "$2" 2>&1) && [ -n "$lot_out" ] && [ -z "${lot_out//[0-9]/}" ]; then
    echo $(( lot_out * 1000 ))
    return 0
  fi
  lot_code=$(lock_errno_of "$lot_out")
  if [ "$lot_code" = ENOENT ]; then echo absent; else echo "unknown:$lot_code"; fi
}

# The process group of <pid> (`ps -o pgid=`), or unknown:<errno> when ps cannot say.
lock_obs_pgid() { # <point> <pid>
  lock_test_obs_fault "$1" "$2"
  if [ -n "$LTF_CODE" ]; then echo "unknown:$LTF_CODE"; return 0; fi
  lop_out=$(ps -o pgid= -p "$2" 2>/dev/null) || { echo unknown:ESRCH; return 0; }
  lop_out=$(printf '%s' "$lop_out" | tr -d ' ') || { echo unknown:EUNKNOWN; return 0; }
  case "$lop_out" in ''|*[!0-9]*) echo unknown:EUNKNOWN;; *) echo "$lop_out";; esac
}

# rmdir of an empty directory whose failure is reported, not only noticed (#4288 Codex re-review
# P2): prints nothing when removed, else the errno (EACCES, EIO, ENOTEMPTY …), which the caller
# carries to the timeout's report as point / path / errno. The point names the action for the
# test seam (CM_VERIFY_TEST_OBS_FAULT) and the report.
lock_rmdir_errno() { # <point> <dir>
  lock_test_obs_fault "$1" "$2"
  if [ -n "$LTF_CODE" ]; then echo "$LTF_CODE"; return 0; fi
  if lre_out=$(LC_ALL=C rmdir -- "$2" 2>&1); then return 0; fi
  lock_errno_of "$lre_out"
}

# The first unknown of this poll, for the timeout's report: "point=… path=… errno=…".
lock_note_unknown() { # <point> <path> <errno>
  [ -n "$LOCK_UNKNOWN" ] || LOCK_UNKNOWN="point=$1 path=$2 errno=$3"
}

lock_warn_once() { # <line>
  case "$LOCK_WARNED" in *"|$1|"*) return 0;; esac
  LOCK_WARNED="$LOCK_WARNED|$1|"
  echo "verify-run: $1" >&2
}

# A recorded process group: gone (none recorded, or ESRCH) | alive | unknown:group:<errno>.
# A pgid that is not a number of digits is not "none recorded": unknown (EINVAL).
lock_group_state() { # <pgid>
  case "$1" in
    '') echo gone; return 0;;
    *[!0-9]*) echo unknown:group:EINVAL; return 0;;
  esac
  [ "$1" -gt 1 ] || { echo gone; return 0; }
  lock_obs_kill0 group "-$1"
}

# A holder that named a process group (merge-pr's inner process, #4277; this runner's gate, #4288)
# is alive while any process of the group is. Empty only on ESRCH: EPERM — a member that belongs to
# another user — and every other failure mean someone may still be there.
lock_group_is_empty() { # <pgid>
  [ "$(lock_group_state "$1")" = gone ]
}

# Is the recorded holder gone? Only decidable on the machine that wrote the
# record: a pid from another host says nothing about a process here, and breaking
# a lock on that guess lets two machines sharing a network home run the gate at
# once. gone | alive | unknown:<point>:<errno>.
lock_holder_state() { # <pid> <host> <pgid>
  if [ -z "$1" ] || [ "$2" != "$LOCK_HOST" ]; then echo alive; return 0; fi
  lhs_p=$(lock_obs_kill0 pid "$1")
  if [ "$lhs_p" != gone ]; then echo "$lhs_p"; return 0; fi
  lock_group_state "$3"
}

# The same over the owner record lock_obs_owner read: its one read (LOB_PID / LOB_HOST / LOB_PGID),
# never a second read of the file. A second read of the pgid that failed (EACCES, EIO) came back
# empty — "no group" — and let a live group's lock be recovered (#4288 Codex 5-2b P1 / PM review
# P2-2). The token changes when the group is published (§2.2), so the record judged and the record
# the recovery deletes are tied by the token, not by reading the fields again.
lock_record_state() { # (reads LOB_PID LOB_HOST LOB_PGID)
  lock_holder_state "$LOB_PID" "$LOB_HOST" "$LOB_PGID"
}

lock_record_gone() { # <pid> <host> <pgid>, from one read of the record
  [ "$(lock_holder_state "$1" "$2" "$3")" = gone ]
}

# `ps -o etime=` (`[[dd-]hh:]mm:ss`) in ms, or return 1 (#4288 PR1a-f, design §4.1): only
# `^([0-9]+-)?([0-9]{1,2}:)?[0-9]{1,2}:[0-9]{2}$` (a day field only with an hour field), hours < 24,
# minutes and seconds < 60 — a malformed answer is never read as "just started" (E7). Pure arithmetic.
# scripts/lib/machine-lock.sh's machine_lock_etime_ms is this function.
LOCK_ETIME_RE='^(([0-9]+)-)?(([0-9]{1,2}):)?([0-9]{1,2}):([0-9]{2})$'
lock_etime_ms() { # <etime text>
  let_s=${1#"${1%%[![:space:]]*}"}
  let_s=${let_s%"${let_s##*[![:space:]]}"}
  [[ $let_s =~ $LOCK_ETIME_RE ]] || return 1
  let_d=${BASH_REMATCH[2]}
  let_h=${BASH_REMATCH[4]}
  if [ -n "$let_d" ] && [ -z "$let_h" ]; then return 1; fi
  let_h=$(( 10#${let_h:-0} ))
  let_m=$(( 10#${BASH_REMATCH[5]} ))
  let_x=$(( 10#${BASH_REMATCH[6]} ))
  if [ "$let_h" -ge 24 ] || [ "$let_m" -ge 60 ] || [ "$let_x" -ge 60 ]; then return 1; fi
  echo $(( (((10#${let_d:-0} * 24 + let_h) * 60 + let_m) * 60 + let_x) * 1000 ))
}

# When <pid> started (ms), from `ps -o etime=`; empty when ps cannot say. The clock is read before ps
# and again after it (#4288 PR1a-f, P1's observation window): a step back in between, or a read of 1 s
# or more, is empty too (a step inside it cannot be told; the ticket is not retired, an older tmp not
# taken out) and returns 3, so I3 names it ECLOCK (F53); ps that cannot say is empty with 0. The start
# is <before> − etime. No cache: a command substitution cannot keep one.
lock_pid_start_ms() { # <pid>
  lps_before=$(lock_now_ms) || return 0
  if ! lps_et=$(ps -o etime= -p "$1" 2>/dev/null); then return 0; fi
  lps_after=$(lock_now_ms) || return 0
  if [ "$lps_after" -lt "$lps_before" ] || [ $(( lps_after - lps_before )) -ge 1000 ]; then return 3; fi
  lps_ms=$(lock_etime_ms "$lps_et") || return 0
  echo $(( lps_before - lps_ms ))
}

# Why another waiter's ticket may be retired (printed), or return 1 — never by
# age alone: a long gate budget is a legitimate long wait.
lock_ticket_retirable() { # <file> <now-ms>
  # One read of the ticket; a ticket that cannot be read is never retired (it blocks like a live one).
  # Nor is one whose fields cannot be extracted (#4288 Codex re-review P1): an extraction that
  # failed is not an empty field.
  ltr_text=$(cat -- "$1" 2>/dev/null) || return 1
  ltr_token=$(lock_json_text_field "$ltr_text" token) || return 1
  [ -n "$ltr_token" ] || return 1
  ltr_host=$(lock_json_text_field "$ltr_text" host) || return 1
  ltr_pid=$(lock_json_text_field "$ltr_text" pid) || return 1
  ltr_pgid=$(lock_json_text_field "$ltr_text" pgid) || return 1
  # A pgid key with no number in it is not "no group": the group check answers unknown (EINVAL).
  lock_pgid_field_ok "$ltr_text" "$ltr_pgid" || ltr_pgid=invalid
  ltr_created=$(lock_json_text_field "$ltr_text" createdAt) || return 1
  ltr_deadline=$(lock_json_text_field "$ltr_text" deadline) || return 1
  if [ "$ltr_host" = "$LOCK_HOST" ]; then
    if lock_record_gone "$ltr_pid" "$ltr_host" "$ltr_pgid"; then echo gone; return 0; fi
    if [ -n "$ltr_pid" ] && [ "$ltr_pid" != "$LOCK_SELF_PID" ] && [ -n "$ltr_created" ]; then
      ltr_start=$(lock_pid_start_ms "$ltr_pid") || ltr_start=""
      if [ -n "$ltr_start" ] && [ "$ltr_start" -gt $(( ltr_created + LOCK_PID_REUSE_SLACK_MS )) ]; then
        echo pid-reused
        return 0
      fi
    fi
    if [ -n "$ltr_deadline" ] && [ "$2" -gt $(( ltr_deadline + LOCK_SAME_HOST_GRACE_MS )) ]; then echo expired; return 0; fi
    return 1
  fi
  if [ -n "$ltr_deadline" ] && [ "$2" -gt $(( ltr_deadline + LOCK_OTHER_HOST_GRACE_MS )) ]; then echo expired; return 0; fi
  return 1
}

# Ticket names in the queue, ascending (12 digits, so lexical order is numeric).
# Returns 1 (printing nothing) when the queue cannot be listed: never read as "no tickets".
lock_ticket_names() { # <queue-dir>
  lock_obs_list list-queue "$1"
  [ "$LOL_STATE" != unknown ] || return 1
  [ -n "$LOL_NAMES" ] || return 0
  printf '%s\n' "$LOL_NAMES" | grep -E '^[0-9]{12}$' | sort
  return 0
}

# Mark a ticket used, if it is still <token>'s, by renaming a {done:true} record
# over it (readers see the old or the new content, never half).
lock_mark_done() { # <file> <token>
  [ "$(lock_json_field "$1" token)" = "$2" ] || return 1
  [ "$(lock_json_field "$1" done)" != "true" ] || return 1
  lmd_tmp="$(dirname "$1")/.d-$2-$$-${RANDOM}${RANDOM}"
  if printf '{"done":true,"token":"%s","doneAt":%s}\n' "$2" "$(lock_now_ms)" > "$lmd_tmp" 2>/dev/null &&
    mv -f "$lmd_tmp" "$1" 2>/dev/null; then
    return 0
  fi
  rm -f "$lmd_tmp" 2>/dev/null
  return 1
}

# Publish <tmp> as the ticket max+1 and withdraw it when a larger number exists
# (it was published late). Sets LOCK_TICKET, or leaves it empty when every try
# this poll met contention. Returns 1 only when `ln` failed for another reason
# than an existing name.
lock_take_ticket() { # <queue-dir> <tmp>
  ltt_tries=0
  while [ "$ltt_tries" -lt "$LOCK_LINK_TRIES" ]; do
    ltt_tries=$(( ltt_tries + 1 ))
    ltt_max=$(lock_ticket_names "$1" | tail -n 1)
    [ -n "$ltt_max" ] || ltt_max=0
    ltt_name=$(printf '%012d' $(( 10#$ltt_max + 1 )))
    # EEXIST is told by ln's own message (LC_ALL=C), not by looking for the
    # name afterwards: the ticket it collided with can be marked done and
    # collected by the next taker in between, and that is still a collision to
    # retry, not a failure to publish (the TS / sync JS copies read the errno).
    if ! ltt_err=$(LC_ALL=C ln "$2" "$1/$ltt_name" 2>&1); then
      case "$ltt_err" in
        *[Ff]ile\ exists*) continue;;
      esac
      [ -e "$1/$ltt_name" ] && continue
      echo "verify-run: ln $2 $1/$ltt_name: $ltt_err" >&2
      return 1
    fi
    if [ "$(lock_ticket_names "$1" | tail -n 1)" != "$ltt_name" ]; then
      lock_mark_done "$1/$ltt_name" "$LOCK_TOKEN" || true
      continue
    fi
    LOCK_TICKET="$1/$ltt_name"
    return 0
  done
  return 0
}

# Delete used tickets below the largest (the largest stays, so a late ticket
# always sees a larger one), and temporaries a dead writer left an hour ago.
lock_collect_garbage() { # <queue-dir>
  lcg_max=$(lock_ticket_names "$1" | tail -n 1)
  for lcg_name in $(lock_ticket_names "$1"); do
    [ "$lcg_name" = "$lcg_max" ] && continue
    if [ "$(lock_json_field "$1/$lcg_name" done)" = "true" ]; then rm -f "$1/$lcg_name" 2>/dev/null; fi
  done
  find "$1" -maxdepth 1 -type f \( -name '.t-*' -o -name '.d-*' \) -mmin +60 -exec rm -f {} + 2>/dev/null || true
}

lock_retire_own_ticket() {
  if [ -n "$LOCK_TICKET" ]; then lock_mark_done "$LOCK_TICKET" "$LOCK_TOKEN" || true; fi
  LOCK_TICKET=""
}

# --- locks moved aside (#4288 §2.7) --------------------------------------------
# A recovery moves a dead holder's lock to `<lock>.gone-<token>-<serial>` before it reads it,
# and puts it back when the record is not the one it judged. A put-back that failed leaves the
# record there, and the lock path free: such a record is read as HELD while it is alive (or
# cannot be read), so nobody's mkdir goes past a gate that is still running. Only names of the
# form the three implementations write are read: the suffix has no `.` or `_`, so another legal
# mutex such as `a.lock.gone-b` is never mistaken for mutex `a`'s.

# LGC_LIST: the moved-aside directories of <lock>, one per line. Returns 1 when that cannot be
# known (a listing or an lstat that failed), with LGC_POINT / LGC_PATH / LGC_CODE.
lock_gone_candidates() { # <point> <lock-path>
  LGC_LIST=""
  lgc_root=${2%/*}
  lgc_prefix="${2##*/}.gone-"
  lock_obs_list "$1" "$lgc_root"
  case "$LOL_STATE" in
    absent) return 0;;
    unknown) LGC_POINT=$1; LGC_PATH=$lgc_root; LGC_CODE=$LOL_CODE; return 1;;
  esac
  while IFS= read -r lgc_n; do
    case "$lgc_n" in "$lgc_prefix"?*) ;; *) continue;; esac
    case "${lgc_n#"$lgc_prefix"}" in *[!A-Za-z0-9-]*) continue;; esac
    lgc_st=$(lock_obs_lstat gone-lstat "$lgc_root/$lgc_n")
    case "$lgc_st" in
      dir) LGC_LIST="$LGC_LIST$lgc_root/$lgc_n
";;
      unknown:*) LGC_POINT=gone-lstat; LGC_PATH="$lgc_root/$lgc_n"; LGC_CODE=${lgc_st#unknown:}; return 1;;
    esac
  done <<LGC_EOF
$LOL_NAMES
LGC_EOF
  return 0
}

# <lock> exists with no owner and nothing in it — a put-back stopped half way:
# yes | no | absent | unknown:<point>:<path>:<errno>
lock_ownerless_empty() { # <lock-path>
  lock_obs_owner lock-owner "$1"
  case "$LOB_CLASS" in
    unknown) echo "unknown:lock-owner:$1/owner:$LOB_CODE"; return 0;;
    missing) ;;
    *) echo no; return 0;;
  esac
  lock_obs_list lock-list "$1"
  case "$LOL_STATE" in
    absent) echo absent;;
    unknown) echo "unknown:lock-list:$1:$LOL_CODE";;
    *) if [ -z "$LOL_NAMES" ]; then echo yes; else echo no; fi;;
  esac
}

# Put a moved-aside owner back into <lock> and drop the moved-aside directory. The put-back is a
# link(2) (#4288 PR1a-f I2-c): an owner published between the caller's check (created / an
# owner-less, empty <lock>) and the put-back is never written over — EEXIST keeps the moved-aside
# directory and the <lock> (it holds the publisher's owner), named. LMO_RESULT: restored | absent
# (ENOENT) | restore-failed (EEXIST; or any other failure: the empty <lock> is taken out again and the
# moved-aside directory kept — it goes on holding the lock).
lock_move_owner_in() { # <lock-path> <gone>
  lmo_mv=$(lock_obs_link restore-rename "$2/owner" "$1/owner")
  case "$lmo_mv" in
    linked)
      lock_test_pause restore-owner
      rm -rf "$2" 2>/dev/null
      LMO_RESULT=restored;;
    absent) LMO_RESULT=absent;;
    exists)
      echo "verify-run: machine-lock-restore-failed $1: kept $2 (EEXIST)" >&2
      LMO_RESULT=restore-failed;;
    *)
      rmdir "$1" 2>/dev/null
      echo "verify-run: machine-lock-restore-failed $1: kept $2 (${lmo_mv#unknown:})" >&2
      LMO_RESULT=restore-failed;;
  esac
}

# §2.7 rows 2, 3 and 5: a moved-aside record that is alive (or not known to be gone) is put back.
lock_restore_from_gone() { # <lock-path> <gone>
  lrg_m=$(lock_obs_mkdir restore-mkdir "$1")
  case "$lrg_m" in
    created)
      lock_test_pause restore-mkdir
      lock_move_owner_in "$1" "$2"
      case "$LMO_RESULT" in
        absent) rmdir "$1" 2>/dev/null;;
        restored) echo "verify-run: machine-lock-restored $1 from $2" >&2;;
      esac;;
    exists)
      case "$(lock_ownerless_empty "$1")" in
        yes)
          lock_move_owner_in "$1" "$2"
          if [ "$LMO_RESULT" = restored ]; then echo "verify-run: machine-lock-restored $1 from $2 (completed a put-back)" >&2; fi;;
        no) lock_warn_once "machine-lock-restore-failed $1: kept $2 (the lock holds another record)";;
      esac;;
    *) lock_warn_once "machine-lock-restore-failed $1: kept $2 (${lrg_m#unknown:})";;
  esac
}

# §2.7 rows 4 and 7: a moved-aside record judged gone (or this run's own) goes to this waiter's own
# name and is deleted only while it is still the record judged. With <take-back-half> 1 a <lock>
# left empty by a put-back that stopped half way is removed first (never on release). When that
# cannot be settled — whether <lock> is such a half put-back is unknown (EIO on its listing), or
# its rmdir failed — the moved-aside record is KEPT and 1 returned (LRG_HALF says why): it is the
# only trace that lets a later head take the empty <lock> back once the fault clears, and without
# it nobody would ever remove a <lock> that has no owner (#4288 Codex 5-2b P2-1). A failed rmdir
# carries its reason like an unknown observation does (LRG_HALF=unknown:reclaim-rmdir:<lock>:<errno>,
# #4288 Codex re-review P2), so the timeout names the point, the path and the errno.
lock_reclaim_gone() { # <lock-path> <gone> <token> <take-back-half>
  LRG_HALF=""
  if [ "$4" = 1 ]; then
    LRG_HALF=$(lock_ownerless_empty "$1")
    case "$LRG_HALF" in
      unknown:*) return 1;;
      yes) rmdir_err=$(lock_rmdir_errno reclaim-rmdir "$1")
        if [ -n "$rmdir_err" ]; then
          LRG_HALF="unknown:reclaim-rmdir:$1:$rmdir_err"
          return 1
        fi;;
    esac
  fi
  LOCK_GONE_SERIAL=$(( LOCK_GONE_SERIAL + 1 ))
  lrg_mine="$1.gone-${LOCK_TOKEN:-$$}-$LOCK_GONE_SERIAL"
  [ "$(lock_obs_mv reclaim-rename "$2" "$lrg_mine")" = moved ] || return 0
  lock_obs_owner reclaim-owner "$lrg_mine"
  if [ "$LOB_CLASS" = record ] && [ "$LOB_TOKEN" = "$3" ]; then
    rm -rf "$lrg_mine" 2>/dev/null
    echo "verify-run: machine-lock-gone-recovered $2 (recorded holder pid $LOB_PID is gone)" >&2
  fi
}

# The head's pass over the locks moved aside, before its mkdir. Returns 1 to keep this poll from
# the mkdir (sets LOCK_GONE_PENDING for the report, and LOCK_UNKNOWN when it was an unknown).
lock_settle_gone() { # <lock-path>
  if ! lock_gone_candidates list-root "$1"; then
    lock_warn_once "machine-lock-gone-unreadable $LGC_PATH $LGC_CODE"
    lock_note_unknown "$LGC_POINT" "$LGC_PATH" "$LGC_CODE"
    LOCK_GONE_PENDING="$LGC_PATH unreadable"
    return 1
  fi
  lsg_rc=0
  while IFS= read -r lsg_g; do
    [ -n "$lsg_g" ] || continue
    lock_obs_owner gone-owner "$lsg_g"
    case "$LOB_CLASS" in
      unknown)
        lock_warn_once "machine-lock-gone-unreadable $lsg_g $LOB_CODE"
        lock_note_unknown gone-owner "$lsg_g/owner" "$LOB_CODE"
        [ -n "$LOCK_GONE_PENDING" ] || LOCK_GONE_PENDING="$lsg_g unreadable"
        lsg_rc=1
        continue;;
      missing) rmdir "$lsg_g" 2>/dev/null; continue;;
      corrupt) continue;;
    esac
    lock_note_legacy "$1"
    # The same judgement as the lock's own record (lock_record_state over this one read), so a check a
    # loader wraps around it — supervisor.lock's lstart (#4288 PR1a D7) — reaches the moved-aside ones.
    lsg_state=$(lock_record_state)
    if [ "$lsg_state" = gone ]; then
      if ! lock_reclaim_gone "$1" "$lsg_g" "$LOB_TOKEN" 1; then
        lsg_rc=1
        [ -n "$LOCK_GONE_PENDING" ] || LOCK_GONE_PENDING=$lsg_g
        case "$LRG_HALF" in
          unknown:*)
            lsg_u=${LRG_HALF#unknown:}
            lsg_up=${lsg_u%%:*}
            lsg_u=${lsg_u#*:}
            lock_note_unknown "$lsg_up" "${lsg_u%:*}" "${lsg_u##*:}";;
        esac
      fi
      continue
    fi
    lsg_rc=1
    [ -n "$LOCK_GONE_PENDING" ] || LOCK_GONE_PENDING=$lsg_g
    case "$lsg_state" in
      unknown:*)
        lock_note_mismatch "$lsg_g" "$lsg_state"
        lsg_u=${lsg_state#unknown:}
        lock_note_unknown "${lsg_u%%:*}" "$lsg_g" "${lsg_u#*:}";;
    esac
    lock_restore_from_gone "$1" "$lsg_g"
  done <<LSG_EOF
$LGC_LIST
LSG_EOF
  return "$lsg_rc"
}

# §2.7 row 7: this run's own records left in moved-aside directories go when it releases — not
# while the group the record names still has a member (§2.5).
lock_release_own_gone() { # <lock-path> <token>
  if ! lock_gone_candidates release-list "$1"; then
    echo "verify-run: machine-lock-gone-unreadable $LGC_PATH $LGC_CODE" >&2
    return 0
  fi
  while IFS= read -r lro_g; do
    [ -n "$lro_g" ] || continue
    lock_obs_owner gone-owner "$lro_g"
    { [ "$LOB_CLASS" = record ] && [ "$LOB_TOKEN" = "$2" ]; } || continue
    if ! lock_group_is_empty "$LOB_PGID"; then
      echo "verify-run: machine-lock-release-deferred $lro_g pgid=$LOB_PGID" >&2
      continue
    fi
    lock_reclaim_gone "$1" "$lro_g" "$2" 0
  done <<LRO_EOF
$LGC_LIST
LRO_EOF
}

# Recover a lock whose recorded holder is gone: move it aside, then read what was
# moved. Only the very record judged dead is deleted; a lock someone took
# meanwhile (an old-version cleaner let them in), or a record rewritten under a
# new token (a gate's group published, #4288 §2.2), is put back, never over a
# lock taken in between. A put-back that cannot finish keeps the moved-aside
# directory, which every head then reads as held while its record lives (§2.7).
lock_recover() { # <lock-path> <dead-token> <dead-pid>
  LOCK_GONE_SERIAL=$(( LOCK_GONE_SERIAL + 1 ))
  lrc_gone="$1.gone-$LOCK_TOKEN-$LOCK_GONE_SERIAL"
  LRC_RESULT=""
  lrc_aside=$(lock_obs_mv rename-aside "$1" "$lrc_gone")
  case "$lrc_aside" in
    moved) ;;
    absent) LRC_RESULT=absent; return 0;;
    *) LRC_RESULT=unknown; return 0;;
  esac
  lock_test_pause recover-moved
  lock_obs_owner recover-owner "$lrc_gone"
  if [ "$LOB_CLASS" = record ] && [ "$LOB_TOKEN" = "$2" ]; then
    rm -rf "$lrc_gone" 2>/dev/null || true
    lock_note_recovered "$1" "$3"
    LRC_RESULT=recovered
    return 0
  fi
  lrc_m=$(lock_obs_mkdir restore-mkdir "$1")
  if [ "$lrc_m" != created ]; then
    echo "verify-run: machine-lock-restore-failed $1: kept $lrc_gone" >&2
    LRC_RESULT=restore-failed
    return 0
  fi
  lock_test_pause restore-mkdir
  lock_move_owner_in "$1" "$lrc_gone"
  LRC_RESULT=$LMO_RESULT
  # ENOENT: the moved lock had no owner — a new writer's temporaries were in it (they went with the
  # move), and that writer's link answers ENOENT (F11: it refuses and removes nothing else).
  if [ "$LMO_RESULT" = absent ]; then rm -rf "$lrc_gone" 2>/dev/null || true; LRC_RESULT=restored; fi
}

# The line a recovery prints (a caller with its own wording — run-lock's — redefines it after the load).
lock_note_recovered() { # <lock-path> <dead-pid>
  echo "verify-run: broke a stale lock at $1 (recorded holder pid $2 on this host no longer exists)" >&2
}

# I3's predicate (#4288 PR1a-f), called by the clean-up (lock_expire_ownerless) only: <lock> has no
# owner and holds nothing but temporaries — `.owner-<token>` (the new writers' and the hand-off's) or
# an older run-lock / supervisor.lock writer's `owner.tmp.<digits>` — each a regular file. Sets LOTO:
# no | absent | empty | temps | stray:<name> | unknown:<point>:<path>:<errno>, and LOTO_TEMPS (one
# "<name> <mtime-ms> <pid or ->" per line). lock_ownerless_empty keeps its meaning (the put-back's).
lock_ownerless_temps_only() { # <lock-path>
  LOTO=""
  LOTO_TEMPS=""
  lock_obs_owner lock-owner "$1"
  case "$LOB_CLASS" in
    unknown) LOTO="unknown:lock-owner:$1/owner:$LOB_CODE"; return 0;;
    missing) ;;
    *) LOTO=no; return 0;;
  esac
  lock_obs_list lock-list "$1"
  case "$LOL_STATE" in
    absent) LOTO=absent; return 0;;
    unknown) LOTO="unknown:lock-list:$1:$LOL_CODE"; return 0;;
  esac
  while IFS= read -r loto_n; do
    [ -n "$loto_n" ] || continue
    loto_pid=-
    case "$loto_n" in
      .owner-*) case "${loto_n#.owner-}" in ''|*[!A-Za-z0-9-]*) LOTO="stray:$loto_n"; return 0;; esac;;
      owner.tmp.*)
        loto_pid=${loto_n#owner.tmp.}
        case "$loto_pid" in ''|*[!0-9]*) LOTO="stray:$loto_n"; return 0;; esac;;
      *) LOTO="stray:$loto_n"; return 0;;
    esac
    loto_st=$(lock_obs_stat ownerless-tmp-lstat "$1/$loto_n")
    case "$loto_st" in
      absent) continue;;
      unknown:*) LOTO="unknown:ownerless-tmp-lstat:$1/$loto_n:${loto_st#unknown:}"; return 0;;
      file\ *) ;;
      *) LOTO="stray:$loto_n"; return 0;;
    esac
    LOTO_TEMPS="$LOTO_TEMPS$loto_n ${loto_st##* } $loto_pid
"
  done <<LOTO_EOF
$LOL_NAMES
LOTO_EOF
  if [ -n "$LOTO_TEMPS" ]; then LOTO=temps; else LOTO=empty; fi
}

# D3 (#4288 PR1a) and I3 (PR1a-f): with LOCK_OWNERLESS_GRACE_MS set, the head takes out a <lock> that
# has no owner and holds nothing or only temporaries (lock_ownerless_temps_only), when the <lock> and
# every temporary are older than the grace and every older `owner.tmp.<pid>` is shown not to be its
# writer's: the pid is gone (ESRCH), or alive and started after the tmp's mtime + LOCK_PID_REUSE_SLACK_MS
# (reused, F52). Only those names are unlinked (ENOENT: gone already, F23) and then the <lock> rmdir'd —
# never the name `owner`: an owner published meanwhile makes the rmdir fail (ENOTEMPTY: `published`,
# F24). A name that is not a temporary is `stray`, an older writer that may be stopped mid-way
# `old-taker` — named once, not taken (I3). Only the head calls this. The ages are compared in ms.
# LEO_RESULT: none | young | removed | stray | old-taker | published | unknown. Returns 1 — no mkdir
# this poll — only on an unknown (noted for the timeout's report).
lock_expire_ownerless() { # <lock-path>
  LEO_RESULT=none
  [ -n "$LOCK_OWNERLESS_GRACE_MS" ] || return 0
  lock_ownerless_temps_only "$1"
  case "$LOTO" in
    empty|temps) ;;
    unknown:*)
      leo_u=${LOTO#unknown:}
      leo_p=${leo_u%%:*}
      leo_u=${leo_u#*:}
      lock_note_unknown "$leo_p" "${leo_u%:*}" "${leo_u##*:}"
      LEO_RESULT=unknown
      return 1;;
    stray:*)
      lock_warn_once "machine-lock-ownerless-stray $1 (${LOTO#stray:} is not a temporary of an owner: nobody takes the <lock> out; look at it and remove it by hand)"
      LEO_RESULT=stray
      return 0;;
    *) return 0;;
  esac
  while IFS=' ' read -r leo_n leo_t leo_pid; do
    [ -n "$leo_n" ] && [ "$leo_pid" != - ] || continue
    lock_warn_once "machine-lock-legacy-writer $1 pid=$leo_pid"
  done <<LEO_EOF
$LOTO_TEMPS
LEO_EOF
  leo_m=$(lock_obs_mtime ownerless-mtime "$1")
  case "$leo_m" in
    absent) return 0;;
    unknown:*) lock_note_unknown ownerless-mtime "$1" "${leo_m#unknown:}"; LEO_RESULT=unknown; return 1;;
  esac
  leo_now=$(lock_now_ms)
  leo_age=$(( leo_now - leo_m ))
  if [ "$leo_age" -le "$LOCK_OWNERLESS_GRACE_MS" ]; then LEO_RESULT=young; return 0; fi
  while IFS=' ' read -r leo_n leo_t leo_pid; do
    [ -n "$leo_n" ] || continue
    if [ $(( leo_now - leo_t )) -le "$LOCK_OWNERLESS_GRACE_MS" ]; then LEO_RESULT=young; return 0; fi
  done <<LEO_EOF
$LOTO_TEMPS
LEO_EOF
  while IFS=' ' read -r leo_n leo_t leo_pid; do
    [ -n "$leo_n" ] && [ "$leo_pid" != - ] || continue
    leo_k=$(lock_obs_kill0 owner-tmp-pid "$leo_pid")
    case "$leo_k" in
      gone) continue;;
      unknown:*)
        leo_k=${leo_k#unknown:}
        lock_note_unknown owner-tmp-pid "$1/$leo_n" "${leo_k#*:}"
        LEO_RESULT=unknown
        return 1;;
    esac
    leo_why=EINVAL
    leo_start=$(lock_pid_start_ms "$leo_pid") || { [ "$?" = 3 ] && leo_why=ECLOCK; leo_start=""; }
    if [ -z "$leo_start" ]; then
      lock_note_unknown etime "$1/$leo_n" "$leo_why"
      LEO_RESULT=unknown
      return 1
    fi
    [ "$leo_start" -gt $(( leo_t + LOCK_PID_REUSE_SLACK_MS )) ] && continue
    lock_warn_once "machine-lock-ownerless-old-taker $1 pid=$leo_pid (an older writer that may be stopped before its rename: not taken out)"
    LEO_RESULT=old-taker
    return 0
  done <<LEO_EOF
$LOTO_TEMPS
LEO_EOF
  while IFS=' ' read -r leo_n leo_t leo_pid; do
    [ -n "$leo_n" ] || continue
    leo_r=$(lock_obs_unlink ownerless-tmp-unlink "$1/$leo_n")
    case "$leo_r" in
      removed|absent) ;;
      *) lock_note_unknown ownerless-tmp-unlink "$1/$leo_n" "${leo_r#unknown:}"; LEO_RESULT=unknown; return 1;;
    esac
  done <<LEO_EOF
$LOTO_TEMPS
LEO_EOF
  leo_err=$(lock_rmdir_errno ownerless-rmdir "$1")
  case "$leo_err" in
    '') ;;
    ENOTEMPTY|EEXIST) LEO_RESULT=published; return 0;;
    *) lock_note_unknown ownerless-rmdir "$1" "$leo_err"; LEO_RESULT=unknown; return 1;;
  esac
  echo "verify-run: machine-lock-ownerless-removed $1 (no owner for ${leo_age} ms)" >&2
  LEO_RESULT=removed
  return 0
}

# I4 (#4288 PR1a-f): an owner of 0 bytes older than LOCK_EMPTY_OWNER_GRACE_MS is the head's to take out
# — any head, with or without a grace (an older copy's writer killed between `: >` and its write, or a
# power loss after the link). The <lock> is moved to this caller's own name `<lock>.gone-<token>-<serial>`
# and removed only when the owner moved is still of 0 bytes and old; one that was written meanwhile is
# kept aside, and the next pass of lock_settle_gone judges it as a record (§2.7). LREO_RESULT: none |
# young | removed | kept (LREO_ASIDE) | unknown (noted).
lock_reclaim_empty_owner() { # <lock-path>
  LREO_RESULT=none
  LREO_ASIDE=""
  lreo_st=$(lock_obs_stat lock-owner "$1/owner")
  case "$lreo_st" in
    unknown:*) lock_note_unknown lock-owner "$1/owner" "${lreo_st#unknown:}"; LREO_RESULT=unknown; return 0;;
    'file 0 '*) ;;
    *) return 0;;
  esac
  if [ $(( $(lock_now_ms) - ${lreo_st##* } )) -le "$LOCK_EMPTY_OWNER_GRACE_MS" ]; then LREO_RESULT=young; return 0; fi
  LOCK_GONE_SERIAL=$(( LOCK_GONE_SERIAL + 1 ))
  lreo_aside="$1.gone-${LOCK_TOKEN:-$$}-$LOCK_GONE_SERIAL"
  lreo_mv=$(lock_obs_mv empty-owner-move "$1" "$lreo_aside")
  case "$lreo_mv" in
    moved) ;;
    absent) return 0;;
    *) lock_note_unknown empty-owner-move "$1" "${lreo_mv#unknown:}"; LREO_RESULT=unknown; return 0;;
  esac
  lock_test_pause empty-owner-moved
  lreo_st=$(lock_obs_stat reclaim-owner "$lreo_aside/owner")
  case "$lreo_st" in
    'file 0 '*)
      if [ $(( $(lock_now_ms) - ${lreo_st##* } )) -gt "$LOCK_EMPTY_OWNER_GRACE_MS" ]; then
        rm -rf "$lreo_aside" 2>/dev/null || true
        echo "verify-run: machine-lock-empty-owner-removed $1 (an owner of 0 bytes, older than ${LOCK_EMPTY_OWNER_GRACE_MS} ms)" >&2
        LREO_RESULT=removed
        return 0
      fi;;
  esac
  echo "verify-run: machine-lock-empty-owner-kept $1: kept $lreo_aside (no longer an old empty owner: judged as a record next)" >&2
  LREO_RESULT=kept
  LREO_ASIDE=$lreo_aside
}

# I4: an unparsable owner is never removed by anyone; it is named (once).
lock_note_corrupt() { # <lock-path>
  lock_warn_once "machine-lock-owner-corrupt $1/owner unparsable (nobody removes it: look at it and remove the <lock> by hand)"
}

# A holder D7 cannot judge (scripts/lib/machine-lock.sh, #4288 PR1a-f F38): a record without started_at=
# whose lstart string differs from the process under its pid — another time zone or a reused pid cannot
# be told, so the lock is kept until that pid ends. Named once, with what to do by hand. Reads LOB_PID.
lock_note_mismatch() { # <lock-path> <state>
  [ "$2" = unknown:lstart:EMISMATCH ] || return 0
  lock_warn_once "machine-lock-holder-unknown $1 pid=$LOB_PID lstart:EMISMATCH (no started_at= in the record and another lstart under its pid: a time zone or a reused pid cannot be told, so the lock is kept until pid $LOB_PID ends. By hand: if the command of pid $LOB_PID is not the holder the record names, the record is an older one: remove $1 by hand)"
}

# I9 (#4288 PR1a-f): a record without the writer's version (an older copy's) is named once per process
# and lock — the observation that ends the mixed period (design §6.1 (b)). Reads LOB_V / LOB_PID.
lock_note_legacy() { # <lock-path>
  [ -n "$LOB_V" ] || lock_warn_once "machine-lock-legacy-writer $1 pid=$LOB_PID"
}

# I1-c (#4288 PR1a-f): the first key of LOCK_OWNER_EXTRA the section writes itself (pid host token
# started_at pgid v), or a second lstart= line — printed; return 1 when there is none. lstart= once is
# the caller's (supervisor.lock gives D7 its start; the section never writes it).
lock_owner_extra_reserved() {
  [ -n "$LOCK_OWNER_EXTRA" ] || return 1
  lor_lstart=0
  while IFS= read -r lor_line; do
    case "$lor_line" in
      pid=*|host=*|token=*|started_at=*|pgid=*|v=*) echo "${lor_line%%=*}"; return 0;;
      lstart=*)
        lor_lstart=$(( lor_lstart + 1 ))
        if [ "$lor_lstart" -gt 1 ]; then echo lstart; return 0; fi;;
    esac
  done <<LOR_EOF
$LOCK_OWNER_EXTRA
LOR_EOF
  return 1
}

# lock_acquire <name> <budget-seconds>
# Sets LOCK_PATH / LOCK_TOKEN / LOCK_WAITED / LOCK_HELD_BY.
# Returns 0 when the lock is held by this process, 1 when the budget ran out.
lock_acquire() {
  lock_acquire_path "$LOCK_ROOT/$1.lock" "$LOCK_ROOT/$1.queue" "$2"
}

# The same over a lock named by its path (#4288 PR1a D2: run-lock's directory is a full path, and
# need not end in `.lock`). The queue of tickets is the caller's (`${lock%.lock}.queue` by the
# convention of scripts/lib/machine-lock.sh), the moved-aside records are `<lock>.gone-*` beside it.
lock_acquire_path() { # <lock-path> <queue-dir> <budget-seconds>
  la_budget=$3
  LOCK_PATH=$1
  la_queue=$2
  LOCK_WAITED=0
  LOCK_HELD_BY=""
  # I1-b / I1-c (#4288 PR1a-f): refused before the ticket and the mkdir — nothing is made. The first
  # acquisition records this shell's own pid only (another pid is recorded by the hand-off, D4), and the
  # caller's lines never carry a key the section writes (F56, F68).
  LOCK_UNKNOWN=""
  lock_test_obs_fault owner-pid "$1"
  if [ -n "$LTF_CODE" ] || { [ -n "$LOCK_OWNER_PID" ] && [ "$LOCK_OWNER_PID" != "$$" ]; }; then
    echo "verify-run: machine-lock-owner-pid-not-self $1 pid=$LOCK_OWNER_PID" >&2
    lock_note_unknown owner-pid "$1" "${LTF_CODE:-EINVAL}"
    echo "verify-run: machine-lock-unknown $LOCK_UNKNOWN (not taken: unknown is never read as free)" >&2
    return 1
  fi
  lock_test_obs_fault owner-fields "$1"
  la_key=$(lock_owner_extra_reserved) || la_key=""
  if [ -n "$LTF_CODE" ] || [ -n "$la_key" ]; then
    echo "verify-run: machine-lock-owner-field-reserved $1 key=$la_key" >&2
    lock_note_unknown owner-fields "$1" "${LTF_CODE:-EINVAL}"
    echo "verify-run: machine-lock-unknown $LOCK_UNKNOWN (not taken: unknown is never read as free)" >&2
    return 1
  fi
  if [ -n "$LOCK_WANT_TOKEN" ]; then
    LOCK_TOKEN=$LOCK_WANT_TOKEN
  else
    LOCK_TOKEN="$$-$(date +%s)-${RANDOM}${RANDOM}"
  fi
  LOCK_WAITED=0
  LOCK_HELD_BY=""
  LOCK_TICKET=""
  mkdir -p "${LOCK_PATH%/*}" 2>/dev/null || true
  la_start=$(date +%s)
  la_start_ms=$(lock_now_ms)
  la_deadline=$(( la_start_ms + la_budget * 1000 ))
  la_tmp="$la_queue/.t-$LOCK_TOKEN"
  la_broken=""
  la_emptied=0
  while :; do
    LOCK_UNKNOWN=""
    LOCK_GONE_PENDING=""
    la_seen_pid=""
    la_seen_host=""
    if [ -n "$LOCK_TICKET" ]; then
      if [ "$(lock_json_field "$LOCK_TICKET" token)" != "$LOCK_TOKEN" ] || [ "$(lock_json_field "$LOCK_TICKET" done)" = "true" ]; then
        echo "verify-run: machine-lock-ticket-lost $LOCK_TICKET: taking a new ticket at the end of the queue" >&2
        LOCK_TICKET=""
      fi
    fi
    if [ -z "$LOCK_TICKET" ]; then
      mkdir -p "$la_queue" 2>/dev/null || true
      printf '{"pid":%s,"host":"%s","token":"%s","createdAt":%s,"deadline":%s}\n' \
        "$$" "$LOCK_HOST" "$LOCK_TOKEN" "$la_start_ms" "$la_deadline" > "$la_tmp" 2>/dev/null
      if ! lock_take_ticket "$la_queue" "$la_tmp"; then
        rm -f "$la_tmp" 2>/dev/null
        echo "verify-run: cannot publish a ticket in $la_queue (ln failed), so the lock $LOCK_PATH was not tried" >&2
        LOCK_WAITED=$(( $(date +%s) - la_start ))
        return 1
      fi
      rm -f "$la_tmp" 2>/dev/null
    fi
    la_blocker=""
    if [ -n "$LOCK_TICKET" ]; then
      la_mine=${LOCK_TICKET##*/}
      la_now=$(lock_now_ms)
      # A queue that cannot be listed is not an empty queue: nobody is known to be ahead, but
      # nobody is known not to be either.
      lock_obs_list list-queue "$la_queue"
      if [ "$LOL_STATE" != unknown ]; then
        la_names=$(printf '%s\n' "$LOL_NAMES" | grep -E '^[0-9]{12}$' | sort)
        for la_entry in $la_names; do
          [ "$la_entry" \< "$la_mine" ] || break
          [ "$(lock_json_field "$la_queue/$la_entry" done)" = "true" ] && continue
          if la_why=$(lock_ticket_retirable "$la_queue/$la_entry" "$la_now"); then
            if lock_mark_done "$la_queue/$la_entry" "$(lock_json_field "$la_queue/$la_entry" token)"; then
              echo "verify-run: machine-lock-ticket-retired $la_queue/$la_entry ($la_why)" >&2
            fi
            continue
          fi
          la_blocker="$la_queue/$la_entry"
          break
        done
      else
        lock_note_unknown list-queue "$la_queue" "$LOL_CODE"
      fi
      if [ -z "$la_blocker" ] && [ -z "$LOCK_UNKNOWN" ] && lock_settle_gone "$LOCK_PATH"; then
        # An owner-less, empty <lock> older than the caller's grace is the head's to take out first (D3).
        if lock_expire_ownerless "$LOCK_PATH"; then la_made=$(lock_obs_mkdir mkdir-lock "$LOCK_PATH"); else la_made=not-tried; fi
        case "$la_made" in
          created)
            LOCK_ACQUIRED_AT=$(lock_now_ms)
            lock_test_pause owner-lock-made
            # The owner is published whole (#4288 PR1a D3, PR1a-f I1, lock_obs_create): written into
            # <lock>/.owner-<token> and linked to <lock>/owner — a name that is there is never written
            # over, and only the record read back as this acquisition's is a lock taken. What a failure
            # removes is only this acquisition's own (design §3): lock_obs_create removes its tmp (and an
            # owner it published and showed to be its own); the <lock> this mkdir made is taken out with
            # rmdir, which removes it only when empty — never after the link answered ENOENT or an owner
            # not shown to be ours was linked back (PM review P3-2; F11, F14). Test seams:
            # CM_VERIFY_TEST_HANDOFF=fault:owner (the write fails), fault:owner-write, fault:owner-unlink,
            # fault:lock-rmdir, the pauses of §2.6; CM_VERIFY_TEST_OBS_FAULT owner-create … owner-undo-link.
            if ! lock_test_fault owner && printf '%s\n' "$(lock_format_owner "$$" "$LOCK_TOKEN" "$LOCK_ACQUIRED_AT")" |
              lock_obs_create owner-create "$LOCK_PATH/owner" "$LOCK_TOKEN"; then
              LOCK_HELD_PATH=$LOCK_PATH
              LOCK_HELD_TOKEN=$LOCK_TOKEN
              lock_retire_own_ticket
              lock_collect_garbage "$la_queue"
              LOCK_WAITED=$(( $(date +%s) - la_start ))
              return 0
            else
              la_rc=$?
            fi
            la_rmdir=1
            case "$la_rc" in
              3) la_rmdir=0; echo "verify-run: machine-lock-owner-exists $LOCK_PATH (not acquired; nothing removed)" >&2;;
              6) la_rmdir=0; echo "verify-run: machine-lock-owner-not-ours $LOCK_PATH (another record read back; not acquired, nothing removed)" >&2;;
              1) la_what=owner-write-failed;;
              99) la_rmdir=0; la_what=owner-publish-failed; lock_note_unknown owner-publish "$LOCK_PATH/owner" ENOENT;;
              *)
                if [ "$la_rc" -ge 10 ] && [ "$la_rc" -lt 40 ]; then
                  la_what=owner-create-failed
                  lock_note_unknown owner-create "$LOCK_PATH/owner" "$(lock_errno_at $(( la_rc - 10 )))"
                elif [ "$la_rc" -ge 40 ] && [ "$la_rc" -lt 70 ]; then
                  la_what=owner-write-failed
                  lock_note_unknown owner-write "$LOCK_PATH/owner" "$(lock_errno_at $(( la_rc - 40 )))"
                elif [ "$la_rc" -ge 70 ] && [ "$la_rc" -lt 85 ]; then
                  la_what=owner-readback-unknown
                  lock_note_unknown owner-readback "$LOCK_PATH/owner" "$(lock_errno_at $(( la_rc - 70 )))"
                elif [ "$la_rc" -ge 85 ] && [ "$la_rc" -lt 99 ]; then
                  la_what=owner-publish-failed
                  lock_note_unknown owner-publish "$LOCK_PATH/owner" "$(lock_errno_at $(( la_rc - 85 )))"
                else
                  la_rmdir=0
                  la_what=owner-readback-unknown
                  lock_note_unknown owner-readback "$LOCK_PATH/owner" "$(lock_errno_at $(( la_rc - 100 )))"
                fi;;
            esac
            if [ "$la_rmdir" = 1 ]; then
              la_err=EUNKNOWN
              if ! lock_test_fault lock-rmdir; then la_err=$(lock_rmdir_errno lock-rmdir "$LOCK_PATH"); fi
              if [ -z "$la_err" ]; then
                echo "verify-run: machine-lock-$la_what $LOCK_PATH (taken out again; not acquired)" >&2
              else
                echo "verify-run: machine-lock-$la_what $LOCK_PATH (and it could not be taken out again)" >&2
              fi
            elif [ "$la_rc" != 3 ] && [ "$la_rc" != 6 ]; then
              echo "verify-run: machine-lock-$la_what $LOCK_PATH (not acquired; the <lock> is not shown to be ours: nothing else removed)" >&2
            fi;;
          not-tried) ;;
          exists)
            lock_obs_owner lock-owner "$LOCK_PATH"
            if [ "$LOB_CLASS" = unknown ]; then lock_note_unknown lock-owner "$LOCK_PATH/owner" "$LOB_CODE"; fi
            if [ "$LOB_CLASS" = corrupt ] && [ -z "$LOB_EMPTY" ]; then lock_note_corrupt "$LOCK_PATH"; fi
            if [ "$LOB_CLASS" = corrupt ] && [ -n "$LOB_EMPTY" ]; then
              # I4: an owner of 0 bytes past the fixed grace is the head's to take out; the mkdir follows
              # in the same poll (a few times at most).
              lock_reclaim_empty_owner "$LOCK_PATH"
              case "$LREO_RESULT" in
                removed) if [ "$la_emptied" -lt 3 ]; then la_emptied=$(( la_emptied + 1 )); continue; fi;;
                kept) LOCK_GONE_PENDING=$LREO_ASIDE;;
              esac
            fi
            if [ "$LOB_CLASS" = record ]; then
              lock_note_legacy "$LOCK_PATH"
              la_seen_pid=$LOB_PID
              la_seen_host=$LOB_HOST
            fi
            la_token=$LOB_TOKEN
            la_pid=$LOB_PID
            # A stale record is broken at most once per token, so a directory nobody can
            # remove degrades into ordinary waiting instead of a spin loop.
            if [ "$LOB_CLASS" = record ] && [ "$la_token" != "$la_broken" ]; then
              la_state=$(lock_record_state)
              case "$la_state" in
                gone)
                  la_broken=$la_token
                  lock_recover "$LOCK_PATH" "$la_token" "$la_pid"
                  continue;;
                unknown:*)
                  lock_note_mismatch "$LOCK_PATH" "$la_state"
                  la_u=${la_state#unknown:}
                  lock_note_unknown "${la_u%%:*}" "$LOCK_PATH" "${la_u#*:}";;
              esac
            fi;;
          *) lock_note_unknown mkdir-lock "$LOCK_PATH" "${la_made#unknown:}";;
        esac
      fi
    else
      # No ticket this poll: say so when it was the queue's listing that failed.
      lock_obs_list list-queue "$la_queue"
      if [ "$LOL_STATE" = unknown ]; then lock_note_unknown list-queue "$la_queue" "$LOL_CODE"; fi
    fi
    la_token=$(lock_owner_field "$LOCK_PATH" token)
    if [ -n "$la_token" ]; then
      LOCK_HELD_BY="pid $(lock_owner_field "$LOCK_PATH" pid) on $(lock_owner_field "$LOCK_PATH" host)"
      # The gate's group (#4288): with the runner killed, the pid is dead and the group is what holds.
      la_held_pgid=$(lock_owner_field "$LOCK_PATH" pgid)
      if [ -n "$la_held_pgid" ]; then LOCK_HELD_BY="$LOCK_HELD_BY (pgid $la_held_pgid)"; fi
    elif [ -n "$la_seen_pid" ]; then
      # A record in another format (scripts/lib/machine-lock.sh's key=value), from this poll's one read.
      LOCK_HELD_BY="pid $la_seen_pid on $la_seen_host"
    elif [ -n "$la_blocker" ]; then
      if [ -n "$(lock_json_field "$la_blocker" token)" ]; then
        LOCK_HELD_BY="queue ticket $la_blocker (pid $(lock_json_field "$la_blocker" pid) on $(lock_json_field "$la_blocker" host))"
      else
        LOCK_HELD_BY="queue ticket $la_blocker (unreadable)"
      fi
    elif [ -n "$LOCK_GONE_PENDING" ]; then
      LOCK_HELD_BY="restore pending: $LOCK_GONE_PENDING"
    elif [ -n "$LOCK_UNKNOWN" ]; then
      LOCK_HELD_BY="unknown $LOCK_UNKNOWN"
    fi
    if [ "$(lock_now_ms)" -ge "$la_deadline" ]; then
      lock_retire_own_ticket
      if [ -n "$LOCK_UNKNOWN" ]; then
        echo "verify-run: machine-lock-unknown $LOCK_UNKNOWN (not taken: unknown is never read as free)" >&2
      fi
      LOCK_WAITED=$(( $(date +%s) - la_start ))
      return 1
    fi
    sleep "$LOCK_POLL_SEC" 2>/dev/null || sleep 1
  done
}

lock_forget_held() { # <lock-path> <token>
  if [ "$1" = "$LOCK_HELD_PATH" ] && { [ "$2" = "$LOCK_HELD_TOKEN" ] || [ "$2" = "$LOCK_PENDING_TOKEN" ]; }; then
    LOCK_HELD_PATH=""
    LOCK_HELD_TOKEN=""
  fi
}

# Release only while this acquisition still owns the directory. Without the token
# check, a holder whose lock was broken as stale would delete the NEXT holder's
# directory and hand the resource to two runs at once. An owner that cannot be
# read is not known to be ours, and an owner whose process group still has a
# member (EPERM included — only ESRCH says it is empty) is not released: the
# gate in it may still be writing (#4288 §2.5). Returns 1 when the lock is kept.
lock_release() { # <lock-path> <token>
  lock_obs_owner release-owner "$1"
  case "$LOB_CLASS" in
    unknown)
      echo "verify-run: machine-lock-release-deferred $1 point=release-owner errno=$LOB_CODE" >&2
      return 1;;
    missing|corrupt)
      # The lock was moved aside (or never had an owner): this run's own records are cleaned. The
      # <lock> is NOT removed (#4288 PR1a-f §3.1, as lock_release_held): an owner-less <lock> is not
      # shown to be ours (an older head's move-aside, a put-back half way, another taker's K1); the
      # clean-up (I3) and the take-back-half deal with one left empty. Nor is one whose owner cannot be
      # parsed or is of 0 bytes (corrupt, I4: nobody removes an owner it cannot read by its name; an
      # empty one past its grace is the head's, through lock_reclaim_empty_owner).
      lock_release_own_gone "$1" "$2"
      lock_forget_held "$1" "$2"
      return 0;;
  esac
  if [ -n "$LOB_TOKEN" ] && [ "$LOB_TOKEN" != "$2" ]; then
    lock_release_own_gone "$1" "$2"
    lock_forget_held "$1" "$2"
    return 0
  fi
  if ! lock_group_is_empty "$LOB_PGID"; then
    echo "verify-run: machine-lock-release-deferred $1 pgid=$LOB_PGID" >&2
    return 1
  fi
  rm -rf "$1" 2>/dev/null || true
  lock_forget_held "$1" "$2"
  return 0
}

# Empty a gate's process group: TERM (unless sent already), KILL_GRACE_SEC, KILL, 1 s. 0 when it is
# empty (ESRCH), 1 when it is not or cannot be shown to be (EPERM: a member of another user).
# LDG_SIGNALLED=1 when there was anyone left to signal.
lock_drain_group() { # <pgid> <term-sent 0|1>
  LDG_SIGNALLED=0
  if lock_test_fault drain; then return 1; fi
  lock_group_is_empty "$1" && return 0
  LDG_SIGNALLED=1
  [ "$2" = 1 ] || kill -s TERM -- "-$1" 2>/dev/null
  ldg_end=$(( $(date +%s) + KILL_GRACE_SEC ))
  while [ "$(date +%s)" -lt "$ldg_end" ]; do
    lock_group_is_empty "$1" && return 0
    sleep 0.05 2>/dev/null || sleep 1
  done
  kill -s KILL -- "-$1" 2>/dev/null
  ldg_end=$(( $(date +%s) + 2 ))
  while [ "$(date +%s)" -lt "$ldg_end" ]; do
    lock_group_is_empty "$1" && return 0
    sleep 0.05 2>/dev/null || sleep 1
  done
  lock_group_is_empty "$1"
}

# Stop a gate whose leader this shell has not waited for yet (the EXIT trap): TERM the group, wait
# the leader with a KILL after KILL_GRACE_SEC behind it (a leader never waited stays a zombie, and
# a zombie keeps its group non-empty), then drain what is left.
lock_stop_gate() { # <pgid> <leader-pid or empty>
  lsg_term=0
  if [ -n "$2" ]; then
    kill -s TERM -- "-$1" 2>/dev/null
    ( sleep "$KILL_GRACE_SEC"; kill -s KILL -- "-$1" 2>/dev/null ) >/dev/null 2>&1 &
    lsg_killer=$!
    wait "$2" 2>/dev/null
    kill -s KILL "$lsg_killer" 2>/dev/null
    wait "$lsg_killer" 2>/dev/null
    lsg_term=1
  fi
  lock_drain_group "$1" "$lsg_term"
}

lock_note_undrained() { # <lock-path> <token> <pgid>
  LOCK_UNDRAINED="$LOCK_UNDRAINED$1$LOCK_TAB$2$LOCK_TAB$3
"
  echo "verify-run: machine-lock-release-deferred $1 pgid=$3 (the gate's group did not empty; the lock is kept)" >&2
}

# Drain the groups this run could not empty again (only <lock-path>'s when given) and release the
# locks whose group is empty now; the rest stay in LOCK_UNDRAINED.
lock_process_undrained() { # [<lock-path>]
  [ -n "$LOCK_UNDRAINED" ] || return 0
  lpu_keep=""
  while IFS="$LOCK_TAB" read -r lpu_p lpu_t lpu_g; do
    [ -n "$lpu_p" ] || continue
    if [ -z "${1:-}" ] || [ "$lpu_p" = "$1" ]; then
      if lock_drain_group "$lpu_g" 1 && lock_release "$lpu_p" "$lpu_t"; then continue; fi
    fi
    lpu_keep="$lpu_keep$lpu_p$LOCK_TAB$lpu_t$LOCK_TAB$lpu_g
"
  done <<LPU_EOF
$LOCK_UNDRAINED
LPU_EOF
  LOCK_UNDRAINED=$lpu_keep
}

# Called from the EXIT trap of the top-level shell (cleanup_workdir): a run
# stopped while it waited hands its ticket back, and one stopped while it held
# releases the lock — after its gate's group is empty (#4288 §2.6), and only when
# the owner on record is this run's (the token it acquired with, or the one it was
# publishing). `kill -9` leaves both for the next waiter to recover, which it does
# only once the recorded pid and group are gone.
lock_cleanup_on_exit() {
  lock_retire_own_ticket
  if [ -n "$LOCK_GATE_GROUP" ]; then
    if lock_stop_gate "$LOCK_GATE_GROUP" "$LOCK_GATE_LEADER"; then
      if [ -n "$LOCK_GATE_WATCHDOG" ]; then kill -s KILL "$LOCK_GATE_WATCHDOG" 2>/dev/null; fi
    else
      lock_note_undrained "$LOCK_HELD_PATH" "${LOCK_PENDING_TOKEN:-$LOCK_HELD_TOKEN}" "$LOCK_GATE_GROUP"
    fi
    LOCK_GATE_GROUP=""
    LOCK_GATE_LEADER=""
  fi
  lock_process_undrained
  # A lock whose group could not be emptied stays, whatever its token says: the undrained record
  # and the group check in lock_release each keep it on their own (§2.5).
  case "$LOCK_UNDRAINED" in *"$LOCK_HELD_PATH$LOCK_TAB"*) LOCK_HELD_PATH="";; esac
  if [ -n "$LOCK_HELD_PATH" ]; then
    lock_obs_owner release-owner "$LOCK_HELD_PATH"
    if [ "$LOB_CLASS" = record ] && [ "$LOB_TOKEN" = "$LOCK_HELD_TOKEN" ]; then
      lock_release "$LOCK_HELD_PATH" "$LOCK_HELD_TOKEN"
    elif [ "$LOB_CLASS" = record ] && [ -n "$LOCK_PENDING_TOKEN" ] && [ "$LOB_TOKEN" = "$LOCK_PENDING_TOKEN" ]; then
      lock_release "$LOCK_HELD_PATH" "$LOCK_PENDING_TOKEN"
    elif [ "$LOB_CLASS" = missing ]; then
      lock_release_own_gone "$LOCK_HELD_PATH" "$LOCK_HELD_TOKEN"
      if [ -n "$LOCK_PENDING_TOKEN" ]; then lock_release_own_gone "$LOCK_HELD_PATH" "$LOCK_PENDING_TOKEN"; fi
    fi
  fi
  LOCK_PENDING_TOKEN=""
}

# --- operations for the callers that load this section (#4288 PR1a) -------------------------------
# scripts/lib/machine-lock.sh loads this section for run-lock and supervisor.lock
# (docs/design/lock-reservation-rest-4288.md §1.6–§1.8). verify-run.sh's own gates use none of the
# functions below except lock_child_wait (through lock_handoff_wait) and lock_hand_off (through
# lock_publish_group).

# Take a ticket in <queue-dir> and wait to be the head of the queue (the smallest live ticket), with
# the same ticket rules as lock_acquire_path (#4277: never by age alone). 0 = the head (LOCK_TICKET is
# this shell's ticket; the caller retires it), 1 = not the head within <budget-seconds> (the ticket is
# retired). LWH_BLOCKER names the ticket ahead. The ticket is LOCK_TOKEN's.
lock_wait_head() { # <queue-dir> <budget-seconds>
  lwh_queue=$1
  lwh_start_ms=$(lock_now_ms)
  lwh_deadline=$(( lwh_start_ms + $2 * 1000 ))
  lwh_tmp="$lwh_queue/.t-$LOCK_TOKEN"
  LOCK_TICKET=""
  while :; do
    LOCK_UNKNOWN=""
    LWH_BLOCKER=""
    if [ -n "$LOCK_TICKET" ]; then
      if [ "$(lock_json_field "$LOCK_TICKET" token)" != "$LOCK_TOKEN" ] || [ "$(lock_json_field "$LOCK_TICKET" done)" = "true" ]; then
        echo "verify-run: machine-lock-ticket-lost $LOCK_TICKET: taking a new ticket at the end of the queue" >&2
        LOCK_TICKET=""
      fi
    fi
    if [ -z "$LOCK_TICKET" ]; then
      mkdir -p "$lwh_queue" 2>/dev/null || true
      printf '{"pid":%s,"host":"%s","token":"%s","createdAt":%s,"deadline":%s}\n' \
        "$$" "$LOCK_HOST" "$LOCK_TOKEN" "$lwh_start_ms" "$lwh_deadline" > "$lwh_tmp" 2>/dev/null
      if ! lock_take_ticket "$lwh_queue" "$lwh_tmp"; then
        rm -f "$lwh_tmp" 2>/dev/null
        echo "verify-run: cannot publish a ticket in $lwh_queue (ln failed)" >&2
        return 1
      fi
      rm -f "$lwh_tmp" 2>/dev/null
    fi
    if [ -n "$LOCK_TICKET" ]; then
      lwh_mine=${LOCK_TICKET##*/}
      lwh_now=$(lock_now_ms)
      lock_obs_list list-queue "$lwh_queue"
      if [ "$LOL_STATE" != unknown ]; then
        lwh_names=$(printf '%s\n' "$LOL_NAMES" | grep -E '^[0-9]{12}$' | sort)
        for lwh_entry in $lwh_names; do
          [ "$lwh_entry" \< "$lwh_mine" ] || break
          [ "$(lock_json_field "$lwh_queue/$lwh_entry" done)" = "true" ] && continue
          if lwh_why=$(lock_ticket_retirable "$lwh_queue/$lwh_entry" "$lwh_now"); then
            if lock_mark_done "$lwh_queue/$lwh_entry" "$(lock_json_field "$lwh_queue/$lwh_entry" token)"; then
              echo "verify-run: machine-lock-ticket-retired $lwh_queue/$lwh_entry ($lwh_why)" >&2
            fi
            continue
          fi
          LWH_BLOCKER="$lwh_queue/$lwh_entry"
          break
        done
        [ -n "$LWH_BLOCKER" ] || return 0
      else
        lock_note_unknown list-queue "$lwh_queue" "$LOL_CODE"
      fi
    fi
    if [ "$(lock_now_ms)" -ge "$lwh_deadline" ]; then
      lock_retire_own_ticket
      return 1
    fi
    sleep "$LOCK_POLL_SEC" 2>/dev/null || sleep 1
  done
}

# D4 (#4288 PR1a): hand the lock over, within the same acquisition, to <pid> and its process group
# <pgid> — a NEW token T1=<T0>-g<pgid> (the naming of the gate's publish, §2.2 of #4288's 1st item: a
# waiter that judged the record without the group never deletes the one with it). Only the live
# holder calls it, before the process it protects starts (the D9 form: the child waits for a signal).
# LOCK_PENDING_TOKEN is set to T1 first, so a trap that comes between the mv and the signal knows the
# record is this run's. LHO_STAGE is empty on success (the owner on record is T1 with <pid> and
# <pgid>), else the stage that failed (token: the record is not T0's, missing or unreadable — nothing
# written | tmp | mv | verify); LHO_TOKEN is T1.
lock_hand_off() { # <lock-path> <T0> <pid> <pgid>
  LHO_STAGE=""
  LHO_TOKEN="$2-g$4"
  # I1-c / I5 (#4288 PR1a-f): the caller's lines never carry a key the section writes (fields), and
  # never an lstart= — the pid becomes a child started later, and D7 would read its start against
  # another process's lstart (lstart). Nothing is written.
  lho_key=$(lock_owner_extra_reserved) || lho_key=""
  if [ -n "$lho_key" ]; then
    echo "verify-run: machine-lock-owner-field-reserved $1 key=$lho_key" >&2
    LHO_STAGE=fields
    return 0
  fi
  case "
$LOCK_OWNER_EXTRA" in *"
lstart="*) LHO_STAGE=lstart; return 0;; esac
  LOCK_PENDING_TOKEN=$LHO_TOKEN
  lock_obs_owner handoff-token "$1"
  if [ "$LOB_CLASS" != record ] || [ "$LOB_TOKEN" != "$2" ]; then LHO_STAGE=token; return 0; fi
  lho_tmp="$1/.owner-$LHO_TOKEN"
  if lock_test_fault tmp || ! printf '%s\n' "$(lock_format_owner "$3" "$LHO_TOKEN" "$LOCK_ACQUIRED_AT" "$4")" > "$lho_tmp" 2>/dev/null; then
    rm -f "$lho_tmp" 2>/dev/null
    LHO_STAGE=tmp
    return 0
  fi
  lock_test_pause tmp
  if [ "$(lock_obs_mv handoff-publish "$lho_tmp" "$1/owner")" != moved ]; then
    rm -f "$lho_tmp" 2>/dev/null
    LHO_STAGE='mv'
    return 0
  fi
  lock_obs_owner handoff-verify "$1"
  if [ "$LOB_CLASS" != record ] || [ "$LOB_TOKEN" != "$LHO_TOKEN" ] || [ "$LOB_PGID" != "$4" ]; then LHO_STAGE=verify; fi
}

# D5 (#4288 PR1a): the release by someone who is not the holder (UAT's `down`, and the failure trap
# after a handover: the holder — the server — was stopped first). Between reading the token and the
# rm, a head could recover the dead holder's lock and take it; so this takes a ticket and releases
# only as the head, when nobody of this implementation mkdirs, recovers or rmdirs. As the head: one
# read of the owner; a record under one of <token>… whose holder (pid, and the group when it names
# one) is gone is removed; a holder still there or unknown is left (`release-deferred`: never under a
# group that did not empty); a missing owner cleans only this caller's own moved-aside records;
# another token, a corrupt record or an unreadable owner is left. The ticket is done on every path.
# Not the head within <budget-seconds>: nothing is done (the holder is dead; the next head recovers).
# LRAH_RESULT: released | missing | deferred | kept | unknown | not-head. 0 for released / missing.
lock_release_as_head() { # <lock-path> <queue-dir> <budget-seconds> <token>…
  lrah_lock=$1
  lrah_queue=$2
  lrah_budget=$3
  shift 3
  LRAH_RESULT=""
  lrah_saved=$LOCK_TOKEN
  LOCK_TOKEN="$$-$(date +%s)-${RANDOM}${RANDOM}"
  if ! lock_wait_head "$lrah_queue" "$lrah_budget"; then
    LRAH_RESULT=not-head
    echo "verify-run: machine-lock-release-skipped $lrah_lock (not the head of $lrah_queue within ${lrah_budget}s; the next head recovers it)" >&2
    LOCK_TOKEN=$lrah_saved
    return 1
  fi
  lock_test_pause release-head-read
  lock_obs_owner release-owner "$lrah_lock"
  case "$LOB_CLASS" in
    unknown)
      LRAH_RESULT=unknown
      echo "verify-run: machine-lock-release-deferred $lrah_lock point=release-owner errno=$LOB_CODE" >&2;;
    missing)
      LRAH_RESULT=missing
      for lrah_t in "$@"; do lock_release_own_gone "$lrah_lock" "$lrah_t"; done;;
    corrupt) LRAH_RESULT=kept;;
    record)
      LRAH_RESULT=kept
      for lrah_t in "$@"; do
        [ "$LOB_TOKEN" = "$lrah_t" ] || continue
        lrah_state=$(lock_record_state)
        case "$lrah_state" in
          gone)
            # Not by its name (#4288 PR1a-f §3.1, F62): moved to this caller's own name and the token
            # checked — a successor that took the lock while this stopped past its ticket is put back.
            lock_test_pause release-head-judged
            lock_recover "$lrah_lock" "$LOB_TOKEN" "$LOB_PID"
            if [ "$LRC_RESULT" = recovered ]; then LRAH_RESULT=released; else LRAH_RESULT=kept; fi;;
          *)
            LRAH_RESULT=deferred
            echo "verify-run: machine-lock-release-deferred $lrah_lock (holder pid $LOB_PID${LOB_PGID:+ pgid $LOB_PGID} is $lrah_state)" >&2;;
        esac
        break
      done
      if [ "$LRAH_RESULT" = released ]; then
        for lrah_t in "$@"; do lock_release_own_gone "$lrah_lock" "$lrah_t"; done
      fi;;
  esac
  lock_retire_own_ticket
  LOCK_TOKEN=$lrah_saved
  case "$LRAH_RESULT" in released|missing) return 0;; esac
  return 1
}

# D6 (#4288 PR1a): recover a dead holder's lock without taking it (supervisor.lock's deadline guard).
# As the head: settle the moved-aside records (§2.7), read the owner once, and recover the lock when
# its holder is gone (moved aside, its token checked, put back when it differs: lock_recover); an
# owner-less, empty <lock> older than LOCK_OWNERLESS_GRACE_MS is taken out. Never a mkdir of the lock.
# The ticket is done on every path. LRO_RESULT: removed | kept (alive, unknown, corrupt, young) |
# restore-failed (the moved-aside record is kept and goes on holding) | absent | not-head; LRO_UNKNOWN
# names an unknown (point=… path=… errno=…). The caller's exit code does not depend on it.
lock_recover_only() { # <lock-path> <queue-dir> <budget-seconds>
  LRO_RESULT=""
  LRO_UNKNOWN=""
  lro_saved=$LOCK_TOKEN
  LOCK_TOKEN="$$-$(date +%s)-${RANDOM}${RANDOM}"
  if ! lock_wait_head "$2" "$3"; then
    LRO_RESULT=not-head
    LRO_UNKNOWN=$LOCK_UNKNOWN
    LOCK_TOKEN=$lro_saved
    return 0
  fi
  LOCK_UNKNOWN=""
  lro_held=0
  lock_settle_gone "$1" || lro_held=1
  lock_obs_owner lock-owner "$1"
  case "$LOB_CLASS" in
    unknown) LRO_RESULT=kept; lock_note_unknown lock-owner "$1/owner" "$LOB_CODE";;
    corrupt)
      LRO_RESULT=kept
      if [ -n "$LOB_EMPTY" ]; then
        # I4: an owner of 0 bytes past the fixed grace.
        lock_reclaim_empty_owner "$1"
        if [ "$LREO_RESULT" = removed ]; then LRO_RESULT=removed; fi
      else
        lock_note_corrupt "$1"
      fi;;
    missing)
      LRO_RESULT=kept
      case "$(lock_ownerless_empty "$1")" in
        absent) LRO_RESULT=absent;;
        *)
          # A moved-aside record that holds (alive or unknown) keeps the owner-less <lock>: the
          # put-back is its (§2.7), not the clean-up's.
          if [ "$lro_held" = 0 ] && lock_expire_ownerless "$1" && [ "$LEO_RESULT" = removed ]; then LRO_RESULT=removed; fi;;
      esac;;
    record)
      lock_note_legacy "$1"
      lro_state=$(lock_record_state)
      case "$lro_state" in
        gone)
          lock_test_pause recover-only-judged
          lock_recover "$1" "$LOB_TOKEN" "$LOB_PID"
          case "$LRC_RESULT" in
            recovered) LRO_RESULT=removed;;
            restore-failed) LRO_RESULT=restore-failed;;
            absent) LRO_RESULT=absent;;
            *) LRO_RESULT=kept;;
          esac;;
        unknown:*)
          lock_note_mismatch "$1" "$lro_state"
          lro_u=${lro_state#unknown:}
          lock_note_unknown "${lro_u%%:*}" "$1" "${lro_u#*:}"
          LRO_RESULT=kept;;
        *) LRO_RESULT=kept;;
      esac;;
  esac
  LRO_UNKNOWN=$LOCK_UNKNOWN
  lock_retire_own_ticket
  LOCK_TOKEN=$lro_saved
  return 0
}

# D9 (#4288 PR1a): the child's side of a handover — a process that must not start its work before
# its group is on the owner record. 0 after it saw "$go" and made "$ack"; 1 when it must not run: it
# withdrew (<parent-pid> is not known to be alive, or <deadline> passed — whoever makes "$go" first
# wins), or it could make neither "$go" nor "$ack". The gate's child calls it through
# lock_handoff_wait with this shell's pid; run-lock's children (UAT's server, daily's run) with their
# parent's.
lock_child_wait() { # <go> <ack> <deadline-epoch-s> <parent-pid>
  while :; do
    [ -d "$1" ] && break
    if [ "$(lock_obs_kill0 handoff-self "$4")" != alive ] || [ "$(date +%s)" -ge "$3" ]; then
      [ "$(lock_obs_mkdir handoff-go "$1")" = created ] && return 1
      [ -d "$1" ] && break
      return 1
    fi
    sleep 0.05 2>/dev/null || sleep 1
  done
  [ "$(lock_obs_mkdir handoff-ack "$2")" = created ] || return 1
  lock_test_pause acked
  return 0
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
    # A group this run could not empty under the same lock is drained again first;
    # while it is not empty the lock stays this run's and the wait below runs out
    # (#4288 §2.5) — the gate never runs twice at once.
    lock_process_undrained "$LOCK_ROOT/$rga_mutex.lock"
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

  # A gate that holds the machine-wide lock starts only after its process group is on the
  # owner record (#4288): its child waits for "$rga_go" before the exec (run_gate_handoff).
  rga_go=""
  rga_ack=""
  rga_handoff_deadline=0
  if [ -n "$rga_lock_token" ]; then
    rga_go="$rga_log.go"
    rga_ack="$rga_log.ack"
    rm -rf "$rga_go" "$rga_ack"
    rga_handoff_deadline=$(( $(date +%s) + HANDOFF_WAIT_SEC ))
  fi

  # `set -m` puts the gate in its own process group so the watchdog can kill the
  # whole tree. Without it, `npm run x` dies but the node/sleep children it forked
  # survive the timeout (measured: 2 orphans left behind).
  #
  # CM_WORKTREE_INDEX / CM_WORKTREE_ID are NOT set here (Issue #223): this runner
  # does not number worktrees and must not invent a number, because a number that
  # disagrees with CommandMate's would put the gate on a port the product run has
  # already claimed. Whatever the caller exported is inherited unchanged; a gate
  # carries its own default (`${CM_WORKTREE_INDEX:-0}`).
  #
  # With job control on, bash calls setpgid in the parent AND in the forked
  # child; when the parent's call lands first the child's can fail with EPERM
  # and bash writes `child setpgid (N to N): Operation not permitted` to the
  # stderr the child still has — before the subshell's own redirection takes
  # effect — so the line lands on this script's stderr (Issue #3944; same shape
  # as demo-video/env-up.sh, Issue #3935). The group is still right, so only the
  # message is wrong. The `{ … } 2>>"$rga_log.jobctl"` sends whatever bash
  # writes to stderr while job control is on to a file beside the gate log
  # instead: not into $rga_log, because emit_log_tail's "no output captured"
  # test reads that file's size. The file lives in $WORKDIR and is removed below.
  {
  set -m
  ( if [ -n "${rga_go:-}" ]; then lock_handoff_wait "$rga_go" "$rga_ack" "$rga_handoff_deadline" || exit 125; fi
    cd "$CWD" && exec /bin/sh -c "$rga_cmd" ) > "$rga_log" 2>&1 &
  rga_pid=$!
  set +m
  } 2>>"$rga_log.jobctl"

  if [ -n "$rga_lock_token" ]; then
    run_gate_handoff "$rga_id" "$rga_to" "$rga_log" "$rga_pid"
    rm -f "$rga_mark" "$rga_log.jobctl"
    rm -rf "$rga_go" "$rga_ack"
    return 0
  fi

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
  rm -f "$rga_mark" "$rga_log.jobctl"
}

# --- a gate under the machine-wide lock (#4288) ---------------------------------
# The owner record names this shell's pid, but the gate runs in a process group of its own
# (`set -m`), and a gate can outlive this shell: kill -9 to the runner leaves the gate — and
# the watchdog — running. A waiter that judged the lock by the pid alone took it while the old
# gate still ran (dev-reports/issue/4288/repro-1.md). So before the gate's command starts, the
# group G is published on the owner record under a NEW token (T1 = <T0>-g<G>: a waiter that read
# the record without the group then never deletes the one with it — it moves it aside, sees the
# token differ and puts it back), and the lock is released only once G is empty:
#
#   1. fork the gate's child; it waits for "$log.go" and runs nothing until it sees it
#   2. confirm G with ps; start the watchdog (it counts the timeout from "$log.ack")
#   3. publish {pid, host, token: T1, acquiredAt, pgid: G} by tmp + mv, read it back
#   4. mkdir "$log.go" — the signal; the child makes "$log.ack" and execs
#
# Any step that fails leaves the gate unstarted: FAIL 125 with `machine-lock-handoff-failed
# <lock> stage=<group|token|tmp|mv|verify|abort|signal|ack>` on stderr, never retried and never
# run without the lock's protection (docs/design/verify-lock-holder-group-4288.md §2.3–§2.6).

# The child's side of step 4 (a subshell of this shell). 0 after it saw the body's signal and made
# its ack; 1 when it must not run: it withdrew (the body is not known to be alive, or the handoff
# deadline passed — whoever makes "$go" first wins), or it could make neither "$go" nor "$ack".
lock_handoff_wait() { # <go> <ack> <deadline-epoch-s>
  lock_child_wait "$1" "$2" "$3" "$LOCK_SELF_PID"
}

# Step 3. LPG_STAGE is empty on success (the owner on record is T1 with pgid G), else the stage
# that failed; LPG_T1 the new token. LOCK_PENDING_TOKEN is set first, so an EXIT trap that comes
# between the mv and the signal still knows the record is this run's.
lock_publish_group() { # <lock-path> <T0> <G>
  LPG_T1="$2-g$3"
  lock_hand_off "$1" "$2" "$$" "$3"
  LPG_STAGE=$LHO_STAGE
}

# The gate did not start: stop the waiting child, give the lock back under whichever of this run's
# tokens is on record (none when the owner is someone else's or unreadable — and not on a `token`
# failure, which is exactly that), and report FAIL 125.
rga_handoff_fail() { # <stage> <child-pid> <watchdog-pid> <lock-path> <T0> <T1>
  if [ -n "$3" ]; then kill -s KILL "$3" 2>/dev/null; wait "$3" 2>/dev/null; fi
  if [ "$1" = group ]; then kill -s KILL "$2" 2>/dev/null; else kill -s KILL -- "-$2" 2>/dev/null; fi
  wait "$2" 2>/dev/null
  LOCK_GATE_LEADER=""
  LOCK_GATE_WATCHDOG=""
  rhf_kept=0
  if [ "$1" != group ] && ! lock_drain_group "$2" 1; then
    lock_note_undrained "$4" "${6:-$5}" "$2"
    rhf_kept=1
  fi
  if [ "$1" != token ] && [ "$rhf_kept" = 0 ]; then
    lock_obs_owner release-owner "$4"
    if [ "$LOB_CLASS" = record ] && [ -n "$6" ] && [ "$LOB_TOKEN" = "$6" ]; then
      lock_release "$4" "$6" && LOCK_HELD_PATH="" && LOCK_HELD_TOKEN=""
    elif [ "$LOB_CLASS" = record ] && [ "$LOB_TOKEN" = "$5" ]; then
      lock_release "$4" "$5" && LOCK_HELD_PATH="" && LOCK_HELD_TOKEN=""
    elif [ "$LOB_CLASS" = missing ]; then
      lock_release_own_gone "$4" "$5"
      if [ -n "$6" ]; then lock_release_own_gone "$4" "$6"; fi
    fi
  fi
  LOCK_PENDING_TOKEN=""
  LOCK_GATE_GROUP=""
  echo "verify-run: machine-lock-handoff-failed $4 stage=$1 (the gate was not started)" >&2
  RGA_STATUS=handoff-fail
  RGA_CODE=125
  RGA_DUR=0
}

# A mutexed attempt after the fork (called from run_gate_attempt with the lock held under
# rga_lock_token = T0 and the child waiting for "$log.go"). Sets RGA_STATUS / RGA_CODE / RGA_DUR
# like run_gate_attempt.
run_gate_handoff() { # <id> <timeout> <log> <child-pid>
  rgh_t0=$rga_lock_token
  rgh_go="$3.go"
  rgh_ack="$3.ack"
  rgh_mark="$3.timedout"
  rgh_stage=""
  rgh_wpid=""
  rgh_pid=$4
  LPG_T1=""
  LOCK_GATE_LEADER=$rgh_pid
  lock_test_pause forked
  # The group is used only once ps confirms the child leads it: with job control off, -<pid>
  # would name some unrelated group.
  if [ "$(lock_obs_pgid handoff-group "$rgh_pid")" != "$rgh_pid" ]; then rgh_stage=group; fi
  if [ -z "$rgh_stage" ]; then
    LOCK_GATE_GROUP=$rgh_pid
    lock_test_pause group
    # Started before the publish, counting from the ack: a handoff that takes long never eats the
    # gate's budget, and a child that never runs is never signalled. It stays in this shell's group,
    # so kill -9 to this shell alone leaves it to stop the gate on time.
    ( while [ ! -d "$rgh_ack" ]; do
        [ "$(lock_obs_kill0 handoff-watch "-$rgh_pid")" = gone ] && exit 0
        sleep 0.05 2>/dev/null || sleep 1
      done
      sleep "$2"
      : > "$rgh_mark"
      kill -s TERM -- "-$rgh_pid" 2>/dev/null
      sleep "$KILL_GRACE_SEC"
      kill -s KILL -- "-$rgh_pid" 2>/dev/null
    ) >/dev/null 2>&1 &
    rgh_wpid=$!
    LOCK_GATE_WATCHDOG=$rgh_wpid
    lock_test_pause watchdog
    lock_publish_group "$RGA_LOCK_PATH" "$rgh_t0" "$rgh_pid"
    rgh_stage=$LPG_STAGE
  fi
  if [ -z "$rgh_stage" ]; then
    lock_test_pause published
    rgh_sig=$(lock_obs_mkdir handoff-signal "$rgh_go")
    case "$rgh_sig" in
      created)
        LOCK_HELD_TOKEN=$LPG_T1
        rga_lock_token=$LPG_T1
        LOCK_PENDING_TOKEN=""
        lock_test_pause signalled;;
      exists) rgh_stage=abort;;
      *) if [ -d "$rgh_go" ]; then rgh_stage=abort; else rgh_stage=signal; fi;;
    esac
  fi
  if [ -n "$rgh_stage" ]; then
    rga_handoff_fail "$rgh_stage" "$rgh_pid" "$rgh_wpid" "$RGA_LOCK_PATH" "$rgh_t0" "$LPG_T1"
    return 0
  fi

  # 2>/dev/null suppresses the shell job-control "Terminated" notice.
  wait "$rgh_pid" 2>/dev/null
  rgh_code=$?
  LOCK_GATE_LEADER=""
  # KILL, not TERM (Issue #228): see run_gate_attempt.
  kill -s KILL "$rgh_wpid" 2>/dev/null
  wait "$rgh_wpid" 2>/dev/null
  LOCK_GATE_WATCHDOG=""
  RGA_DUR=$(( $(date +%s) - rga_start ))
  lock_test_pause leader-exited
  if [ ! -d "$rgh_ack" ]; then
    # The child exited without running the command (its ack could not be made).
    rga_handoff_fail ack "$rgh_pid" "" "$RGA_LOCK_PATH" "$rgh_t0" "$LPG_T1"
    return 0
  fi
  # Released only once the group is empty: a background child the gate left behind is stopped
  # first, and a group that does not empty keeps the lock to the end of the run (§2.5).
  rgh_term=0
  if [ -f "$rgh_mark" ]; then rgh_term=1; fi
  if lock_drain_group "$rgh_pid" "$rgh_term"; then
    if [ "$LDG_SIGNALLED" = 1 ] && [ "$rgh_term" = 0 ]; then
      echo "verify-run: gate $1 left processes in group $rgh_pid; stopped them before releasing $RGA_LOCK_PATH" >&2
    fi
    lock_release "$RGA_LOCK_PATH" "$rga_lock_token"
  else
    lock_note_undrained "$RGA_LOCK_PATH" "$rga_lock_token" "$rgh_pid"
  fi
  LOCK_GATE_GROUP=""
  if [ -f "$rgh_mark" ]; then
    RGA_STATUS=timeout
    RGA_CODE=124
  elif [ "$rgh_code" -eq 0 ]; then
    RGA_STATUS=pass
    RGA_CODE=0
  else
    RGA_STATUS=fail
    RGA_CODE=$rgh_code
  fi
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
