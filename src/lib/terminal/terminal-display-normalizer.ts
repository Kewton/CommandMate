/**
 * Display-only whitespace normalization for TUI terminal panes (Issue #1172).
 *
 * Claude Code / Codex run in tmux's alternate screen pinned to a fixed
 * `TUI_PANE_HEIGHT` (1000 rows, see `src/config/tmux-pane-config.ts`). The
 * captured frame anchors interactive content near the top and a task panel near
 * the bottom, leaving hundreds of layout-only blank rows in between. Rendered
 * verbatim, the Web UI auto-follows to the bottom and the user must scroll up
 * hundreds of rows to see the prompt.
 *
 * This helper compresses runs of visually-blank rows for DISPLAY ONLY. It never
 * touches the raw output used for status/prompt detection, Auto-Yes, response
 * saving, transport, or line counting — those keep full fidelity. The transform
 * is pure and idempotent, preserves every non-blank line (content, order,
 * duplicates), and generates no HTML (the result still flows through
 * `sanitizeTerminalOutput()` / DOMPurify downstream).
 */

import { stripAnsi, extractAnsiSequences } from '@/lib/detection/ansi';

/** A line is visually blank if it has no printable content once ANSI is stripped. */
function isVisuallyBlank(line: string): boolean {
  return stripAnsi(line).trim() === '';
}

/**
 * Normalize terminal output for display.
 *
 * Rules (see Issue #1172 acceptance criteria):
 * 1. Line visibility is judged on `stripAnsi(line).trim()`.
 * 2. Leading and trailing blank runs are removed (trimmed to 0 rows).
 * 3. An internal blank run of 1–2 rows is kept verbatim.
 * 4. An internal blank run of 3+ rows collapses to exactly ONE blank row that
 *    carries the run's ANSI escape sequences (in order) so color/reset state
 *    spanning the gap still applies to subsequent rows. Whitespace glyphs are
 *    dropped; ANSI-only rows are not simply deleted, their sequences survive.
 * 5. Non-blank lines are never altered.
 * 6. No artificial "N rows omitted" marker is inserted.
 */
export function normalizeTerminalOutputForDisplay(output: string): string {
  if (output === '') return '';

  const lines = output.split('\n');
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

    // Consume the full run of consecutive blank lines starting at i.
    let j = i;
    while (j < lines.length && isVisuallyBlank(lines[j])) j++;
    const runLength = j - i;
    const isLeading = !seenContent;
    const isTrailing = j >= lines.length;

    if (!isLeading && !isTrailing) {
      if (runLength <= 2) {
        for (let k = i; k < j; k++) result.push(lines[k]);
      } else {
        // Collapse to a single blank row, preserving any ANSI state transitions.
        result.push(extractAnsiSequences(lines.slice(i, j).join('')));
      }
    }
    // Leading/trailing blank runs are dropped entirely (trimmed to 0 rows).

    i = j;
  }

  return result.join('\n');
}
