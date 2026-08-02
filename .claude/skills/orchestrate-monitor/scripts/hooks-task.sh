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

# read_task_status <worktree-id> -> a TaskStatus, `unavailable`, or empty.
#
# Three answers, because they mean three different things and collapsing them is
# how a degraded run passes for a healthy one (Issue #1613):
#
#   <status>      the ledger answered. One of TASK_STATUSES (src/lib/db/tasks-db.ts):
#                 pending running waiting_input verifying succeeded failed
#                 not_started cancelled.
#   ""            the ledger answered and this worktree has no task — a
#                 contract-less delegation. The pre-task behaviour, silently.
#   unavailable   the ledger could not be asked at all. This is the version gate:
#                 monitor.sh reports it once per worker and then runs on the
#                 capture heuristics. `unavailable` is deliberately not a
#                 TaskStatus, so a monitor.sh that predates this file passes it
#                 straight to verify-completion.sh, where it falls through to the
#                 same heuristics instead of deciding anything.
#
# Measured against develop @a46845c7 (2026-08-01), read-only calls only:
#   worktree unknown to the server   exit 99, stderr `Resource not found. Check the
#                                    worktree ID.` (404 -> UNEXPECTED_ERROR,
#                                    src/cli/utils/api-client.ts)
#   server not running               exit 1,  stderr `Server is not running. Start it
#                                    with: commandmate start` (DEPENDENCY_ERROR)
#   known worktree, zero tasks       exit 0,  notice on stderr and stdout empty
#                                    (src/cli/commands/task.ts) — the empty case above,
#                                    which is why "empty stdout" must NOT mean failure
# A CommandMate that predates the task ledger fails here too: `src/cli/commands/task.ts`
# exists only on develop, so v0.15.0 / v0.16.0 have no `task` subcommand at all. Note
# that `commandmate task --help` is not a usable probe — an older CLI prints the root
# help and exits 0, so only running the real subcommand distinguishes the two.
read_task_status() {
  ht__line=""
  ht__status=""
  ht__rc=0

  # Non-JSON output is deliberate: it is tab-separated (id, status, agent, gates,
  # title), which `cut` reads with no JSON parser and no jq dependency. The
  # assignment keeps the exit code — piping into `head` here would hand `$?` to
  # head and erase every failure mode listed above.
  ht__line=$($CM task list "$1" --limit 1 2>/dev/null)
  ht__rc=$?
  if [ "$ht__rc" -ne 0 ]; then
    printf 'unavailable\n'
    return 0
  fi

  # When the worktree has no tasks the CLI writes its notice to stderr and stdout
  # is empty, so this is empty too — the contract-less case.
  ht__status=$(printf '%s\n' "$ht__line" | head -n 1 | cut -f2)
  case "$ht__status" in
    pending|running|waiting_input|verifying|succeeded|failed|not_started|cancelled)
      printf '%s\n' "$ht__status"
      ;;
    *)
      # An unrecognised value is treated as "no answer" rather than passed on: a
      # changed output format must degrade to the heuristics, not to a verdict
      # nobody defined.
      printf '\n'
      ;;
  esac
}
