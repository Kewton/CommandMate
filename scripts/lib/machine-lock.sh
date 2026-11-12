# shellcheck shell=bash
# The section is eval'd from verify-run.sh, so its globals (LOB_*, LOCK_*) and the functions it calls
# back (the codec) are invisible to shellcheck here.
# shellcheck disable=SC2034,SC2153,SC2329
# scripts/lib/machine-lock.sh — the machine-wide lock (CommandMate #4277 / #4288) for bash callers
# outside verify-run.sh: run-lock (scripts/uat/run-lock.sh) and supervisor.lock
# (scripts/agent-health/product/lib.sh). Issue #4288 PR1a, docs/design/lock-reservation-rest-4288.md
# §1.6–§1.8.
#
# The lock is NOT reimplemented here. Sourcing this file loads the lock section of this repository's
# .claude/skills/cmate-verify/scripts/verify-run.sh (from `# --- machine-wide gate lock` to the line
# before `# --- gate execution`) — the same cut the tests of #4277 / #4288 evaluate — so the tickets,
# the head-only recovery, the moved-aside records (`<lock>.gone-*`) and the three-valued observations
# are the ones every verify uses. Added on top of it, for these callers only:
#
#   machine_lock_use_kv_codec   the owner as key=value lines (D1): pid= host= token= started_at= v=1, the
#                               caller's LOCK_OWNER_EXTRA lines (label=, run_dir=, lstart= once; a key
#                               the section writes is refused, #4288 PR1a-f I1-c), pgid=. An
#                               older reader reads `pid=` with sed, so the lines stay; a record without
#                               host= is this host's.
#   lock_record_state (wrapped) supervisor.lock's lstart (D7, #4288 PR1a-f I5): a record with an lstart=
#                               line whose pid answers kill -0 (alive, or EPERM) is judged by
#                               machine_lock_pid_identity — gone only when the start computed from
#                               `ps -o etime=` is after started_at= + 2 s (reused), whatever the time
#                               zones; the same lstart string is alive; a record without started_at=
#                               whose string differs is unknown (never taken). The moved-aside records
#                               go through the same function (lock_settle_gone calls lock_record_state).
#   machine_lock_pid_identity   that judgement (design §4.1): alive | reused | unknown:<point>:<errno>.
#                               It decides whether to REMOVE a lock, never whether to stop a process.
#   machine_lock_etime_ms       the strict `ps -o etime=` parse (the section's lock_etime_ms).
#   lock_release_held           the holder's own release for these callers (D12), instead of
#                               lock_release (which removes the canonical lock on a missing owner).
#   machine_lock_queue_of       the queue of tickets of a lock path: `${lock%.lock}.queue`.
#
# Loaded once: a second source (lib.sh sources run-lock.sh and this file) returns at once, and the
# functions keep the copy the first load made. The settings the loaded operations need (KILL_GRACE_SEC,
# HANDOFF_WAIT_SEC, LOCK_POLL_SEC …) are set by the section itself, so a caller under `set -u` that set
# none of them loads a working lock (Codex review-4288h P2-1). A section that cannot be found — a
# marker missing or there twice — fails the source (return 1): the caller must treat that as "not
# acquired", never run unlocked.
#
# Not under `set -e` (errexit): the section is written for `set -u` only. Its observations and
# operations answer with non-zero statuses and command substitutions that fail on purpose (an owner
# that is missing, a marker not found), so under errexit the caller's shell would end silently in the
# middle of an acquisition or a recovery. Sourcing under `set -e` fails the source (return 1) with a
# message; a caller must not turn errexit on after sourcing either (PM review of PR1a A P3-2 / B P3-1).
#
# bash 3.2 compatible (macOS /bin/bash).

case $- in
  *e*)
    echo "machine-lock: not loaded under set -e (errexit): the lock operations answer with non-zero statuses; source this under set -u only" >&2
    return 1 2>/dev/null || exit 1;;
esac

