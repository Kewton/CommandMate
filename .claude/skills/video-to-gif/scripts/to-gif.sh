#!/usr/bin/env bash
#
# to-gif.sh — turn recorded video into a GIF that GitHub's markdown viewer can
# actually play, under a byte budget.
#
# Why this exists separately from demo-video's compose.sh --gif: that flag only
# fires as part of a compose run and hard-codes 720px/12fps/sierra2_4a. Docs
# pages need a GIF per already-finished mp4, at a size the repository can carry,
# and "does it fit" has to be measured rather than hoped for.
#
# Two things this file refuses to do, both learned the hard way:
#
#   * It never reports size with `du`. On APFS `du -h` called a 1,536,216 byte
#     file 2.3M — block accounting, not content. Every number printed here comes
#     from `wc -c`, because the number that matters is the one git stores.
#
#   * It never writes an over-budget GIF without saying so. Video is already
#     compressed, so git cannot delta it: every version of every GIF stays in
#     history forever. A silent 5MB commit costs a history rewrite to undo.
#
# bash 3.2 compatible: no associative arrays, no mapfile.

set -u

# Defaults chosen from measurement, not from the usual copy-pasted ffmpeg GIF
# recipe. Against a lossless reference of the same 20s 1280x800 UI capture
# (SSIM All, higher is better):
#
#   colors=256 dither=none          1,073,725 B   0.99653   <- default
#   colors=128 dither=none            883,912 B   0.99439
#   colors=128 dither=sierra2_4a    1,271,671 B   0.99160
#   colors=128 dither=bayer           998,339 B   0.99149
#   colors=64  dither=none            736,163 B   0.99202
#
# Dithering is strictly worse here on both axes. It sprays spatial noise that
# breaks the LZW runs GIF compresses with, and on the flat panels a screen
# recording is mostly made of there is no gradient for it to smooth. Note that
# colors=64 with sierra2_4a measured 1,472,301 B — larger than colors=128 with
# the same dither, because a coarser palette makes error diffusion spread
# further. If a source does have real gradients, pass --dither sierra2_4a
# knowingly rather than by default.
WIDTH=600
FPS=10
COLORS=256
DITHER=none
STATS_MODE=full
MAX_BYTES=1.5M
MIN_WIDTH=360
MIN_FPS=6
MIN_COLORS=32
LOOP=0
START=""
DURATION=""
OUT=""
NO_FIT=0
ALLOW_OVERSIZE=0
KEEP_PALETTE=0
MODE=convert

die() {
  printf 'to-gif: %s\n' "$1" >&2
  exit 1
}

log() {
  printf 'to-gif: %s\n' "$1"
}

usage() {
  cat <<'USAGE'
Usage: to-gif.sh INPUT.mp4 [INPUT2.mp4 ...] [options]
       to-gif.sh --ladder [options]        # print the retry ladder, runs no ffmpeg
       to-gif.sh --report FILE.gif ...     # measure existing GIFs
       to-gif.sh --check                   # dependency check only

  --out PATH          output file (one input) or directory (many). Default: beside the input
  --width PX          starting width, height follows the aspect ratio (default 600)
  --fps N             starting frame rate (default 10)
  --colors N          palette size, 2..256 (default 256)
  --dither MODE       none|bayer|sierra2_4a|floyd_steinberg|... (default none)
  --stats-mode MODE   palettegen statistics: full|diff|single (default full)
  --max-bytes SIZE    per-file budget: 1500000, 1500k, 1.5M, or "none" (default 1.5M)
  --no-fit            try the starting settings only; fail instead of walking the ladder
  --allow-oversize    write the smallest attempt even when it misses the budget (still exits 1)
  --min-width PX      ladder floor (default 360)
  --min-fps N         ladder floor (default 6)
  --min-colors N      ladder floor (default 32)
  --start SEC         trim: skip the first SEC seconds
  --duration SEC      trim: keep SEC seconds
  --loop N            0 = loop forever (default), -1 = play once
  --keep-palette      keep the intermediate palette PNG beside the output
USAGE
}

