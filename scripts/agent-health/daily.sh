#!/usr/bin/env bash
# agent-health daily entry point (Issue #2924).
#
#   bash scripts/agent-health/daily.sh [--out <file>] [--sync-only] [-- <run.ts args>...]
#
# Syncs this worktree to origin/develop, reinstalls dependencies only when
# package-lock.json changed, then runs scripts/agent-health/run.ts. When the
# sync fails the check is NOT run: a minimal report (with completedAt, so the
# watchdog does not mistake it for a missing run) is written and the exit is 2.
#
# stdout carries exactly one AGENT_HEALTH_SYNC line from this script; git and
# npm output goes to stderr.
#
# bash 3.2 compatible (macOS /bin/bash): no associative arrays, no mapfile.

cd "$(dirname "$0")/../.." || exit 2

OUT=""
SYNC_ONLY=0
RUN_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out)
      if [ $# -lt 2 ] || [ -z "$2" ]; then
        echo "daily.sh: --out requires a path" >&2
        exit 2
      fi
      OUT="$2"
      shift 2
      ;;
    --out=*)
      OUT="${1#--out=}"
      shift
      ;;
    --sync-only)
      SYNC_ONLY=1
      shift
      ;;
    --)
      shift
      RUN_ARGS=("$@")
      break
      ;;
    *)
      echo "daily.sh: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$OUT" ]; then
  OUT="$HOME/.commandmate/agent-health/reports/$(TZ=Asia/Tokyo date +%F).json"
fi

STARTED_AT="$(node -e 'process.stdout.write(new Date().toISOString())')"
BEFORE="$(git rev-parse HEAD)" || exit 2

# Writes the minimal report and exits 2. $1 = reason.
fail_sync() {
  reason="$1"
  echo "AGENT_HEALTH_SYNC status=failed reason=${reason} before=$(printf '%s' "$BEFORE" | cut -c1-8)"
  AH_OUT="$OUT" AH_STARTED_AT="$STARTED_AT" AH_BEFORE="$BEFORE" AH_REASON="$reason" node -e '
    const fs = require("fs");
    const path = require("path");
    const env = process.env;
    const report = {
      schemaVersion: 1,
      startedAt: env.AH_STARTED_AT,
      completedAt: new Date().toISOString(),
      host: { commandmateCommit: env.AH_BEFORE, node: process.version },
      tools: [],
      safety: { globalConfigRestored: [], tmuxSocket: "cm-agent-health" },
      scriptErrors: ["sync: " + env.AH_REASON],
      sync: { status: "failed", before: env.AH_BEFORE, after: env.AH_BEFORE, reason: env.AH_REASON },
    };
    fs.mkdirSync(path.dirname(env.AH_OUT), { recursive: true });
    fs.writeFileSync(env.AH_OUT, JSON.stringify(report, null, 2) + "\n");
  ' || echo "daily.sh: could not write the report to $OUT" >&2
  exit 2
}

# 4. Never pull over local edits to tracked files.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short --untracked-files=no >&2
  fail_sync "dirty-worktree"
fi

# 5. Fast-forward only. git's stdout goes to stderr; its stderr is captured
#    (and echoed) so the last line can be the failure reason.
exec 3>&2
PULL_ERR="$(git pull --ff-only origin develop 2>&1 1>&3)"
PULL_STATUS=$?
exec 3>&-
if [ -n "$PULL_ERR" ]; then
  printf '%s\n' "$PULL_ERR" >&2
fi
if [ "$PULL_STATUS" -ne 0 ]; then
  LAST_LINE="$(printf '%s\n' "$PULL_ERR" | sed '/^[[:space:]]*$/d' | tail -n 1)"
  fail_sync "pull-failed: ${LAST_LINE:-git pull exited $PULL_STATUS}"
fi

AFTER="$(git rev-parse HEAD)" || fail_sync "pull-failed: git rev-parse HEAD failed"

# 7. Compare the two commits directly (HEAD@{1} points at an older move on a no-op day).
NPM_INSTALL="skipped"
if ! git diff --quiet "$BEFORE" "$AFTER" -- package-lock.json; then
  NPM_INSTALL_CMD="${AGENT_HEALTH_NPM_INSTALL_CMD:-npm install --include=dev}"
  # A subshell, so an `exit` in the override cannot end this script.
  if ! (eval "$NPM_INSTALL_CMD") >&2; then
    fail_sync "npm-install-failed"
  fi
  NPM_INSTALL="done"
fi

echo "AGENT_HEALTH_SYNC status=ok before=$(printf '%s' "$BEFORE" | cut -c1-8) after=$(printf '%s' "$AFTER" | cut -c1-8) npm_install=${NPM_INSTALL}"

if [ "$SYNC_ONLY" -eq 1 ]; then
  exit 0
fi

# ${arr[@]+...} keeps an empty array from expanding to "" on bash 3.2.
npx tsx scripts/agent-health/run.ts --out "$OUT" --synced-from "$BEFORE" ${RUN_ARGS[@]+"${RUN_ARGS[@]}"}
exit $?