if [ -n "${MACHINE_LOCK_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi

# The verify-run.sh the section is cut from: this repository's, unless a test names another copy.
machine_lock_script() {
  if [ -n "${MACHINE_LOCK_VERIFY_RUN:-}" ]; then
    printf '%s\n' "$MACHINE_LOCK_VERIFY_RUN"
    return 0
  fi
  mls_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd) || return 1
  printf '%s\n' "$mls_dir/.claude/skills/cmate-verify/scripts/verify-run.sh"
}

machine_lock_load() {
  [ -z "${MACHINE_LOCK_LOADED:-}" ] || return 0
  mll_script=$(machine_lock_script) || { echo "machine-lock: cannot locate verify-run.sh" >&2; return 1; }
  if [ ! -f "$mll_script" ]; then
    echo "machine-lock: $mll_script not found (the lock section cannot be loaded)" >&2
    return 1
  fi
  mll_begin=$(grep -c '^# --- machine-wide gate lock' "$mll_script" 2>/dev/null)
  mll_end=$(grep -c '^# --- gate execution' "$mll_script" 2>/dev/null)
  if [ "$mll_begin" != 1 ] || [ "$mll_end" != 1 ]; then
    echo "machine-lock: $mll_script has $mll_begin begin / $mll_end end markers of the lock section (want 1 / 1)" >&2
    return 1
  fi
  mll_section=$(sed -n '/^# --- machine-wide gate lock/,/^# --- gate execution/p' "$mll_script") || return 1
  [ -n "$mll_section" ] || return 1
  eval "$mll_section" || return 1

  # D7 (#4288 PR1a-f I5): wrap the record's judgement with supervisor.lock's lstart. Only a record that
  # carries an lstart= line (LOB_LSTART, set by the kv codec from the same one read) is affected, and
  # only when kill -0 of its pid is alive or EPERM (a record alive by its group alone is not: F44). D7
  # never turns anything alive; it turns a holder gone only on machine_lock_pid_identity's `reused` (the
  # evidence of started_at= and etime), and then the group decides as before. EPERM stays EPERM
  # otherwise. A record without started_at= whose lstart string differs answers
  # unknown:lstart:EMISMATCH, which the section's callers name with what to do by hand (F38).
  eval "machine_lock_record_state_base() $(declare -f lock_record_state | sed 1d)"
  lock_record_state() {
    if [ -z "${LOB_LSTART:-}" ] || [ -z "$LOB_PID" ] || [ "$LOB_HOST" != "$LOCK_HOST" ]; then
      machine_lock_record_state_base
      return 0
    fi
    mlr_p=$(lock_obs_kill0 pid "$LOB_PID")
    case "$mlr_p" in
      alive|unknown:pid:EPERM) ;;
      *) machine_lock_record_state_base; return 0;;
    esac
    mlr_started=$(machine_lock_epoch_ms "${LOB_STARTED_AT:-}") || mlr_started=""
    mlr_id=$(machine_lock_pid_identity "$LOB_PID" "$LOB_LSTART" "$mlr_started")
    if [ "$mlr_id" = reused ]; then
      lock_group_state "$LOB_PGID"
      return 0
    fi
    if [ "$mlr_p" = alive ]; then echo "$mlr_id"; else echo "$mlr_p"; fi
  }

  MACHINE_LOCK_LOADED=1
  return 0
}

# started_at= (ISO-8601 UTC, whole seconds: machine_lock_iso) in ms since the epoch, or return 1 when
# date cannot read it (BSD date -j -f, else GNU date -d). TZ-independent: both sides are UTC.
machine_lock_epoch_ms() { # <started_at>
  [ -n "$1" ] || return 1
  case "$1" in *[!0-9TZ:-]*) return 1;; esac
  if mle_s=$(LC_ALL=C date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null); then :
  elif mle_s=$(LC_ALL=C date -u -d "$1" +%s 2>/dev/null); then :
  else return 1
  fi
  case "$mle_s" in ''|*[!0-9]*) return 1;; esac
  echo $(( mle_s * 1000 ))
}

# The strict `ps -o etime=` parse (design §4.1): the section's lock_etime_ms (one rule, one copy).
machine_lock_etime_ms() { # <etime text>
  lock_etime_ms "$1"
}

