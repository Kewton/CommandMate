#!/bin/bash
#
# CommandMate - the one lock that UAT, the daily agent-health check and a
# manual `run.ts` share (Issue #3359).
#
# Sourced, not executed:
#
#   . "scripts/uat/run-lock.sh"
#   run_lock_acquire <label> <pid> <token> [<run dir>] || exit 1
#   ...
#   run_lock_release <token>
#
# The lock is a DIRECTORY made with `mkdir`, which is atomic: of two callers
# that race, exactly one gets it. Inside, `owner` holds pid / started_at /
# label / token (and run_dir for a UAT run). scripts/agent-health/main.ts takes
# the same directory through src/lib/agent-health/run-lock.ts; the two must
# agree on the path and on the owner format.
#
# Where: $CM_RUN_LOCK_DIR, else <os.tmpdir()>/commandmate-run.lock (bash reads
# os.tmpdir() as ${TMPDIR:-/tmp} without the trailing slash). Not under
# ~/.commandmate, because the test suite works there.
#
# A lock whose owner pid is dead may be taken over. The takeover renames the
# stale directory aside first (a rename of one source succeeds once), so two
# callers that both judged it stale cannot both end up holding it.
#
# A nested caller (daily.sh runs run.ts) passes the lock down with
# CM_RUN_LOCK_TOKEN: a holder whose token matches is the caller's own parent.
#
# bash 3.2 compatible (macOS /bin/bash).

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

# run_lock_pid_alive <pid>
run_lock_pid_alive() {
    case "$1" in
        '' | *[!0-9]*) return 1 ;;
    esac
    # ps as well: kill -0 fails with EPERM on another user's live process.
    kill -0 "$1" 2>/dev/null || ps -p "$1" >/dev/null 2>&1
}

# run_lock_write_owner <lock dir> <pid> <label> <token> [<run dir>]
# Written to a temp file and renamed, so a reader never sees half of it.
run_lock_write_owner() {
    local dir=$1 tmp
    tmp="$dir/owner.tmp.$$"
    {
        printf 'pid=%s\n' "$2"
        printf 'started_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        printf 'label=%s\n' "$3"
        printf 'token=%s\n' "$4"
        [ -z "${5:-}" ] || printf 'run_dir=%s\n' "$5"
    } >"$tmp" && mv -f "$tmp" "$dir/owner"
}

# run_lock_is_stale <lock dir> — true when the holder is gone. A directory
# without an owner file is one being made right now, unless it is older than a
# minute (its maker died between mkdir and writing the owner).
run_lock_is_stale() {
    local dir=$1 pid
    if [ ! -f "$dir/owner" ]; then
        [ -n "$(find "$dir" -maxdepth 0 -mmin +1 2>/dev/null)" ]
        return
    fi
    pid=$(run_lock_field "$dir" pid)
    ! run_lock_pid_alive "$pid"
}

# run_lock_take_stale <lock dir> — moves a stale lock aside and removes it.
# When the moved directory is not the one judged stale (somebody took over in
# between and made a fresh one), it is put back.
run_lock_take_stale() {
    local dir=$1 judged aside moved
    judged=$(run_lock_field "$dir" token)
    aside="$dir.stale.$$.$RANDOM"
    mv "$dir" "$aside" 2>/dev/null || return 0
    moved=$(run_lock_field "$aside" token)
    if [ "$moved" != "$judged" ] || ! run_lock_is_stale "$aside"; then
        [ -e "$dir" ] || mv "$aside" "$dir" 2>/dev/null || true
        return 0
    fi
    echo "run-lock: took over a stale lock (pid $(run_lock_field "$aside" pid), label $(run_lock_field "$aside" label))" >&2
    rm -rf "$aside"
}

# run_lock_holder <lock dir> — "pid N, label L, since T[, run dir D]".
run_lock_holder() {
    local dir=$1 run_dir
    run_dir=$(run_lock_field "$dir" run_dir)
    printf 'pid %s, label %s, since %s%s' \
        "$(run_lock_field "$dir" pid)" "$(run_lock_field "$dir" label)" \
        "$(run_lock_field "$dir" started_at)" "${run_dir:+, run dir $run_dir}"
}

# run_lock_acquire <label> <pid> <token> [<run dir>]
#
# Returns 0 when this caller now holds the lock (or its parent does: the
# holder's token is $CM_RUN_LOCK_TOKEN), 1 when somebody else does. On 1,
# RUN_LOCK_ERROR says who.
run_lock_acquire() {
    local label=$1 pid=$2 token=$3 run_dir=${4:-} dir attempt=0
    RUN_LOCK_ERROR=""
    dir=$(run_lock_dir)
    mkdir -p "$(dirname "$dir")" 2>/dev/null || true
    while [ $attempt -lt 5 ]; do
        attempt=$((attempt + 1))
        if mkdir "$dir" 2>/dev/null; then
            if run_lock_write_owner "$dir" "$pid" "$label" "$token" "$run_dir"; then
                return 0
            fi
            rm -rf "$dir"
            RUN_LOCK_ERROR="could not write the owner of $dir"
            return 1
        fi
        if [ -n "${CM_RUN_LOCK_TOKEN:-}" ] && [ "$(run_lock_field "$dir" token)" = "$CM_RUN_LOCK_TOKEN" ] &&
            ! run_lock_is_stale "$dir"; then
            return 0
        fi
        if run_lock_is_stale "$dir"; then
            run_lock_take_stale "$dir"
            continue
        fi
        RUN_LOCK_ERROR="another run holds $dir ($(run_lock_holder "$dir"))"
        return 1
    done
    # shellcheck disable=SC2034 # read by the caller
    RUN_LOCK_ERROR="could not take $dir after $attempt attempts"
    return 1
}

# run_lock_set_pid <token> <pid> — hands the lock to a longer-lived process
# (UAT: the server, so the lock outlives the `up` shell). Only for our token.
run_lock_set_pid() {
    local dir run_dir
    dir=$(run_lock_dir)
    [ "$(run_lock_field "$dir" token)" = "$1" ] || return 1
    run_dir=$(run_lock_field "$dir" run_dir)
    run_lock_write_owner "$dir" "$2" "$(run_lock_field "$dir" label)" "$1" "$run_dir"
}

# run_lock_release <token> — removes the lock only when it is ours.
run_lock_release() {
    local dir
    dir=$(run_lock_dir)
    [ -d "$dir" ] || return 0
    [ "$(run_lock_field "$dir" token)" = "$1" ] || return 0
    rm -rf "$dir"
}
