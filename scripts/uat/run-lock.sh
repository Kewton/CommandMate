#!/bin/bash
#
# CommandMate - the one lock that UAT, the daily agent-health check and a
# manual `run.ts` share (Issue #3359; on the machine-wide lock since #4288 PR1b,
# docs/design/run-lock-machine-lock-4288.md).
#
# Sourced, not executed:
#
#   . "scripts/uat/run-lock.sh"
#   run_lock_acquire <label> <pid> <token> [<run dir>] || exit 1
#   ...
#   run_lock_release <token>
#
# The lock is a DIRECTORY made with `mkdir`, which is atomic: of two callers
# that race, exactly one gets it. Inside, `owner` holds key=value lines — pid /
# host / token / started_at / label (and run_dir for a UAT run, pgid once the
# lock was handed to a process group). scripts/agent-health/main.ts takes the
# same directory through src/lib/agent-health/run-lock.ts; the two must agree
# on the path and on the owner format.
#
# It is the machine-wide lock of scripts/lib/machine-lock.sh (the lock section of
# .claude/skills/cmate-verify/scripts/verify-run.sh): a caller takes a ticket first and only
# the head of the queue (`<lock without .lock>.queue`) tries the `mkdir` or recovers a dead
# holder's lock; every observation answers in three values and an unknown (EPERM, EIO …) is
# never read as free. A lock whose owner is dead — its pid, and its process group when the
# record names one — is taken over by the head alone.
#
# Where: $CM_RUN_LOCK_DIR, else <os.tmpdir()>/commandmate-run.lock (bash reads
# os.tmpdir() as ${TMPDIR:-/tmp} without the trailing slash). Not under
# ~/.commandmate, because the test suite works there.
#
# A nested caller (daily.sh runs run.ts) passes the lock down with CM_RUN_LOCK_TOKEN: a live
# holder whose token matches is the caller's own parent (D8).
#
# Handing the lock to a process group (run_lock_set_pid, D4/D9): the process the lock protects
# (UAT's server, daily's run.ts) is started as the leader of its own group, waits for a signal,
# and the owner is rewritten with that group (pgid=) under a new token T1 = <T0>-g<G> BEFORE
# the signal. From then on the lock is held while the group has a member.
#
# Sourcing changes nothing global but the function and variable names below. If
# scripts/lib/machine-lock.sh cannot be loaded, every function is still defined and source
# returns 0; the acquire / set_pid / release calls then answer 1 with RUN_LOCK_ERROR
# "machine-lock not loaded: …" (never an unlocked run).
#
# bash 3.2 compatible (macOS /bin/bash).

# The RUN_LOCK_* / LOCK_* globals are read by the callers and by the sourced lock section; the note
# function below is called by it.
# shellcheck disable=SC2034,SC2153,SC2329

# What the calls below report (set -u safe for the callers).
RUN_LOCK_ERROR=""
RUN_LOCK_HOW=""
RUN_LOCK_RESULT=""
RUN_LOCK_STAGE=""
RUN_LOCK_G=""
RUN_LOCK_HOLDER_RUN_DIR=""
# This shell took the lock with a pid that is not its own $$ (test-only; its release is refused).
RUN_LOCK_FOREIGN_PID=""
# A handover was tried in this shell (a second one is refused).
RUN_LOCK_HANDED=""
# The grace of an owner-less, empty <lock> before the head takes it out (D3): the section's
# LOCK_EMPTY_OWNER_GRACE_MS (PR1a-f, 600000), set once the section is loaded (below).
RUN_LOCK_OWNERLESS_GRACE_MS=""
# How long the parent waits to learn whether a child that "withdrew" had in fact started (seconds).
HANDOFF_SETTLE_SEC=${HANDOFF_SETTLE_SEC:-3}

