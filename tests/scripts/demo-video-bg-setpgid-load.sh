#!/bin/bash
#
# Load reproduction for Issue #3935: demo-video env-up.sh's background boot
# (`set -m` … `( exec … ) >log 2>&1 &` … `set +m`) sometimes makes bash print
# `child setpgid (N to N): Operation not permitted` on the caller's stderr.
#
# Runs the boot shape with a cheap command (`sleep 0`) many times in several
# parallel loops, in two forms:
#   old — the shape before #3935: nothing around `set -m` … `set +m`
#   new — the shape env-up.sh uses now: `{ set -m … set +m; } 2>>"$LOG_FILE"`
# and counts the runs whose stderr was not empty. It also checks, for every
# run, that the background job ended up leading its own process group.
#
# Manual only (too slow for the unit suite at the default count). The `new`
# count must be 0; the `old` count is the positive control and is usually
# non-zero on macOS under load (it is a race, so 0 is possible on a quiet host
# or on Linux).
#
# Usage:
#   ./tests/scripts/demo-video-bg-setpgid-load.sh [iterations-per-loop] [parallel-loops]
#   (defaults: 1500 8)
#
# Exit codes:
#   0 - the `new` form never wrote to stderr and every PGID was right
#   1 - otherwise

set -u

ITERATIONS="${1:-1500}"
PARALLEL="${2:-8}"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/demo-video-setpgid.XXXXXX")" || exit 1
trap 'rm -rf "$WORK_DIR"' EXIT

# One loop: prints "<stderr-hits> <bad-pgid>" for its iterations.
run_loop() {
  local form="$1" loop="$2" i hits=0 badpgid=0 err log pid pgid
  for ((i = 0; i < ITERATIONS; i++)); do
    err="$WORK_DIR/$form-$loop.err"
    log="$WORK_DIR/$form-$loop.log"
    : >"$log"
    {
      if [ "$form" = new ]; then
        {
          set -m
          (
            exec sleep 0
          ) >>"$log" 2>&1 &
          pid=$!
          set +m
        } 2>>"$log"
      else
        set -m
        (
          exec sleep 0
        ) >>"$log" 2>&1 &
        pid=$!
        set +m
      fi
      pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
      # The job may already be gone (sleep 0); only a live, wrong group counts.
      if [ -n "$pgid" ] && [ "$pgid" != "$pid" ]; then
        badpgid=$((badpgid + 1))
      fi
      wait "$pid" 2>/dev/null
    } 2>"$err"
    [ -s "$err" ] && hits=$((hits + 1))
  done
  printf '%s %s\n' "$hits" "$badpgid"
}

run_form() {
  local form="$1" loop total_hits=0 total_bad=0 hits bad
  for ((loop = 0; loop < PARALLEL; loop++)); do
    run_loop "$form" "$loop" >"$WORK_DIR/$form-$loop.result" &
  done
  wait
  for ((loop = 0; loop < PARALLEL; loop++)); do
    read -r hits bad <"$WORK_DIR/$form-$loop.result"
    total_hits=$((total_hits + hits))
    total_bad=$((total_bad + bad))
  done
  printf '%s: %d runs, stderr not empty in %d, wrong PGID in %d\n' \
    "$form" $((ITERATIONS * PARALLEL)) "$total_hits" "$total_bad"
  [ "$form" = old ] || { [ "$total_hits" -eq 0 ] && [ "$total_bad" -eq 0 ]; }
}

printf 'bash %s on %s, %d loops x %d iterations\n' "$BASH_VERSION" "$(uname -sm)" "$PARALLEL" "$ITERATIONS"
run_form old
run_form new
