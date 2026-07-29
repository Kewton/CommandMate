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
#
# Exit code: passed=0 / config error=2 / failed=20 / not_started=21 / skipped=22.
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
trap 'rm -rf "$WORKDIR"' EXIT

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
  } else {
    err("unknown gate key: " KV_K)
  }
}
function flushgate() {
  if (!gate_open) return
  if (gid == "") err("gate is missing id:")
  if (gcmd == "") err("gate is missing command:")
  if (gid != "" && gcmd != "") {
    printf "GATE\t%s\t%s\t%s\n", gid, (gto == "" ? "-" : gto), gcmd
    ngates++
  }
  gid = ""; gcmd = ""; gto = ""; gate_open = 0
}
BEGIN { SQ = sprintf("%c", 39); section = ""; gate_open = 0; ngates = 0; nversion = 0 }
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
      if (KV_K == "baseRef" || KV_K == "skipInPrimaryCheckout" || KV_K == "maxLogTailBytes")
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
GATE_CMDS=()
OPT_BASE_REF=""
OPT_SKIP_PRIMARY="true"
OPT_MAX_TAIL="$DEFAULT_MAX_LOG_TAIL_BYTES"

while IFS="$TAB" read -r kind a b rest; do
  case "$kind" in
    GATE)
      GATE_IDS+=("$a")
      GATE_TOS+=("$b")
      GATE_CMDS+=("$rest")
      ;;
    OPT)
      case "$a" in
        baseRef) OPT_BASE_REF=$b;;
        skipInPrimaryCheckout) OPT_SKIP_PRIMARY=$b;;
        maxLogTailBytes) OPT_MAX_TAIL=$b;;
      esac
      ;;
  esac
done < "$PARSED"

case "$OPT_SKIP_PRIMARY" in
  true|false) ;;
  *) die_config "options.skipInPrimaryCheckout must be true or false (got: $OPT_SKIP_PRIMARY)";;
esac
case "$OPT_MAX_TAIL" in
  ''|*[!0-9]*) die_config "options.maxLogTailBytes must be an integer (got: $OPT_MAX_TAIL)";;
esac
if [ "$OPT_MAX_TAIL" -gt "$MAX_LOG_TAIL_BYTES_LIMIT" ]; then
  die_config "options.maxLogTailBytes must be 0..$MAX_LOG_TAIL_BYTES_LIMIT (got: $OPT_MAX_TAIL)"
fi

GATE_ID_RE='^[a-z0-9][a-z0-9-]{0,31}$'
SEEN_IDS="$WORKDIR/seen-ids"
: > "$SEEN_IDS"
gate_count=${#GATE_IDS[@]}
i=0
while [ "$i" -lt "$gate_count" ]; do
  vid=${GATE_IDS[$i]}
  case "$vid" in
    work-evidence|scope) die_config "gate id is reserved: $vid";;
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
if [ "$SKIP_WORK_EVIDENCE" -eq 1 ]; then
  echo "GATE work-evidence SKIP reason=flag"
else
  merge_base=$(git_in merge-base "$BASE_REF" HEAD 2>/dev/null) \
    || die_config "cannot compute merge-base($BASE_REF, HEAD)"
  commits=$(git_in rev-list --count "$merge_base..HEAD" 2>/dev/null) \
    || die_config "cannot count commits since $BASE_REF"
  git_in status --porcelain > "$WORKDIR/status.txt" 2>/dev/null \
    || die_config "git status failed in $CWD"
  uncommitted=$(wc -l < "$WORKDIR/status.txt" | tr -d ' ')
  if [ "$commits" -gt 0 ] || [ "$uncommitted" -gt 0 ]; then
    echo "GATE work-evidence PASS commits=$commits uncommitted=$uncommitted"
  else
    echo "GATE work-evidence FAIL commits=$commits uncommitted=$uncommitted"
    echo "RESULT not_started"
    exit "$EXIT_NOT_STARTED"
  fi
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

# --- gate execution -----------------------------------------------------------
emit_log_tail() {
  el_id=$1
  el_status=$2
  el_log=$3
  [ "$OPT_MAX_TAIL" -gt 0 ] || return 0
  [ -s "$el_log" ] || return 0
  echo "--- gate $el_id ($el_status): last $OPT_MAX_TAIL bytes ---" >&2
  tail -c "$OPT_MAX_TAIL" "$el_log" >&2
  echo "--- end gate $el_id ---" >&2
}

any_failed=0
gates_ran=0

run_gate() {
  rg_id=$1
  rg_cmd=$2
  rg_to=$3
  rg_log="$WORKDIR/gate-$rg_id.log"
  rg_mark="$WORKDIR/gate-$rg_id.timedout"
  rm -f "$rg_mark"
  rg_start=$(date +%s)

  # `set -m` puts the gate in its own process group so the watchdog can kill the
  # whole tree. Without it, `npm run x` dies but the node/sleep children it forked
  # survive the timeout (measured: 2 orphans left behind).
  set -m
  ( cd "$CWD" && exec /bin/sh -c "$rg_cmd" ) > "$rg_log" 2>&1 &
  rg_pid=$!
  set +m

  # `kill -TERM -N` signals whatever process group has id N. If job control could
  # not be enabled, the gate stays in this shell's group and N is just a pid —
  # then the group with that id belongs to some unrelated process tree, and
  # signalling it blindly would kill a bystander. So confirm the gate really is
  # its own group leader before using the group form.
  rg_pgid=$(ps -o pgid= -p "$rg_pid" 2>/dev/null | tr -d ' ')
  if [ "$rg_pgid" = "$rg_pid" ]; then rg_target="-$rg_pid"; else rg_target="$rg_pid"; fi

  ( sleep "$rg_to"
    : > "$rg_mark"
    kill -s TERM -- "$rg_target" 2>/dev/null
    sleep "$KILL_GRACE_SEC"
    kill -s KILL -- "$rg_target" 2>/dev/null
  ) >/dev/null 2>&1 &
  rg_wpid=$!

  # 2>/dev/null suppresses the shell job-control "Terminated" notice.
  wait "$rg_pid" 2>/dev/null
  rg_code=$?
  kill -TERM "$rg_wpid" 2>/dev/null
  wait "$rg_wpid" 2>/dev/null

  rg_dur=$(( $(date +%s) - rg_start ))
  gates_ran=$((gates_ran + 1))

  if [ -f "$rg_mark" ]; then
    echo "GATE $rg_id TIMEOUT exit=124 duration=${rg_dur}s"
    any_failed=1
    emit_log_tail "$rg_id" "TIMEOUT after ${rg_to}s" "$rg_log"
  elif [ "$rg_code" -eq 0 ]; then
    echo "GATE $rg_id PASS exit=0 duration=${rg_dur}s"
  else
    echo "GATE $rg_id FAIL exit=$rg_code duration=${rg_dur}s"
    any_failed=1
    emit_log_tail "$rg_id" "FAIL exit=$rg_code" "$rg_log"
  fi
}

i=0
while [ "$i" -lt "$gate_count" ]; do
  cur_id=${GATE_IDS[$i]}
  cur_to=${GATE_TOS[$i]}
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
  run_gate "$cur_id" "$cur_cmd" "$cur_to"
done

if [ "$gates_ran" -eq 0 ]; then
  echo "RESULT skipped"
  exit "$EXIT_SKIPPED"
fi
if [ "$any_failed" -ne 0 ]; then
  echo "RESULT failed"
  exit "$EXIT_FAILED"
fi
echo "RESULT passed"
exit "$EXIT_PASSED"