RUN_LOCK_SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)
RUN_LOCK_MACHINE_LOCK_SH="$RUN_LOCK_SELF_DIR/../lib/machine-lock.sh"
RUN_LOCK_LOAD_ERROR=""
if [ -f "$RUN_LOCK_MACHINE_LOCK_SH" ]; then
    # shellcheck source=scripts/lib/machine-lock.sh
    . "$RUN_LOCK_MACHINE_LOCK_SH" || RUN_LOCK_LOAD_ERROR="$RUN_LOCK_MACHINE_LOCK_SH could not be loaded"
else
    RUN_LOCK_LOAD_ERROR="$RUN_LOCK_MACHINE_LOCK_SH not found"
fi
if [ -z "$RUN_LOCK_LOAD_ERROR" ] && [ -z "${MACHINE_LOCK_LOADED:-}" ]; then
    RUN_LOCK_LOAD_ERROR="$RUN_LOCK_MACHINE_LOCK_SH did not load the lock section"
fi
if [ -z "$RUN_LOCK_LOAD_ERROR" ]; then
    RUN_LOCK_OWNERLESS_GRACE_MS=${LOCK_EMPTY_OWNER_GRACE_MS:-}
    [ -n "$RUN_LOCK_OWNERLESS_GRACE_MS" ] || RUN_LOCK_LOAD_ERROR="$RUN_LOCK_MACHINE_LOCK_SH did not define LOCK_EMPTY_OWNER_GRACE_MS"
fi

# run_lock_dir — prints the lock directory.
run_lock_dir() {
    if [ -n "${CM_RUN_LOCK_DIR:-}" ]; then
        printf '%s\n' "$CM_RUN_LOCK_DIR"
        return 0
    fi
    local t="${TMPDIR:-/tmp}"
    while [ "${#t}" -gt 1 ] && [ "${t%/}" != "$t" ]; do t="${t%/}"; done
    printf '%s/commandmate-run.lock\n' "$t"
}

# run_lock_field <lock dir> <key> — one value from the owner file, or nothing.
run_lock_field() {
    [ -f "$1/owner" ] || return 0
    sed -n "s/^$2=//p" "$1/owner" | head -n 1
}

# run_lock_pid_alive <pid> — two values (0 alive / 1 not), as it has always been. NOT used to
# judge a lock (the lock's observations have three values); callers that only ask "is this
# process still there" (supervisor, up's loops) use it.
run_lock_pid_alive() {
    case "$1" in
        '' | *[!0-9]*) return 1 ;;
    esac
    # ps as well: kill -0 fails with EPERM on another user's live process.
    kill -0 "$1" 2>/dev/null || ps -p "$1" >/dev/null 2>&1
}

# run_lock_child_ended <pid> — 0 when the process is gone (ESRCH) or is a zombie (kill -0 still
# says alive for a child nobody has waited for); 1 when it is running or cannot be told.
run_lock_child_ended() {
    local out
    case "$1" in
        '' | *[!0-9]*) return 0 ;;
    esac
    if out=$(LC_ALL=C kill -0 "$1" 2>&1); then
        case "$(ps -o stat= -p "$1" 2>/dev/null | tr -d ' ')" in
            Z*) return 0 ;;
        esac
        return 1
    fi
    case "$out" in
        *[Nn]o\ such\ process*) return 0 ;;
    esac
    return 1
}

# run_lock_reap_if_ended <pid> — a child that ended by itself and was not waited for is reaped
# with `wait` (it returns at once), so it is not a zombie when the lock's group is judged.
run_lock_reap_if_ended() {
    if run_lock_child_ended "$1"; then
        wait "$1" 2>/dev/null
    fi
    return 0
}

# ------------------------------------------------------------------ the machine-lock glue

run_lock_require_loaded() {
    if [ -n "${MACHINE_LOCK_LOADED:-}" ]; then
        return 0
    fi
    RUN_LOCK_ERROR="machine-lock not loaded: ${RUN_LOCK_LOAD_ERROR:-scripts/lib/machine-lock.sh}"
    return 1
}

RUN_LOCK_NOTE_PATH=""
RUN_LOCK_NOTE_INSTALLED=""

