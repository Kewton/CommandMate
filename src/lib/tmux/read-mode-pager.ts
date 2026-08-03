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
 * awk implementation of {@link import('./transcript-squeeze').squeezeTranscript}.
 *
 * Mirrors the TypeScript rules exactly:
 * - `ANSI` is built from `sprintf("%c")` rather than a regex literal because
 *   `\033` / `\a` escapes inside a regex literal are not portable across awk
 *   implementations (macOS ships BWK awk, Linux usually gawk/mawk).
 * - NBSP (UTF-8 `C2 A0`) is folded to a space before trimming, because
 *   JavaScript's `.trim()` treats U+00A0 as whitespace and awk's `[ \t]` does not.
 *   Without this the two implementations disagree on NBSP-only rows.
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
# CommandMate reading mode (Issue #1623) — generated file, edits are overwritten.
#
# Renders the transcript of a CommandMate tmux session with layout-only blank rows
# squeezed away, so a pager lands on the composer instead of hundreds of rows of
# padding. Invoked by \`prefix+g\` through \`display-popup -E\`; also runnable by hand:
#
#   sh ~/.commandmate/bin/${PAGER_SCRIPT_FILENAME} mcbd-claude-my-worktree
#
# The popup is a SNAPSHOT. Press the key again to refresh it.
set -u

SESSION="\${1:-}"
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

if [ -n "\${CM_READ_PAGER:-}" ]; then
  PAGER_CMD="$CM_READ_PAGER"
elif command -v less >/dev/null 2>&1; then
  PAGER_CMD="less -R +G"
else
  PAGER_CMD="cat"
fi

tmux capture-pane -pe -t "=$SESSION:" -S "-$LINES_BACK" -E - \\
  | awk '${SQUEEZE_AWK_PROGRAM}' \\
  | $PAGER_CMD

# Without a pager the popup would close before anything could be read.
if [ "$PAGER_CMD" = "cat" ]; then
  printf '\\n[CommandMate] end of transcript — press Enter to close.' >&2
  read -r _unused || true
fi
`;