# ------------------------------------------------------------- arguments -----

INPUTS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || die "--out needs a value"; OUT="$2"; shift 2 ;;
    --width) [ $# -ge 2 ] || die "--width needs a value"; WIDTH="$2"; shift 2 ;;
    --fps) [ $# -ge 2 ] || die "--fps needs a value"; FPS="$2"; shift 2 ;;
    --colors) [ $# -ge 2 ] || die "--colors needs a value"; COLORS="$2"; shift 2 ;;
    --dither) [ $# -ge 2 ] || die "--dither needs a value"; DITHER="$2"; shift 2 ;;
    --stats-mode) [ $# -ge 2 ] || die "--stats-mode needs a value"; STATS_MODE="$2"; shift 2 ;;
    --max-bytes) [ $# -ge 2 ] || die "--max-bytes needs a value"; MAX_BYTES="$2"; shift 2 ;;
    --min-width) [ $# -ge 2 ] || die "--min-width needs a value"; MIN_WIDTH="$2"; shift 2 ;;
    --min-fps) [ $# -ge 2 ] || die "--min-fps needs a value"; MIN_FPS="$2"; shift 2 ;;
    --min-colors) [ $# -ge 2 ] || die "--min-colors needs a value"; MIN_COLORS="$2"; shift 2 ;;
    --start) [ $# -ge 2 ] || die "--start needs a value"; START="$2"; shift 2 ;;
    --duration) [ $# -ge 2 ] || die "--duration needs a value"; DURATION="$2"; shift 2 ;;
    --loop) [ $# -ge 2 ] || die "--loop needs a value"; LOOP="$2"; shift 2 ;;
    --no-fit) NO_FIT=1; shift ;;
    --allow-oversize) ALLOW_OVERSIZE=1; shift ;;
    --keep-palette) KEEP_PALETTE=1; shift ;;
    --ladder) MODE=ladder; shift ;;
    --report) MODE=report; shift ;;
    --check) MODE=check; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) usage >&2; die "unknown argument: $1" ;;
    *) INPUTS="$INPUTS$1
"; shift ;;
  esac
done

is_uint() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

# Arguments are validated before any dependency is looked for. The other order
# makes every typo report itself as "required command not found: ffmpeg" on
# machines without ffmpeg — which is every CI runner and no developer machine,
# so the mistake passes locally and fails only in CI (compose.sh, PR #1562).
is_uint "$WIDTH" || die "--width must be a whole number of pixels, got '$WIDTH'"
is_uint "$FPS" || die "--fps must be a whole number, got '$FPS'"
is_uint "$COLORS" || die "--colors must be a whole number, got '$COLORS'"
is_uint "$MIN_WIDTH" || die "--min-width must be a whole number, got '$MIN_WIDTH'"
is_uint "$MIN_FPS" || die "--min-fps must be a whole number, got '$MIN_FPS'"
is_uint "$MIN_COLORS" || die "--min-colors must be a whole number, got '$MIN_COLORS'"
[ "$WIDTH" -ge 16 ] || die "--width must be at least 16, got $WIDTH"
[ "$FPS" -ge 1 ] || die "--fps must be at least 1, got $FPS"
[ "$COLORS" -ge 2 ] || die "--colors must be 2..256, got $COLORS"
[ "$COLORS" -le 256 ] || die "--colors must be 2..256, got $COLORS"
[ "$MIN_COLORS" -ge 2 ] || die "--min-colors must be at least 2, got $MIN_COLORS"
[ "$MIN_FPS" -ge 1 ] || die "--min-fps must be at least 1, got $MIN_FPS"
[ "$MIN_WIDTH" -ge 16 ] || die "--min-width must be at least 16, got $MIN_WIDTH"
[ "$WIDTH" -ge "$MIN_WIDTH" ] || die "--width ($WIDTH) is below --min-width ($MIN_WIDTH)"
[ "$FPS" -ge "$MIN_FPS" ] || die "--fps ($FPS) is below --min-fps ($MIN_FPS)"
[ "$COLORS" -ge "$MIN_COLORS" ] || die "--colors ($COLORS) is below --min-colors ($MIN_COLORS)"
case "$STATS_MODE" in
  full|diff|single) : ;;
  *) die "--stats-mode must be full, diff or single, got '$STATS_MODE'" ;;