# The line a recovery prints for run-lock's own lock keeps its old wording; any other lock's
# (supervisor.lock) goes to the loaded section's. Installed on the first call, never at source time.
run_lock_install_note() {
    [ -z "$RUN_LOCK_NOTE_INSTALLED" ] || return 0
    RUN_LOCK_NOTE_INSTALLED=1
    eval "run_lock_base_note_recovered() $(declare -f lock_note_recovered | sed 1d)"
    lock_note_recovered() { # <lock-path> <dead-pid>
        local rl_label
        if [ -n "${RUN_LOCK_NOTE_PATH:-}" ] && [ "$1" = "$RUN_LOCK_NOTE_PATH" ]; then
            rl_label=$(printf '%s\n' "${lob_out:-}" | sed -n 's/^label=//p' | head -n 1)
            echo "run-lock: took over a stale lock (pid $2, label $rl_label)" >&2
        else
            run_lock_base_note_recovered "$@"
        fi
    }
}

# run_lock_begin <dir> — what every call below sets for the section, and run_lock_end puts back.
run_lock_begin() {
    run_lock_install_note
    machine_lock_use_kv_codec
    RUN_LOCK_NOTE_PATH=$1
    LOCK_OWNERLESS_GRACE_MS=$RUN_LOCK_OWNERLESS_GRACE_MS
}

run_lock_end() {
    RUN_LOCK_NOTE_PATH=""
    LOCK_WANT_TOKEN=""
    LOCK_OWNER_PID=""
    LOCK_OWNER_EXTRA=""
    LOCK_OWNERLESS_GRACE_MS=""
}

# run_lock_holder <lock dir> — "pid N, label L, since T[, run dir D]".
run_lock_holder() {
    local dir=$1 run_dir
    run_dir=$(run_lock_field "$dir" run_dir)
    printf 'pid %s, label %s, since %s%s' \
        "$(run_lock_field "$dir" pid)" "$(run_lock_field "$dir" label)" \
        "$(run_lock_field "$dir" started_at)" "${run_dir:+, run dir $run_dir}"
}

# run_lock_text_field <text> <key> — the first value of <key> in an owner's text.
run_lock_text_field() {
    printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -n 1
}

