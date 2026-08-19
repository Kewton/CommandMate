#!/usr/bin/env bash
#
# env-up.sh — bring up an isolated CommandMate instance for demo recording.
#
# Isolation rests on four things that must stay together:
#   1. A dedicated port. Port 3000 (a developer's live instance) is refused.
#   2. CM_DB_PATH pinned under $HOME, so no demo run can touch the real cm.db.
#      $HOME rather than a temp dir because validateDbPath rejects /tmp and /var
#      as system directories (src/config/system-directories.ts).
#   3. WORKTREE_REPOS pinned to a throwaway seed repository. WORKTREE_REPOS is
#      the *only* discovery source (src/lib/git/worktrees.ts getRepositoryPaths);
#      CM_ROOT_DIR is a container path and is deliberately not scanned (#1328).
#   4. The server runs in its own process group, so env-down.sh can stop exactly
#      what this script started without pattern-killing anything else.
#
# bash 3.2 compatible: no associative arrays, no mapfile.

set -u

FORBIDDEN_PORT=3000
DEFAULT_PORT=3399
PORT_SCAN_LIMIT=40

die() {
  printf 'env-up: %s\n' "$1" >&2
  exit 1
}

log() {
  printf 'env-up: %s\n' "$1"
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# The skill is installed at <repo>/.claude/skills/demo-video/scripts and
# byte-identically at <repo>/.agents/skills/demo-video/scripts — both are four
# levels below the repository root, so one expression serves both copies.
REPO_ROOT="${CM_DEMO_REPO_ROOT:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"
[ -f "$REPO_ROOT/server.ts" ] || die "no server.ts under $REPO_ROOT (set CM_DEMO_REPO_ROOT)"

STATE_DIR="${CM_DEMO_HOME:-$HOME/.commandmate-demo}"
case "$STATE_DIR" in
  "$HOME"/*) : ;;
  *) die "CM_DEMO_HOME must live under \$HOME (got '$STATE_DIR'); the DB path validator rejects /tmp and /var" ;;
esac

SEED_ROOT="$STATE_DIR/seed"
SEED_REPO="$SEED_ROOT/cmdemo-app"
# A second throwaway repository, deliberately left out of WORKTREE_REPOS so the
# boot sync never discovers it. The add-repository scene registers it on camera.
SEED_REPO_2="$SEED_ROOT/cmdemo-docs"
# The worktree directories. Named once here because their *basenames* are the
# worktree IDs the server will mint (see derive_worktree_id below), so the
# directory name and the ID can never drift apart.
WT_DARK_MODE="$SEED_ROOT/wt-dark-mode"
WT_LOGIN_ERROR="$SEED_ROOT/wt-login-error"
WT_API_CACHE="$SEED_ROOT/wt-api-cache"
DB_PATH="$STATE_DIR/cm.db"
LOG_FILE="$STATE_DIR/server.log"
STATE_FILE="$STATE_DIR/state.env"
VIDEO_DIR="$STATE_DIR/videos"
# Every tmux session this run creates is appended here by fake-agent.sh, and
# env-down.sh kills exactly what it finds. Teardown is driven by a record of
# what was started, never by a `mcbd-*` sweep: this tmux server also holds the
# developer's own sessions.
SESSIONS_FILE="$STATE_DIR/sessions"
READY_TIMEOUT="${CM_DEMO_READY_TIMEOUT:-180}"

require() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}
require git
require curl
require awk
# The `unit` gate the contract-verify take films runs `node --test` inside the
# seed worktree, and this script proves it green before the server ever sees it.
require node

if [ -f "$STATE_FILE" ]; then
  die "$STATE_FILE already exists — run env-down.sh first (or delete it if the previous run crashed)"
fi

# ---------------------------------------------------------------- port -------

port_free() {
  # A successful connect means something is already listening.
  if (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

pick_port() {
  local requested="${CM_DEMO_PORT:-}"
  local candidate offset
  if [ -n "$requested" ]; then
    case "$requested" in
      ''|*[!0-9]*) die "CM_DEMO_PORT must be an integer, got '$requested'" ;;
    esac
    [ "$requested" -ne "$FORBIDDEN_PORT" ] || die "CM_DEMO_PORT must not be $FORBIDDEN_PORT: that is the default CommandMate port and a live instance would be driven by the demo"
    [ "$requested" -ge 1024 ] || die "CM_DEMO_PORT must be >= 1024, got '$requested'"
    port_free "$requested" || die "port $requested is already in use"
    printf '%s' "$requested"
    return 0
  fi
  offset=0
  while [ "$offset" -lt "$PORT_SCAN_LIMIT" ]; do
    candidate=$((DEFAULT_PORT + offset))
    offset=$((offset + 1))
    [ "$candidate" -ne "$FORBIDDEN_PORT" ] || continue
    if port_free "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  die "no free port found in ${DEFAULT_PORT}..$((DEFAULT_PORT + PORT_SCAN_LIMIT - 1))"
}

# ---------------------------------------------------------------- seed -------

seed_commit() {
  git -C "$SEED_REPO" -c user.name='CommandMate Demo' -c user.email='demo@example.invalid' \
    commit -q -m "$1"
}

create_second_seed_repo() {
  mkdir -p "$SEED_REPO_2"
  git -C "$SEED_REPO_2" init -q
  git -C "$SEED_REPO_2" symbolic-ref HEAD refs/heads/main
  printf '# cmdemo-docs\n\nSecond throwaway repository, registered on camera.\n' >"$SEED_REPO_2/README.md"
  git -C "$SEED_REPO_2" add -A
  git -C "$SEED_REPO_2" -c user.name='CommandMate Demo' -c user.email='demo@example.invalid' \
    commit -q -m 'docs: initial notes'
}

# Everything the contract-verify and slash-palette takes read out of the seed
# (Issue #1810). Committed on `main`, *before* the worktrees branch off, for one
# reason: the contract declares `scope.allow: [src/**, test/**]`, and the scope
# gate reconciles the whole `main..HEAD` diff. A verify.yaml or a command file
# committed on the feature branch would be a change outside the allow list, so
# the take would film its own harness failing the gate.
#
# The test is real, and it is real *against the uncommitted work*: on `main`,
# `src/theme.ts` has no `resolveTheme` and this file fails. It passes only in
# the worktree that carries the change, which is exactly what makes the `unit`
# gate in the footage a gate and not a decoration.
seed_verification_assets() {
  mkdir -p "$SEED_REPO/test" "$SEED_REPO/.commandmate/tasks" "$SEED_REPO/.claude/commands"

  cat >"$SEED_REPO/test/theme.test.mjs" <<'NODETEST'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The source is TypeScript, so it is read rather than imported: node:test has
// no loader here and the demo repository has no build step.
const source = readFileSync(new URL('../src/theme.ts', import.meta.url), 'utf8');

test('theme.ts exposes the storage key the app reads', () => {
  assert.match(source, /THEME_STORAGE_KEY/);
});

test('theme.ts resolves a stored value to a theme', () => {
  assert.match(source, /export function resolveTheme/);
  assert.match(source, /stored === "dark" \? "dark" : "light"/);
});
NODETEST

  cat >"$SEED_REPO/.commandmate/verify.yaml" <<'VERIFY'
# Demo seed verification config. The gate below is executed for real by the
# server during the contract-verify take; nothing here is stubbed.
version: 1
gates:
  - id: unit
    command: "node --test"
    timeoutSec: 120
options:
  baseRef: main
  skipInPrimaryCheckout: false
VERIFY

  cat >"$SEED_REPO/.commandmate/tasks/dark-mode.yaml" <<'CONTRACT'
version: 1
title: "Add a dark mode toggle"
goal: |
  Add a dark mode toggle to the header of the demo application.
  Keep the change inside src/ and test/.
scope:
  allow:
    - "src/**"
    - "test/**"
verify:
  gates:
    - unit
autoYes:
  # Quoted: the YAML reader is 1.2, where bare `off` is the string "off", but a
  # 1.1 reader would make it `false` and the contract would then declare no
  # policy at all instead of prohibiting auto-answering.
  mode: "off"
success:
  requireWorkEvidence: true
  requireScopeClean: true
CONTRACT

  # The slash-palette take reads the worktree's own command and Skill
  # directories through the product's loaders, so the seed carries the real
  # files rather than stand-ins. `cmate-verify` is copied into both install
  # roots because that is how it ships (byte-identical, #1553).
  for command_name in work-plan create-pr tdd-impl; do
    if [ -f "$REPO_ROOT/.claude/commands/$command_name.md" ]; then
      cp "$REPO_ROOT/.claude/commands/$command_name.md" "$SEED_REPO/.claude/commands/$command_name.md"
    else
      die "missing $REPO_ROOT/.claude/commands/$command_name.md — the slash-palette scene has nothing to show"
    fi
  done
  for skill_root in .claude .agents; do
    [ -d "$REPO_ROOT/$skill_root/skills/cmate-verify" ] \
      || die "missing $REPO_ROOT/$skill_root/skills/cmate-verify — the slash-palette scene has nothing to show"
    mkdir -p "$SEED_REPO/$skill_root/skills"
    cp -R "$REPO_ROOT/$skill_root/skills/cmate-verify" "$SEED_REPO/$skill_root/skills/cmate-verify"
  done

  git -C "$SEED_REPO" add -A
  seed_commit 'chore: verification config, contract and agent commands'
}

create_seed_repo() {
  rm -rf "$SEED_ROOT"
  mkdir -p "$SEED_REPO"
  git -C "$SEED_REPO" init -q
  # `git init -b` needs git >= 2.28; setting HEAD before the first commit works
  # on every version.
  git -C "$SEED_REPO" symbolic-ref HEAD refs/heads/main

  mkdir -p "$SEED_REPO/src"
  printf '# cmdemo-app\n\nThrowaway repository used to record CommandMate demo footage.\n' >"$SEED_REPO/README.md"
  printf 'export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n' >"$SEED_REPO/src/greet.ts"
  git -C "$SEED_REPO" add -A
  seed_commit 'feat: initial demo app'

  printf 'export const THEME_STORAGE_KEY = "cmdemo.theme";\n' >"$SEED_REPO/src/theme.ts"
  git -C "$SEED_REPO" add -A
  seed_commit 'feat: add theme storage key'

  seed_verification_assets

  git -C "$SEED_REPO" worktree add -q -b feature/demo-dark-mode "$WT_DARK_MODE" >/dev/null
  git -C "$SEED_REPO" worktree add -q -b fix/demo-login-error "$WT_LOGIN_ERROR" >/dev/null

  # Uncommitted work for the review-diff scene, and the work-evidence the
  # contract-verify take is judged on. Left unstaged on purpose: the Git pane's
  # `unstaged` list is what review-diff clicks, and a staged change would land
  # in a different list.
  cat >"$WT_DARK_MODE/src/theme.ts" <<'THEME'
export const THEME_STORAGE_KEY = "cmdemo.theme";

export type Theme = "light" | "dark";

export function resolveTheme(stored: string | null): Theme {
  return stored === "dark" ? "dark" : "light";
}
THEME

  # Self-check, before a server exists to be filmed talking to it: the `unit`
  # gate has to be green in the worktree the contract names. A red one here
  # would surface as `GATE unit FAIL` in the finished video.
  if ! ( cd "$WT_DARK_MODE" && node --test >"$STATE_DIR/seed-node-test.log" 2>&1 ); then
    printf '%s\n' "--- $STATE_DIR/seed-node-test.log ---" >&2
    tail -n 30 "$STATE_DIR/seed-node-test.log" >&2 2>/dev/null || true
    die "the seed's own 'node --test' is not green; the contract-verify take would film a failing gate"
  fi
  rm -f "$STATE_DIR/seed-node-test.log"

  create_second_seed_repo
}

# ------------------------------------------------------------ worktree id ----

# CommandMate mints a worktree ID from the *directory*, never from the branch:
#
#     id = sanitize(basename(resolvedPath))
#     on collision only: "${id}-${sha256(resolvedPath) first 8 hex}"
#
# (`deriveWorktreeId`, src/lib/git/worktree-id.ts — Issue #1621/#1644/#1645. The
# old `<repo>-<branch>` rule is @deprecated and no longer called from src/.)
# `sanitize` is `sanitizeIdSegment`: lower-case, `[^a-z0-9-]` folded to `-`, runs
# of `-` collapsed, edges trimmed.
#
# The four seed directories have distinct basenames, so the collision branch is
# unreachable here and each ID is exactly its directory name. Do not add a seed
# directory whose basename repeats one of these: the second ID would then carry
# a digest of the absolute path and nothing here could predict it.
derive_worktree_id() {
  printf '%s' "${1##*/}" \
    | LC_ALL=C tr 'A-Z' 'a-z' \
    | LC_ALL=C sed -e 's/[^a-z0-9-]/-/g' -e 's/--*/-/g' -e 's/^-//' -e 's/-$//'
}