esac
case "$LOOP" in
  -1) : ;;
  *[!0-9]*) die "--loop must be -1, 0 or a positive count, got '$LOOP'" ;;
  '') die "--loop must be -1, 0 or a positive count, got ''" ;;
esac

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1 (brew install ffmpeg)"
}
require_tool awk

# ------------------------------------------------------------- byte sizes ----

# Accepts 1500000 / 1500k / 1.5M / 1.5MB / none. Echoes a plain byte count, or
# 0 for "no budget".
parse_bytes() {
  case "$1" in
    none|NONE|None) printf '0\n'; return 0 ;;
  esac
  printf '%s' "$1" | awk '
    {
      s = $0
      unit = 1
      if (s ~ /[kK][bB]?$/) { unit = 1024; sub(/[kK][bB]?$/, "", s) }
      else if (s ~ /[mM][bB]?$/) { unit = 1048576; sub(/[mM][bB]?$/, "", s) }
      else if (s ~ /[gG][bB]?$/) { unit = 1073741824; sub(/[gG][bB]?$/, "", s) }
      else if (s ~ /[bB]$/) { sub(/[bB]$/, "", s) }
      if (s !~ /^[0-9]+(\.[0-9]+)?$/) { exit 1 }
      printf "%d\n", s * unit
    }'
}

# `wc -c`, never `du`: du reports allocated blocks, which on APFS overstated a
# 1,536,216 byte file as 2.3M. The size that matters is the one git stores.
byte_size() {
  wc -c <"$1" | awk '{ print $1 }'
}

human() {
  awk -v b="$1" 'BEGIN {
    if (b >= 1048576) printf "%.2fMB", b / 1048576
    else if (b >= 1024) printf "%.0fKB", b / 1024
    else printf "%dB", b
  }'
}

BUDGET="$(parse_bytes "$MAX_BYTES")" \
  || die "--max-bytes must look like 1500000, 1500k, 1.5M or none, got '$MAX_BYTES'"

# ---------------------------------------------------------------- ladder -----

# Notches are a fixed table rather than a multiplier so the printed ladder is
# reproducible for the same flags and a reviewer can check it by eye.
next_fps() {
  awk -v f="$1" -v min="$2" 'BEGIN {
    n = split("30 25 24 20 15 12 10 8 6 5 4 3 2 1", a, " ")
    for (i = 1; i <= n; i++) if (a[i] < f && a[i] >= min) { print a[i]; exit }
    print f
  }'
}

next_width() {
  awk -v w="$1" -v min="$2" 'BEGIN {
    n = int(w * 0.8)
    n = n - (n % 2)
    if (n < min) n = min
    if (n >= w) n = w
    print n
  }'
}

next_colors() {
  awk -v c="$1" -v min="$2" 'BEGIN {
    n = int(c / 2)
    if (n < min) n = min
    if (n >= c) n = c
    print n
  }'
}