# run_lock_refusal <dir> — RUN_LOCK_ERROR for an acquisition that did not take the lock. Every
# wording starts `another run holds <dir> (`; what is inside says which of the refusals it was:
# held / held-group / ticket / unknown / corrupt / no owner yet / no owner and not empty / aside.
run_lock_refusal() {
    local dir=$1 why="" state label since run_dir text ppid stat names
    RUN_LOCK_HOLDER_RUN_DIR=""
    lock_obs_owner why-owner "$dir"
    # A moved-aside record that is alive (put back, or still aside) is what held it up, whatever the lock shows now.
    if [ -n "$LOCK_GONE_PENDING" ] && [ "$LOB_CLASS" != unknown ]; then
        if [ -n "$LOCK_UNKNOWN" ]; then
            RUN_LOCK_ERROR="another run holds $dir (cannot tell: $LOCK_UNKNOWN; a moved-aside record ${LOCK_GONE_PENDING##*/} may be alive)"
        else
            RUN_LOCK_ERROR="another run holds $dir (a moved-aside record ${LOCK_GONE_PENDING##*/} is alive)"
        fi
        if [ "$LOB_CLASS" = record ]; then
            RUN_LOCK_HOLDER_RUN_DIR=$(run_lock_text_field "${lob_out:-}" run_dir)
        fi
        return 0
    fi
    case "$LOB_CLASS" in
        record)
            text=${lob_out:-}
            label=$(run_lock_text_field "$text" label)
            since=$(run_lock_text_field "$text" started_at)
            run_dir=$(run_lock_text_field "$text" run_dir)
            RUN_LOCK_HOLDER_RUN_DIR=$run_dir
            state=$(lock_record_state)
            case "$state" in
                unknown:*)
                    state=${state#unknown:}
                    why="cannot tell: point=${state%%:*} path=$dir errno=${state##*:}"
                    ;;
                *)
                    if [ -n "$LOB_PGID" ] && [ "$(lock_obs_kill0 pid "$LOB_PID")" = gone ]; then
                        why="pid $LOB_PID gone, pgid $LOB_PGID alive, label $label, since $since${run_dir:+, run dir $run_dir}"
                    else
                        why="pid $LOB_PID, label $label, since $since${run_dir:+, run dir $run_dir}"
                        stat=$(ps -o stat= -p "$LOB_PID" 2>/dev/null | tr -d ' ')
                        case "$stat" in
                            Z*)
                                ppid=$(ps -o ppid= -p "$LOB_PID" 2>/dev/null | tr -d ' ')
                                why="$why, zombie: its parent ${ppid:-?} has not reaped it"
                                ;;
                        esac
                    fi
                    if [ "$LOB_HOST" != "$LOCK_HOST" ]; then
                        why="$why; recorded on host $LOB_HOST, this host is $LOCK_HOST: remove $dir by hand if $LOB_HOST is this machine"
                    fi
                    ;;
            esac
            ;;
        corrupt)
            why="$dir/owner has no pid= or token=: check and remove $dir by hand"
            ;;
        unknown)
            why="cannot tell: point=why-owner path=$dir/owner errno=$LOB_CODE"
            ;;
        *)
            if [ -d "$dir" ]; then
                lock_obs_list why-list "$dir"
                names=$(printf '%s' "$LOL_NAMES" | tr '\n' ' ')
                if [ -n "$LOCK_UNKNOWN" ]; then
                    why="cannot tell: $LOCK_UNKNOWN"
                elif [ "$LOL_STATE" = listed ] && [ -z "${names// /}" ]; then
                    why="no owner yet"
                elif [ "$LOL_STATE" = listed ]; then
                    why="no owner and not empty: ${names% }: check and remove $dir by hand"
                else
                    why="cannot tell: point=why-list path=$dir errno=$LOL_CODE"
                fi
            else
                case "$LOCK_HELD_BY" in
                    "queue ticket "*)
                        ppid=$(printf '%s' "$LOCK_HELD_BY" | sed -n 's/.*(pid \([0-9][0-9]*\) on .*/\1/p')
                        state=""
                        [ -z "$ppid" ] || state=$(lock_obs_kill0 pid "$ppid")
                        case "$state" in
                            unknown:*) why="cannot tell: point=pid path=$ppid errno=${state##*:}" ;;
                            '') why="ticket ahead (unreadable)" ;;
                            *) why="ticket of pid $ppid ahead" ;;
                        esac
                        ;;
                    "restore pending:"*)
                        why="a moved-aside record ${LOCK_GONE_PENDING##*/} is alive${LOCK_UNKNOWN:+ (cannot tell: $LOCK_UNKNOWN)}"
                        ;;
                    *)
                        if [ -n "$LOCK_UNKNOWN" ]; then
                            why="cannot tell: $LOCK_UNKNOWN"
                        else
                            why="could not take it"
                        fi
                        ;;
                esac
            fi
            ;;
    esac
    RUN_LOCK_ERROR="another run holds $dir ($why)"
}

# run_lock_inherits <dir> <token> — D8: the owner is read once; a live holder under the inherited
# token is this caller's own parent. While <lock> is missing, a moved-aside record of the same token
# that is alive is inherited too. Gone or unknown is not: the ordinary acquisition recovers the
# first and refuses the second.
run_lock_inherits() {
    local g
    lock_obs_owner inherit-owner "$1"
    case "$LOB_CLASS" in
        record)
            [ "$LOB_TOKEN" = "$2" ] && [ "$(lock_record_state)" = alive ]
            return
            ;;
        missing) ;;
        *) return 1 ;;
    esac
    lock_gone_candidates inherit-list "$1" || return 1
    while IFS= read -r g; do
        [ -n "$g" ] || continue
        lock_obs_owner inherit-gone-owner "$g"
        if [ "$LOB_CLASS" = record ] && [ "$LOB_TOKEN" = "$2" ] && [ "$(lock_record_state)" = alive ]; then
            return 0
        fi
    done <<RLI_EOF
$LGC_LIST
RLI_EOF
    return 1
}