# Whether the process under <pid> may be another process than the one that took the lock (design §4.1,
# #4288 PR1a-f; the contract PR1c calls through D7). Prints one line, exit code always 0:
#   alive   — reuse not shown: the same lstart string, or a start from etime not after
#             <started-at-ms> + LOCK_PID_REUSE_SLACK_MS. NOT a proof of "the same process": use it to
#             decide whether to remove a lock, never whether to stop a process (proc_matches).
#   reused  — the start computed from `ps -o etime=` (now taken before ps) is after started_at + 2 s.
#   unknown:<point>:<errno> — lstart unreadable (lstart:<errno>); the strings differ and there is no
#             started_at to compare with (lstart:EMISMATCH: a time zone or a reuse cannot be told);
#             etime unreadable or malformed (etime:<errno> / etime:EINVAL); the clock stepped back
#             between the reads around ps, or the reads took 1 s or more (etime:ECLOCK).
# <started-at-ms> may be empty (a record without started_at=). The caller calls it only when kill -0 of
# the pid is alive or EPERM. Test seams: CM_VERIFY_TEST_OBS_FAULT=lstart=<ERRNO> / etime=<ERRNO>
# (etime=ECLOCK too); a test may redefine lock_now_ms.
machine_lock_pid_identity() { # <pid> <recorded-lstart> <started-at-ms>
  mpi_before=$(lock_now_ms)
  lock_test_obs_fault lstart "$1"
  if [ -n "$LTF_CODE" ]; then echo "unknown:lstart:$LTF_CODE"; return 0; fi
  if ! mpi_cur=$(LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null); then echo unknown:lstart:EUNKNOWN; return 0; fi
  mpi_cur=$(machine_lock_squeeze "$mpi_cur")
  if [ -z "$mpi_cur" ]; then echo unknown:lstart:EUNKNOWN; return 0; fi
  if [ "$mpi_cur" = "$(machine_lock_squeeze "$2")" ]; then echo alive; return 0; fi
  if [ -z "$3" ]; then echo unknown:lstart:EMISMATCH; return 0; fi
  lock_test_obs_fault etime "$1"
  if [ -n "$LTF_CODE" ]; then echo "unknown:etime:$LTF_CODE"; return 0; fi
  if ! mpi_et=$(LC_ALL=C ps -o etime= -p "$1" 2>/dev/null); then echo unknown:etime:EUNKNOWN; return 0; fi
  if ! mpi_ms=$(machine_lock_etime_ms "$mpi_et"); then echo unknown:etime:EINVAL; return 0; fi
  mpi_after=$(lock_now_ms)
  if [ "$mpi_after" -lt "$mpi_before" ] || [ $(( mpi_after - mpi_before )) -ge 1000 ]; then
    echo unknown:etime:ECLOCK
    return 0
  fi
  if [ $(( mpi_before - mpi_ms )) -gt $(( $3 + LOCK_PID_REUSE_SLACK_MS )) ]; then echo reused; else echo alive; fi
}

# ps -o lstart= with blanks squeezed (macOS pads the day of the month).
machine_lock_squeeze() { # <text>
  # shellcheck disable=SC2086 # word splitting is the squeeze
  set -- $1
  printf '%s' "$*"
}

# Whether <pid> is still the process that started at <lstart>, by the string alone: alive | gone |
# unknown:lstart:<errno>. Kept for its callers' reference (PR1a); D7 no longer reads it — the string is
# printed in the reader's time zone, so another TZ read a live holder as gone (#4288 PR1a-f E5, I5).
# Test seam: CM_VERIFY_TEST_OBS_FAULT=lstart=<ERRNO> (the same injection as the section's points).
machine_lock_lstart_state() { # <pid> <recorded lstart>
  lock_test_obs_fault lstart "$1"
  if [ -n "$LTF_CODE" ]; then
    echo "unknown:lstart:$LTF_CODE"
    return 0
  fi
  if ! mls_out=$(LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null); then
    echo "unknown:lstart:EUNKNOWN"
    return 0
  fi
  mls_now=$(machine_lock_squeeze "$mls_out")
  if [ -z "$mls_now" ]; then
    echo "unknown:lstart:EUNKNOWN"
    return 0
  fi
  if [ "$mls_now" = "$(machine_lock_squeeze "$2")" ]; then echo alive; else echo gone; fi
}

