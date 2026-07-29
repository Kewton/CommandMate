#!/usr/bin/env bash
#
# compose.sh — cut the recorded scenes into the finished demo (Issue #1554).
#
# Input is the plan storyboard.ts emits, so every timecode in here is derived
# from the storyboard's own cut. Nothing in this file may hard-code a position
# on the timeline: the whole point of the plan is that re-timing a scene in the
# YAML re-times its telop automatically.
#
# Each scene is normalised to its declared duration on its own, then the
# segments are concatenated. Overlaying per segment rather than with one global
# filter_complex keeps the telop in/out anchored to the scene boundary by
# construction — there is no offset arithmetic to get wrong — and the absolute
# times are still printed so the cut can be audited.
#
# Exit codes are checked after every ffmpeg call with `cmd > log 2>&1; $?`.
# Piping into grep would hide them, which is how a broken take gets reported as
# a good one.
#
# bash 3.2 compatible: no associative arrays, no mapfile.

set -u

FPS=30
FRAME_W=1280
FRAME_H=800
FADE_MAX=0.4
TOLERANCE=0.5
CRF=20

PLAN=""
SCENES_DIR=""
OVERLAYS_DIR=""
OUT=""
LOCALE="ja"
WANT_GIF=0
KEEP_WORK=0
VERIFY_FILE=""
COMPARE=""
EXPECT=""
WORK_DIR=""

die() {
  printf 'compose: %s\n' "$1" >&2
  exit 1
}

log() {
  printf 'compose: %s\n' "$1"
}

usage() {
  cat <<'USAGE'
Usage: compose.sh --plan FILE --scenes DIR --overlays DIR --out FILE.mp4 [options]
       compose.sh --verify FILE.mp4 --expect SECONDS [--tolerance SECONDS]

  --plan FILE       tab-separated plan from storyboard.ts --format plan
  --scenes DIR      directory holding <sceneId>.webm from record-scenes.ts
  --overlays DIR    directory holding telop-/card- PNGs from render-overlays.ts
  --out FILE.mp4    finished video
  --locale ja|en    which PNG set to use (default ja)
  --frame WxH       output frame size (default 1280x800)
  --fps N           output frame rate (default 30)
  --tolerance SEC   duration gate half-width (default 0.5)
  --gif             also write a README-sized GIF beside --out
  --keep-work       keep the intermediate segments for inspection
  --verify FILE     only run the duration gate against an existing file
  --compare SECONDS run the gate against an already-measured duration
  --expect SECONDS  expected duration for --verify / --compare
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --plan) [ $# -ge 2 ] || die "--plan needs a value"; PLAN="$2"; shift 2 ;;
    --scenes) [ $# -ge 2 ] || die "--scenes needs a value"; SCENES_DIR="$2"; shift 2 ;;
    --overlays) [ $# -ge 2 ] || die "--overlays needs a value"; OVERLAYS_DIR="$2"; shift 2 ;;
    --out) [ $# -ge 2 ] || die "--out needs a value"; OUT="$2"; shift 2 ;;
    --locale) [ $# -ge 2 ] || die "--locale needs a value"; LOCALE="$2"; shift 2 ;;
    --fps) [ $# -ge 2 ] || die "--fps needs a value"; FPS="$2"; shift 2 ;;
    --tolerance) [ $# -ge 2 ] || die "--tolerance needs a value"; TOLERANCE="$2"; shift 2 ;;
    --verify) [ $# -ge 2 ] || die "--verify needs a value"; VERIFY_FILE="$2"; shift 2 ;;
    --compare) [ $# -ge 2 ] || die "--compare needs a value"; COMPARE="$2"; shift 2 ;;
    --expect) [ $# -ge 2 ] || die "--expect needs a value"; EXPECT="$2"; shift 2 ;;
    --work) [ $# -ge 2 ] || die "--work needs a value"; WORK_DIR="$2"; shift 2 ;;
    --frame)
      [ $# -ge 2 ] || die "--frame needs a value"
      case "$2" in
        [0-9]*x[0-9]*) FRAME_W="${2%%x*}"; FRAME_H="${2##*x}" ;;
        *) die "--frame must look like 1280x800, got '$2'" ;;
      esac
      shift 2
      ;;
    --gif) WANT_GIF=1; shift ;;
    --keep-work) KEEP_WORK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1 (brew install ffmpeg)"
}
require_tool awk

# ------------------------------------------------------------ duration -------

probe_duration() {
  ffprobe -v error -show_entries format=duration -of csv=p=0 "$1" 2>/dev/null
}

# Returns 0 when |actual - expected| <= tolerance. Comparison is done in awk
# because bash 3.2 has no floating point.
within_tolerance() {
  [ "$(awk -v a="$1" -v e="$2" -v t="$3" \
    'BEGIN { d = a - e; if (d < 0) d = -d; print (d <= t + 1e-9) ? 1 : 0 }')" = "1" ]
}

