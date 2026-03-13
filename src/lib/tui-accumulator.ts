/**
 * TUI Response Accumulator (Layer 2: Polling Accumulation)
 *
 * OpenCode runs in full-screen TUI (alternate screen mode) where tmux
 * capture-pane only returns visible rows (no scrollback). When a response
 * exceeds the visible pane height, earlier content scrolls away permanently.
 * The accumulator captures content across polling intervals, detects overlap
 * with previously captured lines, and appends only new content.
 *
 * Issue #479: Extracted from response-poller.ts for single-responsibility separation
 */

import {
  stripAnsi,
  stripBoxDrawing,
  OPENCODE_SKIP_PATTERNS,
  OPENCODE_RESPONSE_COMPLETE,
} from './detection/cli-patterns';

/**
 * State for accumulating TUI content across polling intervals.
 * Each active OpenCode session has one accumulator entry.
 */
interface TuiAccumulatorState {
  /** Accumulated content lines (grows across polls) */
  lines: string[];
  /** Last N lines from previous capture, used for overlap detection */
  lastFingerprint: string[];
  /** Number of polls accumulated */
  pollCount: number;
}

/**
 * Number of lines from the end of accumulated content to use as
 * fingerprint for overlap detection with the next capture.
 */
const OVERLAP_FINGERPRINT_SIZE = 10;

/**
 * Per-session TUI response accumulator storage.
 * Key: pollerKey ("worktreeId:cliToolId")
 *
 * Module-scope variable (not globalThis). Node.js module cache ensures
 * singleton behavior. See D3-004 in design policy for details.
 */
const tuiResponseAccumulator = new Map<string, TuiAccumulatorState>();

/**
 * Normalize a single OpenCode TUI line by removing ANSI codes and border glyphs.
 * Returns an empty string when the line has no meaningful content after cleanup.
 */
function normalizeOpenCodeLine(line: string): string {
  return stripBoxDrawing(stripAnsi(line))
    .replace(/^\u2503\s?/, '')
    .replace(/\s*\u2503$/, '')
    .trim();
}

/**
 * Extract meaningful content lines from raw TUI output.
 * Strips ANSI codes, box-drawing characters, and lines matching OPENCODE_SKIP_PATTERNS.
 *
 * @param rawOutput - Raw tmux capture-pane output
 * @returns Array of cleaned, non-empty content lines
 *
 * @internal Exported for unit testing
 */
export function extractTuiContentLines(rawOutput: string): string[] {
  const lines = rawOutput.split('\n');
  const contentLines: string[] = [];

  for (const line of lines) {
    const cleaned = normalizeOpenCodeLine(line);
    if (!cleaned) continue;

    const shouldSkip = OPENCODE_SKIP_PATTERNS.some(pattern => pattern.test(cleaned));
    if (shouldSkip) continue;

    // Also skip the Build summary line (completion indicator)
    if (OPENCODE_RESPONSE_COMPLETE.test(cleaned)) continue;

    contentLines.push(cleaned);
  }

  return contentLines;
}

/**
 * Find the overlap index between previously accumulated lines and newly captured lines.
 * Searches for the longest suffix of `previous` that matches a prefix of `current`.
 *
 * @param previous - Previously accumulated lines (fingerprint subset)
 * @param current - Newly captured content lines
 * @returns Number of overlapping lines (0 if no overlap found)
 *
 * @internal Exported for unit testing
 */
export function findOverlapIndex(previous: string[], current: string[]): number {
  if (previous.length === 0 || current.length === 0) return 0;

  // Try decreasing overlap sizes: full fingerprint down to 1 line
  const maxOverlap = Math.min(previous.length, current.length);

  for (let overlapSize = maxOverlap; overlapSize >= 1; overlapSize--) {
    // Check if the last `overlapSize` lines of previous match
    // the first `overlapSize` lines of current
    const prevSlice = previous.slice(-overlapSize);
    const currSlice = current.slice(0, overlapSize);

    let matches = true;
    for (let i = 0; i < overlapSize; i++) {
      if (prevSlice[i] !== currSlice[i]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return overlapSize;
    }
  }

  return 0;
}

/**
 * Initialize the TUI accumulator for a polling session.
 *
 * @param pollerKey - Poller key ("worktreeId:cliToolId")
 *
 * @internal Exported for unit testing
 */
export function initTuiAccumulator(pollerKey: string): void {
  tuiResponseAccumulator.set(pollerKey, {
    lines: [],
    lastFingerprint: [],
    pollCount: 0,
  });
}

/**
 * Accumulate TUI content from a new capture into the session buffer.
 * Detects overlap with previous capture and appends only new lines.
 *
 * @param pollerKey - Poller key ("worktreeId:cliToolId")
 * @param rawOutput - Raw tmux capture-pane output
 *
 * @internal Exported for unit testing
 */
export function accumulateTuiContent(pollerKey: string, rawOutput: string): void {
  const state = tuiResponseAccumulator.get(pollerKey);
  if (!state) return;

  const contentLines = extractTuiContentLines(rawOutput);
  if (contentLines.length === 0) return;

  state.pollCount++;

  if (state.lines.length === 0) {
    // First capture: seed with all content
    state.lines = [...contentLines];
  } else {
    // Subsequent captures: find overlap and append new lines
    const overlapCount = findOverlapIndex(state.lastFingerprint, contentLines);

    if (overlapCount > 0) {
      // Append only lines after the overlap
      const newLines = contentLines.slice(overlapCount);
      state.lines.push(...newLines);
    } else {
      // No overlap found: append all content (completeness over dedup)
      state.lines.push(...contentLines);
    }
  }

  // Update fingerprint for next poll
  state.lastFingerprint = contentLines.slice(-OVERLAP_FINGERPRINT_SIZE);
}

/**
 * Get the accumulated content as a single string.
 *
 * @param pollerKey - Poller key ("worktreeId:cliToolId")
 * @returns Accumulated content joined by newlines, or empty string if no accumulator
 *
 * @internal Exported for unit testing
 */
export function getAccumulatedContent(pollerKey: string): string {
  const state = tuiResponseAccumulator.get(pollerKey);
  if (!state || state.lines.length === 0) return '';
  return state.lines.join('\n');
}

/**
 * Clear the TUI accumulator for a polling session.
 *
 * @param pollerKey - Poller key ("worktreeId:cliToolId")
 *
 * @internal Exported for unit testing
 */
export function clearTuiAccumulator(pollerKey: string): void {
  tuiResponseAccumulator.delete(pollerKey);
}

/** @internal Re-exported for response-cleaner.ts (cleanOpenCodeResponse) */
export { normalizeOpenCodeLine };