machine_lock_queue_of() { # <lock-path>
  printf '%s.queue\n' "${1%.lock}"
}

# D1: the owner as key=value lines. Reads the one read's text with the shell alone (no extraction
# that could fail); a pgid= line whose value is not a number is unknown (EINVAL), as in JSON.
machine_lock_use_kv_codec() {
  LOCK_OWNER_CODEC=kv
  lock_parse_owner_text() { # <text>
    LPO_PID=""
    LPO_HOST=""
    LPO_TOKEN=""
    LPO_PGID=""
    LPO_LSTART=""
    LPO_STARTED_AT=""
    LPO_V=""
    lpo_has_pgid=0
    while IFS= read -r lpo_line; do
      case "$lpo_line" in
        pid=*) [ -n "$LPO_PID" ] || LPO_PID=${lpo_line#pid=};;
        host=*) [ -n "$LPO_HOST" ] || LPO_HOST=${lpo_line#host=};;
        token=*) [ -n "$LPO_TOKEN" ] || LPO_TOKEN=${lpo_line#token=};;
        lstart=*) [ -n "$LPO_LSTART" ] || LPO_LSTART=${lpo_line#lstart=};;
        started_at=*) [ -n "$LPO_STARTED_AT" ] || LPO_STARTED_AT=${lpo_line#started_at=};;
        v=*) [ -n "$LPO_V" ] || LPO_V=${lpo_line#v=};;
        pgid=*) [ "$lpo_has_pgid" = 1 ] || { LPO_PGID=${lpo_line#pgid=}; lpo_has_pgid=1; };;
      esac
    done <<MLKV_EOF
$1
MLKV_EOF
    case "$LPO_PID" in *[!0-9]*) LPO_PID="";; esac
    # The record is on the machine's own tmp / <base>: an older one without host= is this host's.
    [ -n "$LPO_HOST" ] || LPO_HOST=$LOCK_HOST
    if [ "$lpo_has_pgid" = 1 ]; then
      case "$LPO_PGID" in ''|*[!0-9]*) return 2;; esac
    fi
    return 0
  }
  lock_format_owner() { # <pid> <token> <acquiredAt-ms> [<pgid>]
    printf 'pid=%s\n' "$1"
    printf 'host=%s\n' "$LOCK_HOST"
    printf 'token=%s\n' "$2"
    printf 'started_at=%s\n' "$(machine_lock_iso "$3")"
    printf 'v=1\n'
    [ -z "${LOCK_OWNER_EXTRA:-}" ] || printf '%s\n' "$LOCK_OWNER_EXTRA"
    [ -z "${4:-}" ] || printf 'pgid=%s\n' "$4"
  }
}

# <ms since the epoch> as an ISO-8601 UTC time (BSD date -r, else GNU date -d @).
machine_lock_iso() { # <ms>
  mli_s=$(( ${1:-0} / 1000 ))
  date -u -r "$mli_s" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$mli_s" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ
}