# The gate, applied to a duration somebody else measured. Split out from
# --verify so the decision boundary can be exercised on a machine with no
# ffmpeg — otherwise the only test of the arithmetic would be one that skips.
if [ -n "$COMPARE" ]; then
  [ -n "$EXPECT" ] || die "--compare also needs --expect"
  if within_tolerance "$COMPARE" "$EXPECT" "$TOLERANCE"; then
    log "duration ${COMPARE}s is within ${EXPECT}s +/- ${TOLERANCE}s"
    exit 0
  fi
  printf 'compose: duration gate FAILED: %ss, expected %ss +/- %ss\n' \
    "$COMPARE" "$EXPECT" "$TOLERANCE" >&2
  exit 1
fi

if [ -n "$VERIFY_FILE" ]; then
  [ -n "$EXPECT" ] || die "--verify also needs --expect"
  [ -f "$VERIFY_FILE" ] || die "no such file: $VERIFY_FILE"
  require_tool ffprobe
  ACTUAL="$(probe_duration "$VERIFY_FILE")"
  [ -n "$ACTUAL" ] || die "ffprobe could not read a duration from $VERIFY_FILE"
  if within_tolerance "$ACTUAL" "$EXPECT" "$TOLERANCE"; then
    log "duration ${ACTUAL}s is within ${EXPECT}s +/- ${TOLERANCE}s"
    exit 0
  fi
  printf 'compose: duration gate FAILED: %ss, expected %ss +/- %ss\n' \
    "$ACTUAL" "$EXPECT" "$TOLERANCE" >&2
  exit 1
fi

[ -n "$PLAN" ] || { usage >&2; die "--plan is required"; }
[ -n "$SCENES_DIR" ] || die "--scenes is required"
[ -n "$OVERLAYS_DIR" ] || die "--overlays is required"
[ -n "$OUT" ] || die "--out is required"
[ -f "$PLAN" ] || die "no such plan: $PLAN"
case "$OUT" in
  *.mp4) : ;;
  *) die "--out must end in .mp4, got '$OUT'" ;;
esac

TOTAL="$(awk -F'\t' '$1 == "#total" { print $2; exit }' "$PLAN")"
[ -n "$TOTAL" ] || die "plan has no '#total' row — was it produced by storyboard.ts?"

OUT_DIR="$(cd "$(dirname "$OUT")" && pwd)" || die "output directory does not exist: $(dirname "$OUT")"
OUT="$OUT_DIR/$(basename "$OUT")"

# Dependencies are checked *after* the arguments, and only once there is real
# work to do. Checking first made every argument mistake report itself as
# "required command not found: ffmpeg" on a machine that has no ffmpeg — which
# is every CI runner and no developer machine, so it passed locally and failed
# only in CI (PR #1562). A wrong flag is a wrong flag whether or not ffmpeg is
# installed, and the operator would rather learn about both problems in the
# order they can fix them.
require_tool ffmpeg
require_tool ffprobe

if [ -z "$WORK_DIR" ]; then
  WORK_DIR="$OUT_DIR/.compose-work-$LOCALE"
fi
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR" || die "cannot create work directory: $WORK_DIR"

CONCAT_LIST="$WORK_DIR/segments.txt"
FF_LOG="$WORK_DIR/ffmpeg.log"
: >"$CONCAT_LIST"

SCALE_PAD="scale=${FRAME_W}:${FRAME_H}:force_original_aspect_ratio=decrease,pad=${FRAME_W}:${FRAME_H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"

run_ffmpeg() {
  # Never piped: a pipeline would report the exit status of the reader.
  ffmpeg -hide_banner -nostdin -y "$@" >"$FF_LOG" 2>&1
  status=$?
  if [ "$status" -ne 0 ]; then
    printf '%s\n' "--- last 25 lines of $FF_LOG ---" >&2
    tail -n 25 "$FF_LOG" >&2 2>/dev/null || true
    die "ffmpeg exited $status"
  fi
}

SEGMENT_INDEX=0
TAB="$(printf '\t')"

