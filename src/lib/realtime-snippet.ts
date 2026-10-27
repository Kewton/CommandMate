/**
 * The rows `CurrentOutputPayload.realtimeSnippet` publishes (Issue #2768).
 *
 * The snippet has always been "the last 100 rows of the capture". CommandMate
 * pins agent panes to 200x1000, and an inline tool (codex, antigravity, Command
 * Code, gemini, vibe-local) paints from the TOP of that canvas: until a session
 * has scrolled a thousand rows, everything it has drawn sits in rows 1..N and
 * rows N+1..1000 are blank. The last 100 rows of such a capture are 100 empty
 * strings — measured on a live Command Code pane whose content ended at row 173.
 *
 * So the window is anchored to the last row that carries content, but ONLY when
 * the plain tail window is entirely blank. Any frame whose last 100 rows hold so
 * much as one glyph is returned exactly as before, which is every bottom-anchored
 * (alternate-screen) tool and every inline session that has filled its canvas.
 *
 * Browser-safe on purpose: the server builds the payload with it and
 * `useTerminalPanePolling` rebuilds the same field from a pushed snapshot, and
 * the two must not be able to disagree about one frame.
 */

import { stripAnsi } from '@/lib/detection/ansi';
import {
  matchCodexErrorRowFault,
  matchUpstreamFault,
  type UpstreamFaultMatch,
} from '@/lib/detection/upstream-faults';

/** Rows in the snippet. The 100 that Issue #1839 / #2095 read their verdicts off. */
export const REALTIME_SNIPPET_ROW_COUNT = 100;

function isBlankRow(row: string): boolean {
  return stripAnsi(row).trim() === '';
}

/**
 * Pick the snippet rows out of a capture already split on `\n`.
 *
 * @param lines - every row of the capture, in order
 * @returns at most {@link REALTIME_SNIPPET_ROW_COUNT} rows
 */
export function selectRealtimeSnippetRows(lines: readonly string[]): string[] {
  const tail = lines.slice(-REALTIME_SNIPPET_ROW_COUNT);
  if (tail.some((row) => !isBlankRow(row))) return tail;

  let last = lines.length - 1;
  while (last >= 0 && isBlankRow(lines[last])) last -= 1;
  // Nothing on the pane at all: the old answer (a run of blank rows) is as good
  // as any, and keeping it means an empty pane is reported exactly as before.
  if (last < 0) return tail;
  return lines.slice(Math.max(0, last + 1 - REALTIME_SNIPPET_ROW_COUNT), last + 1);
}

/** {@link selectRealtimeSnippetRows}, joined the way the payload carries it. */
export function buildRealtimeSnippet(output: string): string {
  return selectRealtimeSnippetRows(output.split('\n')).join('\n');
}

/**
 * The last content row of a split screen's transcript, when it lies above the
 * snippet window (Issue #3946).
 *
 * codex 0.160 paints its transcript from the top of the 1000-row canvas and its
 * composer at the bottom, with blank rows in between. The window
 * {@link selectRealtimeSnippetRows} returns then holds the composer (so #2768's
 * blank-tail branch does not apply) and the transcript's last row — where codex
 * draws an error such as `■ Selected model is at capacity` — is outside it.
 *
 * Returns that one row only when the window's first row is blank, the blank run
 * continues above the window, and content sits above the run; `null` otherwise.
 * One row, not the transcript: a healthy next turn replaces it, so an old error
 * row stops counting, and no reply body (which may quote an error) is read.
 *
 * @param lines - every row of the capture, in order
 */
export function selectTranscriptTailRow(lines: readonly string[]): string | null {
  const windowStart = lines.length - REALTIME_SNIPPET_ROW_COUNT;
  if (windowStart <= 0) return null;
  // A blank tail means #2768 already anchored the window to the last content row.
  if (lines.slice(windowStart).every(isBlankRow)) return null;
  if (!isBlankRow(lines[windowStart])) return null;
  let row = windowStart - 1;
  while (row >= 0 && isBlankRow(lines[row])) row -= 1;
  return row >= 0 ? lines[row] : null;
}

/**
 * The upstream fault `capture --json` publishes and the push poller rings on —
 * one entry for both, so they cannot judge different rows (#3936, #3946).
 *
 * The window ({@link selectRealtimeSnippetRows}, what `realtimeSnippet` carries)
 * is judged on every rule first. Only if nothing matched, and only for codex, the
 * row {@link selectTranscriptTailRow} returns is judged on the rules anchored to
 * codex's `■ ` error row. A match there is outside `realtimeSnippet`; its
 * `matchedText` is the row, which is how an operator can check it.
 *
 * @param lines - every row of the capture, in order
 * @param cliToolId - the agent the pane belongs to
 */
export function matchPaneUpstreamFault(
  lines: readonly string[],
  cliToolId: string,
): UpstreamFaultMatch | null {
  const inWindow = matchUpstreamFault(selectRealtimeSnippetRows(lines).join('\n'));
  if (inWindow || cliToolId !== 'codex') return inWindow;
  const tailRow = selectTranscriptTailRow(lines);
  return tailRow === null ? null : matchCodexErrorRowFault(tailRow);
}
