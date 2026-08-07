#!/usr/bin/env bash
# hooks-git.sh — reference completion hooks for monitor.sh (Issue #1533).
#
# monitor.sh ships `count_commits` / `count_uncommitted` as stubs returning 0 so
# the loop runs standalone. That also makes COMPLETE unreachable, because
# verify-completion.sh reads `commits=0 && uncommitted=0` as the signature of a
# task that was never sent. Source this file to wire both counters to the real
# checkouts:
#
#   monitor.sh --hooks .claude/skills/orchestrate-monitor/scripts/hooks-git.sh <id>...
#   MONITOR_HOOKS=.../hooks-git.sh monitor.sh <id>...
#
# Every git call is checked (Issue #1614). A counter that could not be measured
# still answers 0 — that is the value verify-completion.sh reads on the safe
# side, since `commits=0 && uncommitted=0` can only produce NOT_STARTED or
# WORKING, never a false COMPLETE — but it is never a *silent* 0 any more: each
# cause prints one line per worker naming the command that failed, so "git could
# not answer" and "the worker did nothing" are distinguishable in the log.
# Before this, `git ... | wc -l` handed the pipeline's exit code to `wc`, so a
# failing git was indistinguishable from a worker that had written nothing.
#
# Those diagnostics carry an `ERROR` / `WARN` token (Issue #1728) so they survive
# the `grep -Ei "…|ERROR|FAIL"` an operator pipes the monitor through; the
# level-less `monitor hooks: …` they used to start with did not, and the one
# report that says "these zeros are not measurements" was the easiest line in
# the stream to lose.
#
# Env:
#   MONITOR_HOOKS_BASE       base ref commits are counted against (default origin/develop)
#   MONITOR_HOOKS_REPO       repo whose `git worktree list` is searched (default .)
#   MONITOR_WORKTREE_ROOT    directory holding checkouts named exactly after the
#                            worktree-id; tried before the git search. Only an
#                            escape hatch since #1728 — the git search resolves
#                            directory-named ids on its own now — but still the
#                            answer for a checkout outside `git worktree list`
#                            or an id disambiguated with a path digest.
#   MONITOR_HOOKS_STATE_DIR  where the once-per-worker warning markers are kept
#                            (default: monitor.sh's STATE_DIR when sourced by it)
#
# bash 3.2 compatible and sourced into monitor.sh's shell under `set -u`, so every
# local is prefixed `mh__` and no loop variable is named `path`
# (feedback_zsh_path_loop_var_clobbers_path).
MONITOR_HOOKS_BASE=${MONITOR_HOOKS_BASE:-origin/develop}
MONITOR_HOOKS_REPO=${MONITOR_HOOKS_REPO:-.}
MONITOR_WORKTREE_ROOT=${MONITOR_WORKTREE_ROOT:-}

# Warning markers live in a directory, not in a shell variable: monitor.sh calls
# the counters through `$(...)`, i.e. in a subshell, so anything assigned in here
# is discarded before the next poll and a variable-based guard would reprint the
# same line every interval. A file survives the subshell. `$$` is the sourcing
# shell's pid (bash 3.2 does not update it inside `$(...)`), so standalone use is
# stable too; when monitor.sh sources this file its own STATE_DIR is used and the
# markers are removed with it on exit.
MONITOR_HOOKS_STATE_DIR=${MONITOR_HOOKS_STATE_DIR:-${STATE_DIR:-${TMPDIR:-/tmp}/cm-monitor-hooks-$$}}

