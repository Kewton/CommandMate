/**
 * The shell pager that `prefix+g` opens inside a tmux popup (Issue #1623, 案A).
 *
 * ## Why the script is embedded here instead of shipped as a file
 *
 * `package.json`'s `files` list publishes `bin/`, `dist/`, `.next/`, `public/`,
 * `scripts/hooks/` and `.env.example` — NOT `scripts/`. A path into the repo
 * therefore does not exist in a global install, and an `npx` install lives in a
 * cache directory npm may garbage-collect out from under a long-lived `bind-key`.
 * Embedding the text and materializing it into `~/.commandmate/bin/` gives the
 * binding one absolute path that is stable across global / local / npx installs.
 *
 * ## Why the squeeze is reimplemented in awk
 *
 * The popup must not depend on the CommandMate server, a node binary, or a built
 * `dist/` — it only has tmux and a shell. awk is present everywhere those are.
 * The duplication is not left to trust: `tests/unit/lib/tmux/transcript-squeeze.test.ts`
 * runs THIS awk program over real captures and asserts byte equality with
 * `squeezeTranscript()`, so the two cannot drift apart silently.
 */

/**
 * Locale the squeeze awk program MUST run under.
 *
 * Not cosmetic — the program is byte-oriented by construction, and `%c` is the
 * one place where awk implementations disagree about what a "character" is:
 *
 * | awk                     | `sprintf("%c", 194)` |
 * |-------------------------|----------------------|
 * | mawk, BWK awk           | byte `0xC2`          |
 * | gawk, `LC_ALL=C`        | byte `0xC2`          |
 * | gawk, `*.UTF-8` locale  | U+00C2 -> `C3 82`    |
 *
 * `NBSP` below is assembled from bytes `C2 A0`, so under gawk in a UTF-8 locale
 * it becomes a four-byte string that can never match a real NBSP — NBSP-only
 * rows stop counting as blank and the frame comes back unsqueezed. That is not
 * hypothetical: it is exactly how this shipped broken, green on macOS (BWK awk)
 * and red on `ubuntu-latest`, whose `/usr/bin/awk` is gawk (Debian ranks the
 * gawk alternative above mawk) under a UTF-8 locale.
 *
 * Pinning the locale — rather than making the regex match both encodings — is
 * deliberate: an alternation covering the character form
 * (`sprintf("%c%c",194,160) "|" sprintf("%c",160)`) fixes gawk but makes BWK awk
 * abort with `multibyte conversion failure` in a UTF-8 locale. Measured on all
 * three implementations, `LC_ALL=C` is the only setting where every one of them
 * agrees, and it is byte-transparent: the same 1000-row fixture comes out with
 * an identical sha256 from BWK awk, mawk and gawk.
 *
 * Scoped to the awk process alone, so `less` and tmux keep the user's locale and
 * still render UTF-8 box drawing.
 */
export const SQUEEZE_AWK_LOCALE = 'C';

/**
 * awk implementation of {@link import('./transcript-squeeze').squeezeTranscript}.
 *
 * Mirrors the TypeScript rules exactly:
 * - `ANSI` is built from `sprintf("%c")` rather than a regex literal because
 *   `\033` / `\a` escapes inside a regex literal are not portable across awk
 *   implementations (macOS ships BWK awk, Linux usually gawk/mawk).
 * - NBSP (UTF-8 `C2 A0`) is folded to a space before trimming, because
 *   JavaScript's `.trim()` treats U+00A0 as whitespace and awk's `[ \t]` does not.
 *   Without this the two implementations disagree on NBSP-only rows. This is the
 *   line that requires {@link SQUEEZE_AWK_LOCALE} — read that doc before editing.
 * - Leading/trailing blank runs are dropped, runs of 1-2 kept verbatim, runs of
 *   3+ collapsed to a single row carrying the run's ANSI sequences.
 */
export const SQUEEZE_AWK_PROGRAM = `BEGIN {
  ESC = sprintf("%c", 27); BEL = sprintf("%c", 7); NBSP = sprintf("%c%c", 194, 160)
  ANSI = ESC "\\\\[[0-9;]*[a-zA-Z]|" ESC "\\\\][^" BEL "]*" BEL "|\\\\[[0-9;]*m"
  n = 0
}
{ line[++n] = $0 }
END {
  for (i = 1; i <= n; i++) {
    s = line[i]; gsub(ANSI, "", s); gsub(NBSP, " ", s)
    gsub(/^[ \\t\\r\\f\\v]+|[ \\t\\r\\f\\v]+$/, "", s)
    blank[i] = (s == "")
  }
  seen = 0; i = 1
  while (i <= n) {
    if (!blank[i]) { print line[i]; seen = 1; i++; continue }
    j = i; while (j <= n && blank[j]) j++
    if (seen && j <= n) {
      if (j - i <= 2) { for (k = i; k < j; k++) print line[k] }
      else {
        joined = ""; for (k = i; k < j; k++) joined = joined line[k]
        keep = ""
        while (match(joined, ANSI)) {
          keep = keep substr(joined, RSTART, RLENGTH); joined = substr(joined, RSTART + RLENGTH)
        }
        print keep
      }
    }
    i = j
  }
}`;

/** Basename of the materialized script. */
export const PAGER_SCRIPT_FILENAME = 'cm-read-pane.sh';