while IFS="$TAB" read -r id type viewport start duration telop; do
  case "$id" in
    ''|'#'*) continue ;;
  esac
  [ -n "$duration" ] || die "plan row '$id' has no duration"

  SEGMENT_INDEX=$((SEGMENT_INDEX + 1))
  segment="$WORK_DIR/$(printf '%02d' "$SEGMENT_INDEX")-$id.mp4"
  # Fades shrink with the scene so a 1s beat is not entirely fade.
  fade="$(awk -v d="$duration" -v m="$FADE_MAX" 'BEGIN { f = d / 4; if (f > m) f = m; printf "%.3f", f }')"
  fade_out_at="$(awk -v d="$duration" -v f="$fade" 'BEGIN { printf "%.3f", d - f }')"
  end="$(awk -v s="$start" -v d="$duration" 'BEGIN { printf "%.3f", s + d }')"

  if [ "$type" = "card" ]; then
    card="$OVERLAYS_DIR/card-$id.$LOCALE.png"
    [ -f "$card" ] || die "missing card image: $card (run render-overlays.ts --locale $LOCALE)"
    log "card    $id  ${start}s..${end}s  \"$telop\""
    run_ffmpeg -loop 1 -t "$duration" -i "$card" \
      -filter_complex "[0:v]${SCALE_PAD},fps=${FPS},fade=t=in:st=0:d=${fade},fade=t=out:st=${fade_out_at}:d=${fade},format=yuv420p[v]" \
      -map '[v]' -an -c:v libx264 -preset veryfast -crf "$CRF" -r "$FPS" -t "$duration" "$segment"
  else
    footage="$SCENES_DIR/$id.webm"
    [ -f "$footage" ] || die "missing footage: $footage (run record-scenes.ts --scene $id)"
    telop_png="$OVERLAYS_DIR/telop-$id.$LOCALE.png"
    [ -f "$telop_png" ] || die "missing telop image: $telop_png (run render-overlays.ts --locale $LOCALE)"
    # An over-long take is cut from the *front*, not the back. The payoff of
    # every scene is at its end — the prompt sheet, the finished branch list —
    # and keeping the first N seconds throws exactly that away.
    take="$(probe_duration "$footage")"
    seek=0
    if [ -n "$take" ]; then
      seek="$(awk -v t="$take" -v d="$duration" 'BEGIN { s = t - d; if (s < 0) s = 0; printf "%.3f", s }')"
    fi
    log "record  $id  ${start}s..${end}s  (take ${take:-?}s, from +${seek}s)  \"$telop\""
    # tpad clones the last frame when the take is shorter than the declared
    # slot; trim cuts it when it is longer. Either way the segment is exactly
    # `duration`, which is what makes the concatenated total match the
    # storyboard instead of drifting scene by scene.
    run_ffmpeg -ss "$seek" -i "$footage" -loop 1 -t "$duration" -i "$telop_png" \
      -filter_complex "[0:v]${SCALE_PAD},fps=${FPS},tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},setpts=PTS-STARTPTS[base];[1:v]format=rgba,fade=t=in:st=0:d=${fade}:alpha=1,fade=t=out:st=${fade_out_at}:d=${fade}:alpha=1[tel];[base][tel]overlay=0:0:format=auto,format=yuv420p[v]" \
      -map '[v]' -an -c:v libx264 -preset veryfast -crf "$CRF" -r "$FPS" -t "$duration" "$segment"
  fi

  printf "file '%s'\n" "$segment" >>"$CONCAT_LIST"
done <"$PLAN"

[ "$SEGMENT_INDEX" -gt 0 ] || die "plan contained no scenes"

log "concatenating $SEGMENT_INDEX segments"
# Re-encoded rather than `-c copy`: stream copy leaves the concat demuxer's
# per-segment timestamps in place and the total drifts by a frame or two per
# cut, which is exactly what the gate below is meant to catch for real reasons.
run_ffmpeg -f concat -safe 0 -i "$CONCAT_LIST" \
  -c:v libx264 -preset veryfast -crf "$CRF" -pix_fmt yuv420p -r "$FPS" -an -movflags +faststart "$OUT"

ACTUAL="$(probe_duration "$OUT")"
[ -n "$ACTUAL" ] || die "ffprobe could not read a duration from $OUT"

if ! within_tolerance "$ACTUAL" "$TOTAL" "$TOLERANCE"; then
  printf 'compose: duration gate FAILED: %ss, expected %ss +/- %ss\n' "$ACTUAL" "$TOTAL" "$TOLERANCE" >&2
  printf 'compose: per-segment measurement (declared vs actual):\n' >&2
  index=0
  while IFS="$TAB" read -r id type viewport start duration telop; do
    case "$id" in
      ''|'#'*) continue ;;
    esac
    index=$((index + 1))
    segment="$WORK_DIR/$(printf '%02d' "$index")-$id.mp4"
    measured="$(probe_duration "$segment")"
    awk -v i="$id" -v d="$duration" -v m="${measured:-0}" \
      'BEGIN { delta = m - d; printf "  %-22s declared %6.3fs  actual %6.3fs  delta %+.3fs\n", i, d, m, delta }' >&2
  done <"$PLAN"
  printf 'compose: intermediates kept in %s\n' "$WORK_DIR" >&2
  exit 1
fi

log "duration ${ACTUAL}s is within ${TOTAL}s +/- ${TOLERANCE}s"

if [ "$WANT_GIF" -eq 1 ]; then
  GIF="${OUT%.mp4}.gif"
  PALETTE="$WORK_DIR/palette.png"
  log "writing $GIF"
  run_ffmpeg -i "$OUT" -vf 'fps=12,scale=720:-1:flags=lanczos,palettegen' "$PALETTE"
  run_ffmpeg -i "$OUT" -i "$PALETTE" \
    -lavfi 'fps=12,scale=720:-1:flags=lanczos[x];[x][1:v]paletteuse' -loop 0 "$GIF"
fi

if [ "$KEEP_WORK" -eq 0 ]; then
  rm -rf "$WORK_DIR"
fi

log "wrote $OUT"