PRIMARY_WORKTREE_ID="$(derive_worktree_id "$SEED_REPO")"
WORKTREE_ID="$(derive_worktree_id "$WT_DARK_MODE")"
LOGIN_WORKTREE_ID="$(derive_worktree_id "$WT_LOGIN_ERROR")"
UNSYNCED_WORKTREE_ID="$(derive_worktree_id "$WT_API_CACHE")"

for derived in "$PRIMARY_WORKTREE_ID" "$WORKTREE_ID" "$LOGIN_WORKTREE_ID" "$UNSYNCED_WORKTREE_ID"; do
  [ -n "$derived" ] || die "a seed directory name sanitizes to an empty worktree id"
done

# ---------------------------------------------------------------- boot -------

PORT="$(pick_port)" || exit 1
BASE_URL="http://127.0.0.1:$PORT"

mkdir -p "$STATE_DIR" "$VIDEO_DIR"
: >"$SESSIONS_FILE" || die "cannot write the session record at $SESSIONS_FILE"
log "state dir: $STATE_DIR"
log "seeding throwaway repository"
create_seed_repo

SERVER_CMD="${CM_DEMO_SERVER_CMD:-$REPO_ROOT/node_modules/.bin/tsx server.ts}"
# env-down refuses to kill a PID whose command line does not contain this
# marker, so a recycled PID cannot be shot by a stale state file.
PROC_MATCH="${CM_DEMO_PROC_MATCH:-server.ts}"