# Emits "<width>\t<fps>\t<colors>" per rung, largest first.
#
# The three axes step round-robin rather than one being exhausted before the
# next is touched. Dropping to 4fps at full width, or to 360px at full frame
# rate, both look worse than a moderate cut to each — and legibility of the text
# on screen is the whole point of a UI demo.
emit_ladder() {
  lw="$WIDTH"
  lf="$FPS"
  lc="$COLORS"
  printf '%s\t%s\t%s\n' "$lw" "$lf" "$lc"
  if [ "$NO_FIT" -eq 1 ] || [ "$BUDGET" -eq 0 ]; then
    return 0
  fi
  while :; do
    pass_moved=0
    for axis in fps width colors; do
      stepped=0
      case "$axis" in
        fps)
          nv="$(next_fps "$lf" "$MIN_FPS")"
          if [ "$nv" != "$lf" ]; then lf="$nv"; stepped=1; fi
          ;;
        width)
          nv="$(next_width "$lw" "$MIN_WIDTH")"
          if [ "$nv" != "$lw" ]; then lw="$nv"; stepped=1; fi
          ;;
        colors)
          nv="$(next_colors "$lc" "$MIN_COLORS")"
          if [ "$nv" != "$lc" ]; then lc="$nv"; stepped=1; fi
          ;;
      esac
      if [ "$stepped" -eq 1 ]; then
        printf '%s\t%s\t%s\n' "$lw" "$lf" "$lc"
        pass_moved=1
      fi
    done
    if [ "$pass_moved" -eq 0 ]; then
      break
    fi
  done
}

TAB="$(printf '\t')"

if [ "$MODE" = "ladder" ]; then
  if [ "$BUDGET" -eq 0 ]; then
    log "no budget (--max-bytes none): one attempt, no ladder"
  elif [ "$NO_FIT" -eq 1 ]; then
    log "--no-fit: one attempt, no ladder (budget $(human "$BUDGET"))"
  else
    log "budget $(human "$BUDGET") per file; floors ${MIN_WIDTH}px / ${MIN_FPS}fps / ${MIN_COLORS} colors"
  fi
  printf '%-5s %7s %6s %8s\n' "rung" "width" "fps" "colors"
  emit_ladder | awk -F"$TAB" '{ printf "%-5d %7s %6s %8s\n", NR, $1, $2, $3 }'
  exit 0
fi

# ----------------------------------------------------------------- check -----

if [ "$MODE" = "check" ]; then
  check_status=0
  for tool in ffmpeg ffprobe awk; do
    if command -v "$tool" >/dev/null 2>&1; then
      printf 'to-gif: ok      %s\n' "$tool"
    else
      printf 'to-gif: MISSING %s\n' "$tool" >&2
      check_status=1
    fi
  done
  if [ "$check_status" -ne 0 ]; then
    printf 'to-gif: install with: brew install ffmpeg\n' >&2
  fi
  exit "$check_status"
fi

[ -n "$INPUTS" ] || { usage >&2; die "no input files"; }

# ---------------------------------------------------------------- report -----

if [ "$MODE" = "report" ]; then
  require_tool ffprobe
  REPORT_TOTAL=0
  REPORT_COUNT=0
  printf '%-46s %10s %12s %8s %9s\n' "file" "bytes" "size" "frames" "seconds"
  # A heredoc, not a pipeline: a pipeline runs the loop in a subshell where the
  # running total is discarded and `die` cannot stop the script.
  while IFS= read -r rf; do
    [ -n "$rf" ] || continue
    [ -f "$rf" ] || die "no such file: $rf"
    rb="$(byte_size "$rf")"
    rdims="$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height \
      -of csv=p=0:s=x "$rf" 2>/dev/null | head -1)"
    rframes="$(ffprobe -v error -select_streams v:0 -count_frames \
      -show_entries stream=nb_read_frames -of csv=p=0 "$rf" 2>/dev/null | head -1)"
    rsecs="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$rf" 2>/dev/null | head -1)"
    REPORT_TOTAL=$((REPORT_TOTAL + rb))
    REPORT_COUNT=$((REPORT_COUNT + 1))
    printf '%-46s %10d %12s %8s %9s\n' "$(basename "$rf")" "$rb" "${rdims:-?}" "${rframes:-?}" "${rsecs:-?}"
  done <<EOF