# run_lock_acquire <label> <pid> <token> [<run dir>]
#
# Returns 0 when this caller now holds the lock (or its parent does: the holder's token is
# $CM_RUN_LOCK_TOKEN and it is alive — RUN_LOCK_HOW=inherited, nothing is held by this shell),
# 1 when somebody else does or the call is refused. On 1, RUN_LOCK_ERROR says who or why.
# <pid> is the pid written to the owner: $$ for every caller (a UAT `up` hands the lock to its
# server with run_lock_set_pid). A pid that is not $$ is accepted (a test writes the pid of a
# process it started) but the shell that took it never releases it (run_lock_release refuses).
run_lock_acquire() {
    local label=${1:-} pid=${2:-} token=${3:-} run_dir=${4:-} dir queue rc
    RUN_LOCK_ERROR=""
    RUN_LOCK_HOW=""
    RUN_LOCK_HOLDER_RUN_DIR=""
    run_lock_require_loaded || return 1
    case "$token" in
        '' | *[!A-Za-z0-9-]*)
            RUN_LOCK_ERROR="run-lock: a token must be [A-Za-z0-9-]+: '$token'"
            return 1
            ;;
    esac
    case "$label$run_dir" in
        *$'\n'*)
            RUN_LOCK_ERROR="run-lock: a label and a run dir must not contain a newline"
            return 1
            ;;
    esac
    case "$pid" in
        '' | *[!0-9]*)
            RUN_LOCK_ERROR="run-lock: the pid must be a number: '$pid'"
            return 1
            ;;
    esac
    dir=$(run_lock_dir)
    queue=$(machine_lock_queue_of "$dir")
    run_lock_begin "$dir"
    if [ -n "${CM_RUN_LOCK_TOKEN:-}" ]; then
        case "$CM_RUN_LOCK_TOKEN" in
            *[!A-Za-z0-9-]*) ;;
            *)
                if run_lock_inherits "$dir" "$CM_RUN_LOCK_TOKEN"; then
                    RUN_LOCK_HOW=inherited
                    run_lock_end
                    return 0
                fi
                ;;
        esac
    fi
    LOCK_WANT_TOKEN=$token
    LOCK_OWNER_PID=$pid
    LOCK_OWNER_EXTRA="label=$label"
    [ -z "$run_dir" ] || LOCK_OWNER_EXTRA="$LOCK_OWNER_EXTRA"$'\n'"run_dir=$run_dir"
    lock_acquire_path "$dir" "$queue" 0
    rc=$?
    if [ "$rc" -eq 0 ]; then
        RUN_LOCK_HOW=acquired
        RUN_LOCK_HANDED=""
        RUN_LOCK_G=""
        RUN_LOCK_FOREIGN_PID=""
        [ "$pid" = "$$" ] || RUN_LOCK_FOREIGN_PID=1
        run_lock_end
        return 0
    fi
    run_lock_refusal "$dir"
    run_lock_end
    return 1
}