# mh_report_once <level> <key> <message>
#
# Same granularity as the base-ref warning at the bottom of this file: one line
# per worker per cause, on stderr. Per-poll would be worse than silence — at a
# 20s interval it buries the stream it is supposed to make readable, and the
# cause does not change between polls. The key is `<worktree-id>.<cause>`, so two
# different failures on one worker are both reported and the same failure on two
# workers is reported for each. If the marker cannot be written the line repeats;
# loud is the correct degradation here.
#
# <level> is `ERROR` or `WARN`, and it is in the line for one reason: to survive
# the operator's filter (Issue #1728). The old prefix was `monitor hooks: …` with
# no level token at all, so the standard supervision pipe —
#   monitor.sh ... 2>&1 | grep -Ei "STALL|IDLE|...|ERROR|FAIL"
# — swallowed every one of these lines. "Nothing could be measured" was then
# indistinguishable from "the workers are quiet", which is the exact silent-0
# failure mode #1614 was opened for, arriving through its own warning channel.
#
#   ERROR — nothing at all could be measured for this worker: BOTH counters are
#           0 for want of an answer, so the STARTED guard in verify-completion.sh
#           is reading fabricated evidence.
#   WARN  — one counter degraded and the other still answers, so the guard keeps
#           a real signal.
mh_report_once() {
  mh__level=$1
  mh__key=$2
  shift 2
  mkdir -p "$MONITOR_HOOKS_STATE_DIR" 2>/dev/null || true
  mh__marker="$MONITOR_HOOKS_STATE_DIR/warned-$mh__key"
  [ -f "$mh__marker" ] && return 0
  : > "$mh__marker" 2>/dev/null || true
  echo "monitor hooks $mh__level: $*" >&2
  return 0
}

# mh_warn_once <key> <message> — one degraded counter, the other still answers.
mh_warn_once() {
  mh__warn_key=$1
  shift
  mh_report_once WARN "$mh__warn_key" "$@"
}

# mh_error_once <key> <message> — no measurement at all for this worker.
mh_error_once() {
  mh__err_key=$1
  shift
  mh_report_once ERROR "$mh__err_key" "$@"
}

# Same normalization as sanitizeIdSegment() in src/lib/git/worktree-id.ts, which
# both id schemes below are built on: lowercase, non-[a-z0-9-] -> '-', collapse
# runs, trim. Keep the two in step — a drift here resolves no path and every
# worker silently counts 0.
mh_slug() {
  printf '%s' "$1" | tr 'A-Z' 'a-z' \
    | sed -e 's/[^a-z0-9-]/-/g' -e 's/--*/-/g' -e 's/^-//' -e 's/-$//'
}