$INPUTS
EOF
  printf 'to-gif: %d file(s), %d bytes total (%s)\n' \
    "$REPORT_COUNT" "$REPORT_TOTAL" "$(human "$REPORT_TOTAL")"
  exit 0
fi

# --------------------------------------------------------------- convert -----

require_tool ffmpeg
require_tool ffprobe

COUNT="$(printf '%s' "$INPUTS" | awk 'NF { n++ } END { print n + 0 }')"

# `--out` is a file only when it is spelled as one. Anything else is a
# directory and is created on demand — requiring `mkdir -p` first is the kind of
# papercut that gets worked around with a shell loop, which then loses the
# per-file budget report this script exists to print.
OUT_IS_DIR=0
if [ -n "$OUT" ]; then
  case "$OUT" in
    *.gif) OUT_IS_DIR=0 ;;
    *) OUT_IS_DIR=1 ;;
  esac
  if [ -d "$OUT" ]; then
    OUT_IS_DIR=1
  elif [ "$OUT_IS_DIR" -eq 1 ]; then
    # A path that looks like a file but is not spelled .gif is a typo, not a
    # directory request. Silently creating `hero.png/` as a folder is worse than
    # refusing.
    out_leaf="$(basename "${OUT%/}")"
    case "$OUT" in
      */) : ;;
      *.*) die "--out looks like a file but does not end in .gif: '$out_leaf' (add a trailing / for a directory)" ;;
    esac
  fi
fi
if [ "$COUNT" -gt 1 ] && [ -n "$OUT" ] && [ "$OUT_IS_DIR" -eq 0 ]; then
  die "--out must be a directory when there is more than one input ($COUNT given)"
fi
if [ "$OUT_IS_DIR" -eq 1 ]; then
  mkdir -p "$OUT" || die "cannot create output directory: $OUT"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/to-gif.XXXXXX")" || die "cannot create a temp directory"
cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

FF_LOG="$WORK/ffmpeg.log"
PALETTE="$WORK/palette.png"

run_ffmpeg() {
  # Never piped into grep: a pipeline reports the reader's exit status, which is
  # how a failed encode gets logged as a success.
  ffmpeg -hide_banner -nostdin -v error -y "$@" >"$FF_LOG" 2>&1
  ff_status=$?
  if [ "$ff_status" -ne 0 ]; then
    printf '%s\n' "--- last 25 lines of ffmpeg output ---" >&2
    tail -n 25 "$FF_LOG" >&2 2>/dev/null || true
    return "$ff_status"
  fi
  return 0
}

FAILED=0
MADE=0
TOTAL_BYTES=0

emit_ladder >"$WORK/ladder.tsv"
RUNGS="$(awk 'END { print NR }' "$WORK/ladder.tsv")"
log "$COUNT input(s), budget $( [ "$BUDGET" -eq 0 ] && printf 'none' || human "$BUDGET" ), $RUNGS rung(s)"

