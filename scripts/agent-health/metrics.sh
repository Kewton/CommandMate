#!/usr/bin/env bash
# agent-health metrics entry point (Issue #3044).
#
#   bash scripts/agent-health/metrics.sh [--out <file>] [-- <metrics.ts args>...]
#
# Syncs this worktree the same way the daily check does
# (`daily.sh --sync-only`: fast-forward to origin/develop, npm install only
# when package-lock.json changed), then runs scripts/agent-health/metrics.ts.
# When the sync fails nothing is measured: a minimal metrics report (with
# completedAt and scriptErrors) is written and the exit is 2.
#
# stdout carries the AGENT_HEALTH_SYNC line of daily.sh; everything else goes
# to stderr. The sync's own minimal agent-health report goes to a temp file,
# never to today's agent-health report.
#
# bash 3.2 compatible (macOS /bin/bash).

cd "$(dirname "$0")/../.." || exit 2

OUT=""
RUN_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out)
      if [ $# -lt 2 ] || [ -z "$2" ]; then
        echo "metrics.sh: --out requires a path" >&2
        exit 2
      fi
      OUT="$2"
      shift 2
      ;;
    --out=*)
      OUT="${1#--out=}"
      shift
      ;;
    --)
      shift
      RUN_ARGS=("$@")
      break
      ;;
    *)
      echo "metrics.sh: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$OUT" ]; then
  OUT="$HOME/.commandmate/agent-health/metrics/$(TZ=Asia/Tokyo date +%F).json"
fi

STARTED_AT="$(node -e 'process.stdout.write(new Date().toISOString())')"
SYNC_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cm-agent-health-metrics-sync.XXXXXX")" || exit 2
SYNC_REPORT="$SYNC_DIR/sync-report.json"

bash scripts/agent-health/daily.sh --sync-only --out "$SYNC_REPORT"
SYNC_STATUS=$?

if [ "$SYNC_STATUS" -ne 0 ]; then
  AH_OUT="$OUT" AH_STARTED_AT="$STARTED_AT" AH_SYNC_REPORT="$SYNC_REPORT" AH_STATUS="$SYNC_STATUS" node -e '
    const fs = require("fs");
    const path = require("path");
    const env = process.env;
    let reason = "daily.sh --sync-only exited " + env.AH_STATUS;
    let commit = "unknown";
    try {
      const sync = JSON.parse(fs.readFileSync(env.AH_SYNC_REPORT, "utf8"));
      if (sync.sync && sync.sync.reason) reason = sync.sync.reason;
      if (sync.host && sync.host.commandmateCommit) commit = sync.host.commandmateCommit;
    } catch {}
    const report = {
      schemaVersion: 1,
      startedAt: env.AH_STARTED_AT,
      completedAt: new Date().toISOString(),
      metrics: [],
      queue: [],
      host: { commandmateCommit: commit, node: process.version },
      scriptErrors: ["sync: " + reason],
    };
    fs.mkdirSync(path.dirname(env.AH_OUT), { recursive: true });
    fs.writeFileSync(env.AH_OUT, JSON.stringify(report, null, 2) + "\n");
  ' || echo "metrics.sh: could not write the report to $OUT" >&2
  rm -rf "$SYNC_DIR"
  exit 2
fi
rm -rf "$SYNC_DIR"

# ${arr[@]+...} keeps an empty array from expanding to "" on bash 3.2.
npx tsx scripts/agent-health/metrics.ts --out "$OUT" ${RUN_ARGS[@]+"${RUN_ARGS[@]}"}
exit $?