# mh_worktree_path <worktree-id> -> absolute checkout path, or nothing.
# Exit code: 0 when the search ran (a miss is empty output with 0), 1 when git
# itself failed and the answer is therefore unknown rather than "no match".
#
# No CLI endpoint returns a path for a worktree-id (WorktreeItem has no `path`
# field), so it is reconstructed from `git worktree list --porcelain`, whose
# records are
#   worktree <abs path>
#   HEAD <sha>
#   branch refs/heads/<name>      (absent when the checkout is detached or bare)
# separated by blank lines.
#
# THREE id schemes are matched, in this order (Issue #1728):
#
#   1. slug(basename(<abs path>))   — the DIRECTORY-derived scheme, and the only
#      one CommandMate mints ids with today: `deriveWorktreeId()` in
#      src/lib/git/worktree-id.ts is `sanitize(basename(resolvedPath))`, computed
#      once at first registration so an id survives every branch switch.
#   2. slug("<repo>-<branch>")      — the retired branch-derived scheme
#   3. slug("<branch>")               (`generateWorktreeId()` in worktrees.ts).
#
# Scheme 1 is the whole point of this function and it was missing: with only 2
# and 3, a repository that names worktree directories after issues rather than
# after branches resolved NOTHING — not one worker, not even the main worktree —
# and every poll answered `commits=0 uncommitted=0` for workers that had already
# committed. That is #1614's silent floor of 0 reached by a different road: git
# succeeds, the match fails. `<repo>` is the main worktree's directory name,
# which is the first record git prints, so 2 depends on parse order and 1 does
# not; 1 also works for a detached HEAD, which has no `branch` line at all.
#
# Directory first, branch second: a directory-derived id is what a live server
# hands out, so when both schemes hit (different worktrees, same slug) the live
# one must win rather than whichever record git happened to print last.
mh_worktree_path() {
  mh__wid=$1

  if [ -n "$MONITOR_WORKTREE_ROOT" ] && [ -d "$MONITOR_WORKTREE_ROOT/$mh__wid" ]; then
    printf '%s\n' "$MONITOR_WORKTREE_ROOT/$mh__wid"
    return 0
  fi

  # Captured into a variable first, then fed to the loop. The previous form
  # inlined the command substitution into `done <<EOF ... EOF`, where the exit
  # code is unreachable: a git that failed produced an empty record set that the
  # parser could not tell from "no worktree matches this id", and both counters
  # then returned 0 for a worker that had committed everything (Issue #1614).
  mh__list=$(git -C "$MONITOR_HOOKS_REPO" worktree list --porcelain 2>/dev/null)
  mh__rc=$?
  if [ "$mh__rc" -ne 0 ]; then
    mh_error_once "$mh__wid.worktree-list" \
      "[$mh__wid] 'git -C $MONITOR_HOOKS_REPO worktree list --porcelain' failed (exit $mh__rc); commit and change counts for this worker are UNKNOWN and reported as 0 — they are not evidence of an idle worker (set MONITOR_HOOKS_REPO or MONITOR_WORKTREE_ROOT)"
    return 1
  fi

  mh__dir=""
  mh__repo=""
  mh__hit_dir=""
  mh__hit_branch=""
  mh__dupe=""
  while IFS= read -r mh__line; do
    case "$mh__line" in
      "worktree "*)
        mh__dir=${mh__line#worktree }
        mh__dirslug=$(mh_slug "$(basename "$mh__dir")")
        # First record = the main worktree; its basename is the repository name.
        if [ -z "$mh__repo" ]; then
          mh__repo=$mh__dirslug
        fi
        if [ "$mh__wid" = "$mh__dirslug" ]; then
          if [ -n "$mh__hit_dir" ]; then
            mh__dupe="$mh__hit_dir, $mh__dir"
          else
            mh__hit_dir=$mh__dir
          fi
        fi
        ;;
      "branch refs/heads/"*)
        mh__branch=$(mh_slug "${mh__line#branch refs/heads/}")
        if [ "$mh__wid" = "$mh__repo-$mh__branch" ] || [ "$mh__wid" = "$mh__branch" ]; then
          [ -z "$mh__hit_branch" ] && mh__hit_branch=$mh__dir
        fi
        ;;
    esac
  done <<EOF
$mh__list
EOF

  # Two checkouts whose directories share a name. CommandMate disambiguates this
  # at mint time by appending a digest of the path (`<base>-<sha256[0:8]>`), so
  # the bare basename belongs to exactly one of them and this scan cannot tell
  # which. Counting the wrong checkout is worse than counting none, but refusing
  # to answer would sink both counters — so answer, and say so, loudly.
  if [ -n "$mh__dupe" ]; then
    mh_warn_once "$mh__wid.ambiguous-basename" \
      "[$mh__wid] more than one worktree has this directory name ($mh__dupe); counting the first — set MONITOR_WORKTREE_ROOT to the parent of the checkout you mean if that is the wrong one"
  fi

  if [ -n "$mh__hit_dir" ]; then
    printf '%s\n' "$mh__hit_dir"
  elif [ -n "$mh__hit_branch" ]; then
    printf '%s\n' "$mh__hit_branch"
  fi
  return 0
}