while IFS= read -r INPUT; do
  [ -n "$INPUT" ] || continue
  [ -f "$INPUT" ] || die "no such file: $INPUT"

  base="$(basename "$INPUT")"
  stem="${base%.*}"
  if [ -n "$OUT" ] && [ "$OUT_IS_DIR" -eq 0 ]; then
    target="$OUT"
  elif [ -n "$OUT" ]; then
    target="${OUT%/}/$stem.gif"
  else
    target="$(dirname "$INPUT")/$stem.gif"
  fi
  case "$target" in
    *.gif) : ;;
    *) die "refusing to write a non-.gif output: $target" ;;
  esac
  if [ "$target" = "$INPUT" ]; then
    die "input and output are the same file: $INPUT"
  fi

  best_bytes=0
  best_file=""
  best_rung=""
  accepted=0
  rung=0
  broke=0

  # Read from a file, not a pipe: a pipeline would run this loop in a subshell
  # and every variable set inside it would be thrown away at the end.
  while IFS="$TAB" read -r w f c; do
    rung=$((rung + 1))
    attempt="$WORK/attempt.gif"
    filters="fps=$f,scale=$w:-1:flags=lanczos"

    # Both -ss and -t are applied as *input* options, before -i. Appending -t
    # after the arguments instead puts it in front of the palette's own `-i`,
    # where ffmpeg reads it as an input option for the palette PNG and the trim
    # silently does nothing — a --duration 6 run came out 16s long that way.
    set -- -i "$INPUT"
    if [ -n "$DURATION" ]; then
      set -- -t "$DURATION" "$@"
    fi
    if [ -n "$START" ]; then
      set -- -ss "$START" "$@"
    fi

    if ! run_ffmpeg "$@" -vf "$filters,palettegen=max_colors=$c:stats_mode=$STATS_MODE" "$PALETTE"; then
      printf 'to-gif: palettegen failed for %s at %spx/%sfps/%sc\n' "$base" "$w" "$f" "$c" >&2
      broke=1
      break
    fi
    if ! run_ffmpeg "$@" -i "$PALETTE" \
      -lavfi "$filters[x];[x][1:v]paletteuse=dither=$DITHER" -loop "$LOOP" "$attempt"; then
      printf 'to-gif: paletteuse failed for %s at %spx/%sfps/%sc\n' "$base" "$w" "$f" "$c" >&2
      broke=1
      break
    fi

    bytes="$(byte_size "$attempt")"
    if [ -z "$best_file" ] || [ "$bytes" -lt "$best_bytes" ]; then
      best_bytes="$bytes"
      best_rung="${w}px/${f}fps/${c}c"
      best_file="$WORK/best.gif"
      mv -f "$attempt" "$best_file"
    else
      rm -f "$attempt"
    fi

    if [ "$BUDGET" -eq 0 ] || [ "$bytes" -le "$BUDGET" ]; then
      accepted=1
      log "$base  rung $rung  ${w}px/${f}fps/${c}c  $(human "$bytes") ($bytes bytes)"
      break
    fi
    log "$base  rung $rung  ${w}px/${f}fps/${c}c  $(human "$bytes") over $(human "$BUDGET") — stepping down"
  done <"$WORK/ladder.tsv"

  if [ "$broke" -eq 1 ]; then
    FAILED=1
    continue
  fi

  if [ "$accepted" -eq 0 ]; then
    printf 'to-gif: %s does not fit %s — smallest was %s at %s\n' \
      "$base" "$(human "$BUDGET")" "$(human "$best_bytes")" "$best_rung" >&2
    printf 'to-gif: raise --max-bytes, shorten with --duration, or lower --min-width/--min-fps\n' >&2
    if [ "$ALLOW_OVERSIZE" -eq 1 ] && [ -n "$best_file" ]; then
      mv -f "$best_file" "$target" || die "cannot write $target"
      printf 'to-gif: wrote %s anyway (--allow-oversize)\n' "$target" >&2
    fi
    FAILED=1
    continue
  fi

  mv -f "$best_file" "$target" || die "cannot write $target"
  if [ "$KEEP_PALETTE" -eq 1 ]; then
    cp -f "$PALETTE" "${target%.gif}.palette.png" || die "cannot write the palette beside $target"
  fi
  MADE=$((MADE + 1))
  TOTAL_BYTES=$((TOTAL_BYTES + best_bytes))
  log "wrote $target"
done <<EOF
$INPUTS
EOF

if [ "$MADE" -gt 0 ]; then
  # The number a reviewer actually needs: video gets no delta compression, so
  # this is what the commit adds to the repository, permanently.
  printf 'to-gif: %d GIF(s), %d bytes total (%s) added if committed\n' \
    "$MADE" "$TOTAL_BYTES" "$(human "$TOTAL_BYTES")"
fi

exit "$FAILED"