/**
 * Full text of the pager script.
 *
 * Session resolution is done INSIDE the script on purpose. `display-popup` does
 * NOT expand tmux formats in its shell-command (measured on 3.5a: a literal
 * `#{session_name}` reaches the shell unexpanded), so the session cannot be baked
 * into the binding. `tmux display-message -p` inside the popup returns the correct
 * session and client, which is what makes one global binding serve every session.
 *
 * `=NAME:` is the exact-match target form required by Issue #1156 — a bare name
 * prefix-matches and would show the `-2` instance's pane while the primary is
 * stopped.
 */
export const PAGER_SCRIPT = `#!/bin/sh
# CommandMate reading mode (Issue #1623; --follow added by #2317) — generated file, edits are overwritten.
#
# Renders the transcript of a CommandMate tmux session with layout-only blank rows
# squeezed away, so a pager lands on the composer instead of hundreds of rows of
# padding. Invoked by \`prefix+g\` through \`display-popup -E\`; also runnable by hand:
#
#   sh ~/.commandmate/bin/${PAGER_SCRIPT_FILENAME} mcbd-claude-my-worktree
#   sh ~/.commandmate/bin/${PAGER_SCRIPT_FILENAME} --follow mcbd-claude-my-worktree
#
# Without --follow the popup is a SNAPSHOT. Press the key again to refresh it.
# With --follow (Issue #2317 Phase C) it redraws every CM_READ_FOLLOW_INTERVAL
# seconds and closes on \`q\`. Neither mode alters the pane, the window or the
# session — the popup is per-client and leaves nothing behind when it closes.
set -u

FOLLOW=0
SESSION=""
for arg in "$@"; do
  case "$arg" in
    --follow|-f) FOLLOW=1 ;;
    -*) ;;
    *) if [ -z "$SESSION" ]; then SESSION="$arg"; fi ;;
  esac
done

if [ -z "$SESSION" ]; then
  SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null) || SESSION=""
fi
if [ -z "$SESSION" ]; then
  echo "cm-read-pane: no tmux session given and none could be resolved" >&2
  exit 1
fi

LINES_BACK="\${CM_READ_LINES:-1000}"
case "$LINES_BACK" in
  ''|*[!0-9]*) LINES_BACK=1000 ;;
esac

# LC_ALL is pinned for awk ONLY (not for less, which still renders UTF-8 box
# drawing in the user's locale). Under gawk in a UTF-8 locale, sprintf("%c",194)
# yields U+00C2 rather than the byte 0xC2 and the NBSP fold below silently stops
# matching. See SQUEEZE_AWK_LOCALE in read-mode-pager.ts.
cm_read_render() {
  tmux capture-pane -pe -t "=$SESSION:" -S "-$LINES_BACK" -E - \\
    | LC_ALL=${SQUEEZE_AWK_LOCALE} awk '${SQUEEZE_AWK_PROGRAM}'
}

if [ "$FOLLOW" = "1" ]; then
  INTERVAL="\${CM_READ_FOLLOW_INTERVAL:-2}"
  case "$INTERVAL" in
    ''|*[!0-9]*) INTERVAL=2 ;;
  esac
  if [ "$INTERVAL" -lt 1 ]; then INTERVAL=1; fi
  # The key check below waits 0.2s per tick (stty \`time 2\`), so one tick is a
  # fifth of a second and the key is answered long before the next redraw.
  TICKS=$((INTERVAL * 5))

  OLD_STTY=$(stty -g 2>/dev/null) || OLD_STTY=""
  cm_read_restore_tty() {
    if [ -n "$OLD_STTY" ]; then stty "$OLD_STTY" 2>/dev/null || true; fi
    printf '\\033[?25h'
  }
  trap 'cm_read_restore_tty' EXIT
  trap 'cm_read_restore_tty; exit 0' INT TERM
  # \`min 0 time 2\` is what makes a single-byte read non-blocking-with-a-deadline:
  # it returns after 0.2s with nothing when no key was pressed. Without it the
  # loop would either block forever on the key or busy-spin between redraws.
  if [ -n "$OLD_STTY" ]; then stty -icanon -echo min 0 time 2 2>/dev/null || true; fi
  printf '\\033[?25l'

  ROWS=$(tput lines 2>/dev/null) || ROWS=40
  case "$ROWS" in
    ''|*[!0-9]*) ROWS=40 ;;
  esac
  BODY_ROWS=$((ROWS - 2))
  if [ "$BODY_ROWS" -lt 1 ]; then BODY_ROWS=1; fi

  while :; do
    FRAME=$(cm_read_render | tail -n "$BODY_ROWS")
    printf '\\033[H\\033[2J%s\\n' "$FRAME"
    printf '\\033[7m[CommandMate] following %s — press q to close\\033[0m' "$SESSION"
    TICK=0
    while [ "$TICK" -lt "$TICKS" ]; do
      if [ -n "$OLD_STTY" ]; then
        KEY=$(dd bs=1 count=1 2>/dev/null)
        case "$KEY" in
          q|Q) exit 0 ;;
        esac
      else
        sleep 1
        TICK="$TICKS"
      fi
      TICK=$((TICK + 1))
    done
  done
fi

if [ -n "\${CM_READ_PAGER:-}" ]; then
  PAGER_CMD="$CM_READ_PAGER"
elif command -v less >/dev/null 2>&1; then
  PAGER_CMD="less -R +G"
else
  PAGER_CMD="cat"
fi

cm_read_render | $PAGER_CMD

# Without a pager the popup would close before anything could be read.
if [ "$PAGER_CMD" = "cat" ]; then
  printf '\\n[CommandMate] end of transcript — press Enter to close.' >&2
  read -r _unused || true
fi
`;