# run_lock_set_pid <T0> <pid> <pgid> <go> — D4/D9: hands the lock this shell holds under <T0> to
# <pid> and its process group <pgid> (the leader of a group of its own), under T1 = <T0>-g<pgid>,
# then makes the directory <go> that the waiting child looks for. The child works only after it.
# Returns 0 when the signal is made. Otherwise 1 with RUN_LOCK_STAGE:
#   arg                 refused before anything was written (not main shell, a second handover, pid
#                       of the record not $$, pgid = $$ or this shell's group, a number that is none)
#   group               `ps -o pgid=` of <pgid> does not say <pgid>
#   token               the first read of the owner is not <T0> (unreadable under I-6)
#   tmp | mv            the owner could not be rewritten
#   verify | verify-unreadable   the owner read back is not T1 (or cannot be read)
#   signal | abort      `mkdir <go>` failed and <go> is not there / <go> was already there
# RUN_LOCK_G is <pgid> once the owner was published (a signal to the group is then allowed).
run_lock_set_pid() {
    local t0=${1:-} pid=${2:-} pgid=${3:-} go=${4:-} dir text label run_dir extra own_pgid made
    RUN_LOCK_ERROR=""
    RUN_LOCK_STAGE=""
    RUN_LOCK_G=""
    run_lock_require_loaded || { RUN_LOCK_STAGE=arg; return 1; }
    if [ "${BASH_SUBSHELL:-0}" != 0 ]; then
        RUN_LOCK_ERROR="run-lock: run_lock_set_pid must be called from the main shell"
        RUN_LOCK_STAGE=arg
        return 1
    fi
    if [ -n "$RUN_LOCK_HANDED" ]; then
        RUN_LOCK_ERROR="run-lock: the lock was already handed over by this shell"
        RUN_LOCK_STAGE=arg
        return 1
    fi
    case "$pid$pgid" in
        '' | *[!0-9]*)
            RUN_LOCK_ERROR="run-lock: pid and pgid must be numbers: '$pid' '$pgid'"
            RUN_LOCK_STAGE=arg
            return 1
            ;;
    esac
    own_pgid=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
    if [ -z "$pgid" ] || [ "$pgid" = "$$" ] || { [ -n "$own_pgid" ] && [ "$pgid" = "$own_pgid" ]; }; then
        RUN_LOCK_ERROR="run-lock: pgid $pgid is this shell's own group: the child must lead a group of its own"
        RUN_LOCK_STAGE=arg
        return 1
    fi
    dir=$(run_lock_dir)
    run_lock_begin "$dir"
    lock_obs_owner handoff-read "$dir"
    text=${lob_out:-}
    if [ "$LOB_CLASS" = record ] && [ "$LOB_TOKEN" = "$t0" ] && [ "$LOB_PID" != "$$" ]; then
        RUN_LOCK_ERROR="run-lock: the recorded pid $LOB_PID is not this shell ($$)"
        RUN_LOCK_STAGE=arg
        run_lock_end
        return 1
    fi
    if [ "$(lock_obs_pgid handoff-group "$pgid")" != "$pgid" ]; then
        RUN_LOCK_ERROR="run-lock: pid $pgid does not lead a process group of its own"
        RUN_LOCK_STAGE=group
        run_lock_end
        return 1
    fi
    label=$(run_lock_text_field "$text" label)
    run_dir=$(run_lock_text_field "$text" run_dir)
    extra="label=$label"
    [ -z "$run_dir" ] || extra="$extra"$'\n'"run_dir=$run_dir"
    RUN_LOCK_HANDED=1
    LOCK_OWNER_EXTRA=$extra
    lock_hand_off "$dir" "$t0" "$pid" "$pgid"
    LOCK_OWNER_EXTRA=""
    if [ -n "$LHO_STAGE" ]; then
        RUN_LOCK_STAGE=$LHO_STAGE
        case "$LHO_STAGE" in
            verify)
                RUN_LOCK_G=$pgid
                [ "$LOB_CLASS" = record ] || RUN_LOCK_STAGE=verify-unreadable
                ;;
        esac
        RUN_LOCK_ERROR="run-lock: handoff-failed stage=${RUN_LOCK_STAGE%%-*}"
        run_lock_end
        return 1
    fi
    RUN_LOCK_G=$pgid
    LOCK_HELD_TOKEN=$LHO_TOKEN
    made=$(lock_obs_mkdir handoff-signal "$go")
    case "$made" in
        created)
            run_lock_end
            return 0
            ;;
        exists) RUN_LOCK_STAGE=abort ;;
        *)
            if [ -d "$go" ]; then RUN_LOCK_STAGE=abort; else RUN_LOCK_STAGE=signal; fi
            ;;
    esac
    RUN_LOCK_ERROR="run-lock: handoff-failed stage=$RUN_LOCK_STAGE"
    run_lock_end
    return 1
}