log "starting server on $BASE_URL"
# `set -m` puts the background job in its own process group, so env-down can
# signal the whole tree (tsx forks a child that owns the listener) by PGID.
set -m
(
  cd "$REPO_ROOT" || exit 1
  # `env -u` drops the ambient overrides that would otherwise point the demo at
  # the developer's real database or a real repository list.
  exec env -u DATABASE_PATH -u MCBD_DB_PATH -u MCBD_PORT -u MCBD_ROOT_DIR \
    -u CM_AUTH_TOKEN_HASH -u CM_HTTPS_CERT -u CM_HTTPS_KEY -u CM_ALLOWED_IPS \
    NODE_ENV=development \
    CM_PORT="$PORT" \
    CM_BIND=127.0.0.1 \
    CM_DB_PATH="$DB_PATH" \
    WORKTREE_REPOS="$SEED_REPO" \
    CM_ROOT_DIR="$SEED_ROOT" \
    CM_LOG_LEVEL=warn \
    $SERVER_CMD
) >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
set +m

SERVER_PGID="$(ps -o pgid= -p "$SERVER_PID" 2>/dev/null | tr -d ' ')"

cleanup_failed_boot() {
  if [ -n "${SERVER_PGID:-}" ] && [ "$SERVER_PGID" = "$SERVER_PID" ]; then
    kill -TERM "-$SERVER_PGID" 2>/dev/null || true
  else
    kill -TERM "$SERVER_PID" 2>/dev/null || true
  fi
}

