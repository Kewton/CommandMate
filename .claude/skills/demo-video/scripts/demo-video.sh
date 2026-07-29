#!/usr/bin/env bash
#
# demo-video.sh — the whole pipeline, per locale (Issue #1554).
#
#   deps -> env-up -> fake agent -> record -> render telops -> compose -> gate
#
# The locale is switched for the *whole take*, not just for the telop: the UI is
# recorded in the same language the telop is written in. That is why each locale
# gets its own environment cycle rather than one recording reused twice.
#
# The demo database is purged between locales. Without that, the second take
# opens with the first take's message history still on screen.
#
# bash 3.2 compatible: no associative arrays, no mapfile. Loop variables are
# never called `path` — that would clobber PATH and turn the health check into a
# false negative.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="${CM_DEMO_REPO_ROOT:-$(cd "$SKILL_DIR/../../.." && pwd)}"

WORKTREE_ID="cmdemo-app-feature-demo-dark-mode"
MESSAGE="Add a dark mode toggle to the header"
STORYBOARD="$SKILL_DIR/storyboard/default.yaml"
OUT_DIR="${CM_DEMO_OUT_DIR:-$HOME/Desktop/commandmate-demo}"
LOCALES="ja en"
WANT_GIF=0
FRAME="1280x800"
CHECK_ONLY=0

die() {
  printf 'demo-video: %s\n' "$1" >&2
  exit 1
}

log() {
  printf '\033[36mdemo-video:\033[0m %s\n' "$1"
}

usage() {
  cat <<'USAGE'
Usage: demo-video.sh [--locale ja|en|all] [--out DIR] [--gif] [--check]

  --locale L    ja, en or all (default all)
  --out DIR     where the finished videos go (default ~/Desktop/commandmate-demo)
  --storyboard  storyboard YAML (default storyboard/default.yaml)
  --frame WxH   output frame size (default 1280x800)
  --gif         also write a README-sized GIF next to each mp4
  --check       run the dependency check and storyboard validation, then stop
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --locale)
      [ $# -ge 2 ] || die "--locale needs a value"
      case "$2" in
        ja) LOCALES="ja" ;;
        en) LOCALES="en" ;;
        all) LOCALES="ja en" ;;
        *) die "--locale must be ja, en or all, got '$2'" ;;
      esac
      shift 2
      ;;
    --out) [ $# -ge 2 ] || die "--out needs a value"; OUT_DIR="$2"; shift 2 ;;
    --storyboard) [ $# -ge 2 ] || die "--storyboard needs a value"; STORYBOARD="$2"; shift 2 ;;
    --frame) [ $# -ge 2 ] || die "--frame needs a value"; FRAME="$2"; shift 2 ;;
    --gif) WANT_GIF=1; shift ;;
    --check) CHECK_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

# ---------------------------------------------------------- dependencies -----

MISSING=""
for tool in tmux git curl node awk ffmpeg ffprobe; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    MISSING="$MISSING $tool"
  fi
done
if [ -n "$MISSING" ]; then
  printf 'demo-video: missing required command(s):%s\n' "$MISSING" >&2
  case "$MISSING" in
    *ffmpeg*|*ffprobe*) printf '  brew install ffmpeg\n' >&2 ;;
  esac
  case "$MISSING" in
    *tmux*) printf '  brew install tmux\n' >&2 ;;
  esac
  exit 1
fi
[ -x "$REPO_ROOT/node_modules/.bin/tsx" ] || die "tsx not found — run 'npm install' in $REPO_ROOT"
log "dependencies ok"

# Validating up front means a typo in the storyboard costs a second instead of
# two full recording cycles.
for loc in $LOCALES; do
  "$REPO_ROOT/node_modules/.bin/tsx" "$SCRIPT_DIR/storyboard.ts" \
    --file "$STORYBOARD" --locale "$loc" >/dev/null || die "storyboard validation failed for locale '$loc'"