# run_lock_abort_settle <child> <ack> — prints what became of a child whose <go> was already there when
# the parent tried to make it: `acked` (the child saw <go> and made <ack>: it started), `withdrew` (it
# ended without making <ack>: it took the signal itself and withdrew), or `stuck` (neither within
# HANDOFF_SETTLE_SEC; the caller kills the pid and waits).
run_lock_abort_settle() {
    local child=$1 ack=$2 end
    end=$(( $(date +%s) + HANDOFF_SETTLE_SEC ))
    while :; do
        if [ -d "$ack" ]; then
            echo acked
            return 0
        fi
        if run_lock_child_ended "$child"; then
            if [ -d "$ack" ]; then echo acked; else echo withdrew; fi
            return 0
        fi
        if [ "$(date +%s)" -ge "$end" ]; then
            echo stuck
            return 0
        fi
        sleep 0.05 2>/dev/null || sleep 1
    done
}

# run_lock_release <token> — D12: the holder's own release, from the main shell that took the lock
# with its own $$. RUN_LOCK_RESULT: none | released | kept | deferred | (after needs-head, D5's)
# released | missing | deferred | kept | unknown | not-head. Returns 0 for none / released / kept /
# missing, 1 otherwise or when refused (a subshell; a lock taken with a pid that is not $$).
#   - A shell that holds nothing (a new shell, an inheritor, a second call) does nothing: none.
#   - A record whose pid is not this shell (UAT's T1: the server) is not removed here: needs-head,
#     and this runs D5 once for [<token>, T1] (run_lock_release_as_head).
run_lock_release() {
    local dir queue pend held rc t tokens=""
    RUN_LOCK_ERROR=""
    RUN_LOCK_RESULT=""
    run_lock_require_loaded || return 1
    if [ "${BASH_SUBSHELL:-0}" != 0 ]; then
        RUN_LOCK_ERROR="run-lock: run_lock_release must be called from the main shell that took the lock"
        return 1
    fi
    if [ -n "$RUN_LOCK_FOREIGN_PID" ]; then
        RUN_LOCK_ERROR="run-lock: this shell took the lock with a pid that is not its own; the record stays until that pid is gone and the next head recovers it"
        return 1
    fi
    dir=$(run_lock_dir)
    queue=$(machine_lock_queue_of "$dir")
    run_lock_begin "$dir"
    pend=$LOCK_PENDING_TOKEN
    held=$LOCK_HELD_TOKEN
    lock_release_held "$dir" "$1"
    rc=$?
    RUN_LOCK_RESULT=$LRH_RESULT
    if [ "$rc" -eq 2 ]; then
        for t in "$1" "$pend" "$held"; do
            [ -n "$t" ] || continue
            case " $tokens " in *" $t "*) ;; *) tokens="$tokens $t" ;; esac
        done
        # shellcheck disable=SC2086 # the tokens are [A-Za-z0-9-]+, split on blanks
        lock_release_as_head "$dir" "$queue" "${RUN_LOCK_HEAD_BUDGET:-10}" $tokens
        rc=$?
        RUN_LOCK_RESULT=$LRAH_RESULT
    fi
    if [ "$RUN_LOCK_RESULT" = released ] || [ "$RUN_LOCK_RESULT" = none ]; then
        RUN_LOCK_G=""
    fi
    run_lock_end
    return "$rc"
}

# run_lock_release_as_head <token>... — D5: the release by someone who is not the holder (UAT's
# `down`). Waits up to 10 s to be the head of the queue, then reads the owner once: a record under
# one of the tokens whose holder (pid, and the group when it names one) is gone is removed.
# RUN_LOCK_RESULT: released | missing | deferred | kept | unknown | not-head. 0 for released /
# missing.
run_lock_release_as_head() {
    local dir queue rc
    RUN_LOCK_ERROR=""
    RUN_LOCK_RESULT=""
    run_lock_require_loaded || return 1
    dir=$(run_lock_dir)
    queue=$(machine_lock_queue_of "$dir")
    run_lock_begin "$dir"
    lock_release_as_head "$dir" "$queue" "${RUN_LOCK_HEAD_BUDGET:-10}" "$@"
    rc=$?
    RUN_LOCK_RESULT=$LRAH_RESULT
    run_lock_end
    return "$rc"
}