# mh_resolve <worktree-id> -> checkout path on stdout, 0 on success.
# Returns 1 after reporting why no path is available. The "no match" case gets a
# warning of its own because it sinks BOTH counters at once, which is the same
# silent floor of 0 the base-ref warning below was written for.
mh_resolve() {
  mh__wt=$(mh_worktree_path "$1")
  mh__resolve_rc=$?
  if [ "$mh__resolve_rc" -ne 0 ]; then
    return 1
  fi
  if [ -z "$mh__wt" ]; then
    mh_error_once "$1.no-checkout" \
      "[$1] no checkout resolved in '$MONITOR_HOOKS_REPO'; both counters report 0 because nothing was measured, not because the worker did nothing (check the worktree-id or set MONITOR_WORKTREE_ROOT)"
    return 1
  fi
  printf '%s\n' "$mh__wt"
  return 0
}

# mh_count_lines <text> — how many non-empty lines the caller captured.
#
# `grep -c .`, not `wc -l`: the count is taken from a variable, and `$()` strips
# the trailing newline, so `printf '%s' "$out" | wc -l` reports one line fewer
# than there are (measured on bash 3.2.57: 1 record -> 0, 2 -> 1). `grep -c`
# counts matching lines regardless of the final newline. It exits 1 when nothing
# matched while still printing `0`, hence `|| true` — `|| echo 0` would append a
# second line and emit "0\n0" (the shape that once walked straight through a
# replacement guard, feedback_sed_grep_guard_false_pass).
mh_count_lines() {
  printf '%s' "$1" | grep -c . || true
}

# Commits the worker has landed on its branch since it forked from the base.
count_commits() {
  mh__wt=$(mh_resolve "$1") || { echo 0; return 0; }

  if ! git -C "$mh__wt" rev-parse --verify --quiet "$MONITOR_HOOKS_BASE^{commit}" >/dev/null 2>&1; then
    mh_warn_once "$1.base-ref" \
      "[$1] base ref '$MONITOR_HOOKS_BASE' does not resolve in '$mh__wt'; the commit count is UNKNOWN and reported as 0 (set MONITOR_HOOKS_BASE)"
    echo 0
    return 0
  fi

  mh__out=$(git -C "$mh__wt" log --oneline "$MONITOR_HOOKS_BASE..HEAD" 2>/dev/null)
  mh__rc=$?
  if [ "$mh__rc" -ne 0 ]; then
    mh_warn_once "$1.log" \
      "[$1] 'git -C $mh__wt log --oneline $MONITOR_HOOKS_BASE..HEAD' failed (exit $mh__rc); the commit count is UNKNOWN and reported as 0"
    echo 0
    return 0
  fi
  mh_count_lines "$mh__out"
}

# Work in progress: anything `git status` would show, staged or not, including
# untracked files. A worker that did *anything* leaves at least one of these or a
# commit behind, which is exactly the evidence the STARTED guard is looking for.
count_uncommitted() {
  mh__wt=$(mh_resolve "$1") || { echo 0; return 0; }

  mh__out=$(git -C "$mh__wt" status --porcelain 2>/dev/null)
  mh__rc=$?
  if [ "$mh__rc" -ne 0 ]; then
    mh_warn_once "$1.status" \
      "[$1] 'git -C $mh__wt status --porcelain' failed (exit $mh__rc); the uncommitted-change count is UNKNOWN and reported as 0"
    echo 0
    return 0
  fi
  mh_count_lines "$mh__out"
}

# One loud warning instead of a silent floor of 0: an unresolvable base makes
# count_commits return 0 forever, and a worker that committed everything then has
# no uncommitted changes either — it would be reported NOT_STARTED at the end of
# a perfectly good run. Emitted at source time so the misconfiguration is visible
# before the first poll; the per-worker warning above covers the same cause seen
# from inside a worker's own checkout.
if ! git -C "$MONITOR_HOOKS_REPO" rev-parse --verify --quiet "$MONITOR_HOOKS_BASE^{commit}" >/dev/null 2>&1; then
  echo "monitor hooks WARN: base ref '$MONITOR_HOOKS_BASE' does not resolve in '$MONITOR_HOOKS_REPO'; commit counts will be 0 (set MONITOR_HOOKS_BASE)" >&2
fi