done
log "storyboard ok: $STORYBOARD"

if [ "$CHECK_ONLY" -eq 1 ]; then
  log "--check given, stopping before the first recording"
  exit 0
fi

mkdir -p "$OUT_DIR" || die "cannot create output directory: $OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

# ----------------------------------------------------------- pipeline --------

ENV_IS_UP=0

teardown() {
  if [ "$ENV_IS_UP" -eq 1 ]; then
    ENV_IS_UP=0
    "$SCRIPT_DIR/env-down.sh" --purge || printf 'demo-video: env-down reported a problem\n' >&2
  fi
}

# Leaving the isolated server holding a port is the failure mode SKILL.md warns
# about: the next env-up refuses to start on top of a stale state file.
trap 'teardown' EXIT INT TERM

for loc in $LOCALES; do
  log "=== locale $loc ==="

  "$SCRIPT_DIR/env-up.sh" || die "env-up failed for locale '$loc'"
  ENV_IS_UP=1
  # shellcheck disable=SC1090
  . "${CM_DEMO_HOME:-$HOME/.commandmate-demo}/state.env"

  log "starting the fake agent"
  "$SCRIPT_DIR/fake-agent.sh" "$SKILL_DIR/fixtures/claude-session-sample.cast" \
    --session "mcbd-claude-$WORKTREE_ID" \
    --cwd "$CM_DEMO_SEED_ROOT/wt-dark-mode" >/dev/null \
    || die "could not start the fake agent"

  SCENES_DIR="$CM_DEMO_VIDEO_DIR/$loc"
  OVERLAY_DIR="$OUT_DIR/.overlays"
  PLAN="$OUT_DIR/.plan-$loc.tsv"
  mkdir -p "$SCENES_DIR" "$OVERLAY_DIR"

  log "recording scenes"
  "$REPO_ROOT/node_modules/.bin/tsx" "$SCRIPT_DIR/record-scenes.ts" \
    --locale "$loc" --out "$SCENES_DIR" --message "$MESSAGE" --worktree "$WORKTREE_ID" \
    || die "recording failed for locale '$loc'"

  log "rendering telops"
  "$REPO_ROOT/node_modules/.bin/tsx" "$SCRIPT_DIR/render-overlays.ts" \
    --locale "$loc" --out "$OVERLAY_DIR" --storyboard "$STORYBOARD" --frame "$FRAME" \
    || die "telop rendering failed for locale '$loc'"

  "$REPO_ROOT/node_modules/.bin/tsx" "$SCRIPT_DIR/storyboard.ts" \
    --file "$STORYBOARD" --locale "$loc" --format plan >"$PLAN" \
    || die "could not write the plan for locale '$loc'"

  STEM="$(awk -F'\t' '$1 == "#output" { print $2; exit }' "$PLAN")"
  [ -n "$STEM" ] || die "plan has no '#output' row"

  log "composing $OUT_DIR/$STEM.mp4"
  COMPOSE_ARGS="--plan $PLAN --scenes $SCENES_DIR --overlays $OVERLAY_DIR"
  if [ "$WANT_GIF" -eq 1 ]; then
    "$SCRIPT_DIR/compose.sh" $COMPOSE_ARGS --locale "$loc" --frame "$FRAME" \
      --out "$OUT_DIR/$STEM.mp4" --gif || die "compose failed for locale '$loc'"
  else
    "$SCRIPT_DIR/compose.sh" $COMPOSE_ARGS --locale "$loc" --frame "$FRAME" \
      --out "$OUT_DIR/$STEM.mp4" || die "compose failed for locale '$loc'"
  fi

  rm -f "$PLAN"
  teardown
done

log "done. artefacts:"
ls -1 "$OUT_DIR"/*.mp4 "$OUT_DIR"/*.gif 2>/dev/null || true
log "these are outside the repository on purpose — do not commit them"