# D12: the holder's own release (daily.sh's EXIT, supervisor's EXIT, UAT's `up` before its handover).
#   1. Once: nothing unless this shell holds <lock-path> (LOCK_HELD_PATH); the mark is dropped first,
#      so a second call — after another taker's mkdir, say — does nothing.
#   2. One read of the owner. Unknown: not removed (release-deferred). Missing or corrupt: the
#      canonical lock is NOT removed (it may be another taker's mkdir, or an owner being written);
#      only this holder's own moved-aside records are cleaned.
#   3. A record under one of this holder's tokens — the ones given, LOCK_HELD_TOKEN, and
#      LOCK_PENDING_TOKEN after a handover was tried — follows D12's invariant (the same table as the
#      sync JS's release, docs/design/lock-reservation-rest-4288.md D12): it is removed here only when
#      its recorded pid is this shell ($$: daily.sh, the supervisor, UAT's `up` with T0) and its
#      group is empty (no pgid=, or ESRCH; a record whose pid and pgid are both $$ names this shell's
#      own group and is not judged by it). A group that still has a member, or cannot be shown empty,
#      keeps it (release-deferred). Any other recorded pid — alive or gone, after a handover or the
#      initial LOCK_OWNER_PID alike (UAT's T1: the server) — is not this shell's to remove: a pid read
#      alive can die before the delete and a head recover it and take the lock in between, so it
#      returns 2 (LRH_RESULT=needs-head) and the caller releases with lock_release_as_head (D5). A pid
#      that cannot be observed: release-deferred.
#   4. Another token: only this holder's own moved-aside records are cleaned.
# LRH_RESULT: none | released | kept | deferred | needs-head. 0 for none / released / kept.
lock_release_held() { # <lock-path> [<token>…]
  LRH_RESULT=none
  if [ -z "$LOCK_HELD_PATH" ] || [ "$LOCK_HELD_PATH" != "$1" ]; then return 0; fi
  lrh_lock=$1
  shift
  lrh_tokens="$* $LOCK_HELD_TOKEN $LOCK_PENDING_TOKEN"
  LOCK_HELD_PATH=""
  LOCK_HELD_TOKEN=""
  LOCK_PENDING_TOKEN=""
  lock_obs_owner release-owner "$lrh_lock"
  case "$LOB_CLASS" in
    unknown)
      LRH_RESULT=deferred
      echo "verify-run: machine-lock-release-deferred $lrh_lock point=release-owner errno=$LOB_CODE" >&2
      return 1;;
    missing|corrupt)
      LRH_RESULT=kept
      for lrh_t in $lrh_tokens; do lock_release_own_gone "$lrh_lock" "$lrh_t"; done
      return 0;;
  esac
  lrh_mine=0
  for lrh_t in $lrh_tokens; do
    if [ "$LOB_TOKEN" = "$lrh_t" ]; then lrh_mine=1; fi
  done
  if [ "$lrh_mine" = 0 ]; then
    LRH_RESULT=kept
    for lrh_t in $lrh_tokens; do lock_release_own_gone "$lrh_lock" "$lrh_t"; done
    return 0
  fi
  # D12's invariant (PR1a-c): the group first — unless pid = pgid = this shell ($$ leads it and is in
  # it by definition) — then the pid: only this shell's own is removed here.
  if [ "$LOB_PID" != "$$" ] || [ "$LOB_PGID" != "$$" ]; then
    if ! lock_group_is_empty "$LOB_PGID"; then
      LRH_RESULT=deferred
      echo "verify-run: machine-lock-release-deferred $lrh_lock pgid=$LOB_PGID" >&2
      return 1
    fi
  fi
  # $$ is the pid of the shell that took the lock, also inside a subshell. bash's own is the main shell
  # (BASH_SUBSHELL=0) whose $$ is alive (D12): a subshell is never "the caller" — its parent can die after
  # the $$ check and a head take T2 before the delete, or the pid be reused — so it goes the pid way
  # (needs-head), as does a main shell whose $$ cannot be shown alive.
  if [ "${BASH_SUBSHELL:-0}" = 0 ] && [ "$LOB_PID" = "$$" ] && [ "$(lock_obs_kill0 pid "$$")" = alive ]; then
    rm -rf "$lrh_lock" 2>/dev/null || true
    for lrh_t in $lrh_tokens; do lock_release_own_gone "$lrh_lock" "$lrh_t"; done
    LRH_RESULT=released
    return 0
  fi
  lrh_pid=$(lock_obs_kill0 pid "$LOB_PID")
  case "$lrh_pid" in
    alive|gone)
      LRH_RESULT=needs-head
      echo "verify-run: machine-lock-release-needs-head $lrh_lock (recorded pid $LOB_PID is not this shell; release as the head)" >&2
      return 2;;
    *)
      LRH_RESULT=deferred
      echo "verify-run: machine-lock-release-deferred $lrh_lock (recorded pid $LOB_PID is ${lrh_pid})" >&2
      return 1;;
  esac
}

machine_lock_load