# `/` is requested rather than trusting the "Ready" log line: under `tsx
# server.ts` the route is compiled on first request, and a bootstrap crash only
# surfaces then (see the AsyncLocalStorage note in server.ts).
attempt=0
ready=0
while [ "$attempt" -lt "$READY_TIMEOUT" ]; do
  attempt=$((attempt + 1))
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    printf '%s\n' "--- last 30 lines of $LOG_FILE ---" >&2
    tail -n 30 "$LOG_FILE" >&2 2>/dev/null || true
    die "server exited before becoming ready"
  fi
  if curl -fsS -o /dev/null --max-time 10 "$BASE_URL/" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  cleanup_failed_boot
  printf '%s\n' "--- last 30 lines of $LOG_FILE ---" >&2
  tail -n 30 "$LOG_FILE" >&2 2>/dev/null || true
  die "server did not answer $BASE_URL/ within ${READY_TIMEOUT}s"
fi

# Created only now, after the boot sync in server.ts has already scanned
# WORKTREE_REPOS. That ordering is what leaves this worktree on disk and absent
# from the database, which is the precondition the sync-worktrees scene films.
log "adding a worktree the boot sync has already missed"
git -C "$SEED_REPO" worktree add -q -b feature/demo-api-cache "$WT_API_CACHE" >/dev/null \
  || { cleanup_failed_boot; die "could not create the post-boot worktree"; }

cat >"$STATE_FILE" <<EOF
CM_DEMO_PORT=$PORT
CM_DEMO_BASE_URL=$BASE_URL
CM_DEMO_PID=$SERVER_PID
CM_DEMO_PGID=${SERVER_PGID:-}
CM_DEMO_PROC_MATCH=$PROC_MATCH
CM_DEMO_STATE_DIR=$STATE_DIR
CM_DEMO_SEED_ROOT=$SEED_ROOT
CM_DEMO_SEED_REPO=$SEED_REPO
CM_DEMO_SEED_REPO_2=$SEED_REPO_2
CM_DEMO_DB_PATH=$DB_PATH
CM_DEMO_VIDEO_DIR=$VIDEO_DIR
CM_DEMO_LOG_FILE=$LOG_FILE
CM_DEMO_SESSIONS_FILE=$SESSIONS_FILE
CM_DEMO_PRIMARY_WORKTREE_ID=$PRIMARY_WORKTREE_ID
CM_DEMO_WORKTREE_ID=$WORKTREE_ID
CM_DEMO_LOGIN_WORKTREE_ID=$LOGIN_WORKTREE_ID
CM_DEMO_UNSYNCED_WORKTREE_ID=$UNSYNCED_WORKTREE_ID
CM_DEMO_WORKTREE_PATH=$WT_DARK_MODE
CM_DEMO_LOGIN_WORKTREE_PATH=$WT_LOGIN_ERROR
CM_DEMO_UNSYNCED_WORKTREE_PATH=$WT_API_CACHE
EOF

log "ready at $BASE_URL (pid $SERVER_PID)"
log "state written to $STATE_FILE"
