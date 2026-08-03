/**
 * Whitespace squeeze for the on-demand reading mode (Issue #1623).
 *
 * TUI sessions are pinned to a 200x1000 canvas (`src/config/tmux-pane-config.ts`)
 * and the agent draws its transcript near the top and its composer at the very
 * bottom, so a raw `capture-pane` is mostly layout-only blank rows. Measured on a
 * live `mcbd-claude-*` session: 1000 rows, 480 truly empty, 7 more that LOOK empty
 * but carry an SGR sequence (`ESC[49m`) and therefore survive a naive
 * `grep -v '^$'` or `less -s`. Squeezing those runs is what makes `less +G` land
 * on the composer instead of hundreds of rows below the last readable line.
 *
 * ## Relationship to the Web UI normalizer
 *
 * `src/lib/terminal/terminal-display-normalizer.ts` (Issue #1172) solves the same
 * problem for the browser terminal and its rules are the ones reproduced here.
 * This module exists as a separate entry point rather than importing that one
 * because the CLI is compiled by `tsconfig.cli.json`, which sets `"paths": {}` —
 * the normalizer's `@/lib/detection/ansi` import fails there with TS2307 (verified
 * by adding the import and running `tsc --project tsconfig.cli.json`), while the
 * relative import below resolves under every build. The two are held byte-identical
 * by a conformance test over real captures
 * (`tests/unit/lib/tmux/transcript-squeeze.test.ts`), so neither can drift.
 *
 * The transform is DISPLAY-ONLY. Nothing here touches the raw output that status
 * detection, Auto-Yes, the response saver or the DB record consume — those keep
 * full fidelity and full line counts.
 */

import { stripAnsi, extractAnsiSequences } from '../detection/ansi';

/**
 * A line is visually blank when nothing printable remains after ANSI removal.
 *
 * `.trim()` is deliberate: ECMAScript's WhiteSpace includes U+00A0, which the
 * Claude composer emits (`ESC[38;5;246m❯ ESC[39m`). That line still holds
 * `❯`, so it is content either way, but a row of pure NBSP correctly reads blank.
 */
export function isVisuallyBlank(line: string): boolean {
  return stripAnsi(line).trim() === '';
}

/** Options for {@link squeezeTranscript}. */
export interface SqueezeOptions {
  /**
   * Keep only the last N lines OF THE SQUEEZED RESULT (Issue #1623 decision D5).
   *
   * Tailing after the squeeze rather than before it is what makes the number
   * meaningful: `--tail 40` on a 1000-row canvas whose transcript ends at row 254
   * would otherwise return 40 rows of blank padding. Undefined or <= 0 keeps
   * everything.
   */
  tail?: number;
}

/** Outcome of a squeeze, including the counts callers report in `--json`. */
export interface SqueezeResult {
  /** Squeezed transcript, no trailing newline. */
  text: string;
  /** Line count of the input, before squeezing. */
  rawLines: number;
  /** Line count of {@link text}. */
  lines: number;
  /** True when {@link SqueezeOptions.tail} actually dropped leading lines. */
  tailed: boolean;
}

/**
 * Collapse layout-only blank rows in a `capture-pane` frame.
 *
 * Rules (identical to `normalizeTerminalOutputForDisplay`, Issue #1172):
 * 1. Blankness is judged on `stripAnsi(line).trim()`.
 * 2. Leading and trailing blank runs are removed entirely.
 * 3. An internal blank run of 1-2 rows is kept verbatim (real paragraph spacing).
 * 4. An internal blank run of 3+ rows collapses to ONE row carrying that run's
 *    ANSI sequences in order, so a color/reset that spans the gap still applies
 *    to the rows below it.
 * 5. Non-blank lines are never altered — content, order and duplicates survive.
 *
 * @param raw - Raw `capture-pane -pe` output
 * @param options - Tail limit
 * @returns The squeezed text plus before/after line counts
 */
export function squeezeTranscript(raw: string, options: SqueezeOptions = {}): SqueezeResult {
  const lines = raw === '' ? [] : raw.split('\n');
  const result: string[] = [];
  let seenContent = false;
  let i = 0;

  while (i < lines.length) {
    if (!isVisuallyBlank(lines[i])) {
      result.push(lines[i]);
      seenContent = true;
      i++;
      continue;
    }

    let j = i;
    while (j < lines.length && isVisuallyBlank(lines[j])) j++;

    const isLeading = !seenContent;
    const isTrailing = j >= lines.length;
    if (!isLeading && !isTrailing) {
      if (j - i <= 2) {
        for (let k = i; k < j; k++) result.push(lines[k]);
      } else {
        result.push(extractAnsiSequences(lines.slice(i, j).join('')));
      }
    }

    i = j;
  }

  const tail = options.tail;
  const tailed = tail !== undefined && tail > 0 && result.length > tail;
  const kept = tailed ? result.slice(result.length - tail!) : result;

  return {
    text: kept.join('\n'),
    rawLines: lines.length,
    lines: kept.length,
    tailed,
  };
}
