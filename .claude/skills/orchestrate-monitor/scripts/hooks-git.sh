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
# Env:
#   MONITOR_HOOKS_BASE     base ref commits are counted against (default origin/develop)
#   MONITOR_HOOKS_REPO     repo whose `git worktree list` is searched (default .)
#   MONITOR_WORKTREE_ROOT  directory holding checkouts named exactly after the
#                          worktree-id; tried before the git search
#
# bash 3.2 compatible and sourced into monitor.sh's shell under `set -u`, so every
# local is prefixed `mh__` and no loop variable is named `path`
# (feedback_zsh_path_loop_var_clobbers_path).
MONITOR_HOOKS_BASE=${MONITOR_HOOKS_BASE:-origin/develop}
MONITOR_HOOKS_REPO=${MONITOR_HOOKS_REPO:-.}
MONITOR_WORKTREE_ROOT=${MONITOR_WORKTREE_ROOT:-}

# Same normalization as generateWorktreeId() in src/lib/git/worktrees.ts, which is
# what produces the ids monitor.sh is given: lowercase, non-[a-z0-9-] -> '-',
# collapse runs, trim. Keep the two in step — a drift here resolves no path and
# every worker silently counts 0.
mh_slug() {
  printf '%s' "$1" | tr 'A-Z' 'a-z' \
    | sed -e 's/[^a-z0-9-]/-/g' -e 's/--*/-/g' -e 's/^-//' -e 's/-$//'
}

# mh_worktree_path <worktree-id> -> absolute checkout path, or nothing.
#
# The id is `<repo>-<branch>` slugified, and no CLI endpoint returns a path for
# it (WorktreeItem has no `path` field), so it is reconstructed from
# `git worktree list --porcelain`, whose records are
#   worktree <abs path>
#   HEAD <sha>
#   branch refs/heads/<name>
# separated by blank lines. `<repo>` is the main worktree's directory name, which
# is the first record git prints.
mh_worktree_path() {
  mh__wid=$1

  if [ -n "$MONITOR_WORKTREE_ROOT" ] && [ -d "$MONITOR_WORKTREE_ROOT/$mh__wid" ]; then
    printf '%s\n' "$MONITOR_WORKTREE_ROOT/$mh__wid"
    return 0
  fi

  mh__dir=""
  mh__repo=""
  mh__hit=""
  while IFS= read -r mh__line; do
    case "$mh__line" in
      "worktree "*)
        mh__dir=${mh__line#worktree }
        # First record = the main worktree; its basename is the repository name.
        if [ -z "$mh__repo" ]; then
          mh__repo=$(mh_slug "$(basename "$mh__dir")")
        fi
        ;;
      "branch refs/heads/"*)
        mh__branch=$(mh_slug "${mh__line#branch refs/heads/}")
        if [ "$mh__wid" = "$mh__repo-$mh__branch" ] || [ "$mh__wid" = "$mh__branch" ]; then
          mh__hit=$mh__dir
        fi
        ;;
    esac
  done <<EOF
$(git -C "$MONITOR_HOOKS_REPO" worktree list --porcelain 2>/dev/null)
EOF

  [ -n "$mh__hit" ] && printf '%s\n' "$mh__hit"
  return 0
}

# Commits the worker has landed on its branch since it forked from the base.
count_commits() {
  mh__wt=$(mh_worktree_path "$1")
  if [ -z "$mh__wt" ] \
    || ! git -C "$mh__wt" rev-parse --verify --quiet "$MONITOR_HOOKS_BASE^{commit}" >/dev/null 2>&1
  then
    echo 0
    return 0
  fi
  git -C "$mh__wt" log --oneline "$MONITOR_HOOKS_BASE..HEAD" 2>/dev/null \
    | wc -l | tr -d '[:space:]'
}

# Work in progress: anything `git status` would show, staged or not, including
# untracked files. A worker that did *anything* leaves at least one of these or a
# commit behind, which is exactly the evidence the STARTED guard is looking for.
count_uncommitted() {
  mh__wt=$(mh_worktree_path "$1")
  if [ -z "$mh__wt" ]; then
    echo 0
    return 0
  fi
  git -C "$mh__wt" status --porcelain 2>/dev/null | wc -l | tr -d '[:space:]'
}

# One loud warning instead of a silent floor of 0: an unresolvable base makes
# count_commits return 0 forever, and a worker that committed everything then has
# no uncommitted changes either — it would be reported NOT_STARTED at the end of
# a perfectly good run.
if ! git -C "$MONITOR_HOOKS_REPO" rev-parse --verify --quiet "$MONITOR_HOOKS_BASE^{commit}" >/dev/null 2>&1; then
  echo "monitor hooks: base ref '$MONITOR_HOOKS_BASE' does not resolve in '$MONITOR_HOOKS_REPO'; commit counts will be 0 (set MONITOR_HOOKS_BASE)" >&2
fi
