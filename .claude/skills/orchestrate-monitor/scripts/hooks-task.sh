#!/usr/bin/env bash
# hooks-task.sh — supply `read_task_status` from the CommandMate task ledger.
#
# Load it alongside hooks-git.sh when the run is contract-driven (Issue #1581):
#
#   monitor.sh --hooks .../hooks-git.sh --hooks .../hooks-task.sh <worktree-id> ...
#
# `commandmate task list <worktree-id>` is used rather than `task show <task-id>`
# because the monitor only ever knows worktree ids: `send --contract` prints the
# task id, but the supervising loop is started per worktree and would otherwise
# need that id threaded in per worker. `task list` answers from the worktree
# alone and sorts newest first, so row 1 is the contract currently in flight.
# The CLI is preferred over `GET /api/worktrees/:id/tasks` because it already
# owns base-URL and auth-token resolution — from a shell hook, curl would have to
# reproduce both.
#
# PRECONDITION: the newest task is the one this monitor run is watching. That
# holds for the standard recipe (create the contract, `send --contract`, then
# monitor). Wiring this hook onto a worktree whose newest task belongs to an
# earlier delegation makes the loop read that older verdict — the pane-state veto
# in verify-completion.sh only catches it while the worker is visibly busy.
#
# Env:
#   CM — commandmate launcher; inherited from monitor.sh when sourced by it.
CM=${CM:-"npx commandmate@latest"}

# read_task_status <worktree-id> -> a TaskStatus, or empty when unavailable.
#
# Empty is the "no answer" value on purpose, and it is what a server without the
# task ledger, a worktree with no contract, or an older CLI all produce: the
# caller then falls back to the capture heuristics instead of stalling. The
# status is echoed only if it is one of the statuses the product defines
# (src/lib/db/tasks-db.ts TASK_STATUSES), so an error message or a changed
# output format degrades to "no answer" rather than to a bogus verdict.
read_task_status() {
  local line status
  # Non-JSON output is deliberate: it is tab-separated (id, status, agent, gates,
  # title), which `cut` reads with no JSON parser and no jq dependency. When the
  # worktree has no tasks the CLI writes its notice to stderr and stdout is empty.
  line=$($CM task list "$1" --limit 1 2>/dev/null | head -n 1)
  status=$(printf '%s' "$line" | cut -f2)
  case "$status" in
    pending|running|waiting_input|verifying|succeeded|failed|not_started|cancelled)
      printf '%s\n' "$status"
      ;;
    *)
      printf '\n'
      ;;
  esac
}
