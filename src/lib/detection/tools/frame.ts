/**
 * Normalise a capture once, for every branch of the detection chain
 * (Issue #1927).
 *
 * Lifted verbatim out of the head of `detectSessionStatus`, where the same six
 * projections were computed inline and then threaded through a thousand lines of
 * per-tool branches. Nothing about the arithmetic changed; what changed is that
 * a tool module can now be handed the frame instead of recomputing its own idea
 * of where the content ends.
 */

import { stripAnsi } from '../cli-patterns';
import { normalizeTuiFrameForDetection } from '../tui-detection-frame';
import { THINKING_TAIL_LINE_COUNT } from '@/config/thinking-constants';
import type { NormalizedFrame } from './types';

/**
 * Number of lines from the end to check for prompt and input indicators.
 *
 * Moved here from `status-detector.ts` (Issue #1927) because it is the window
 * every tool module measures against; re-exported from the facade so the many
 * existing importers are unaffected.
 */
export const STATUS_CHECK_LINE_COUNT: number = 15;

/** Build the shared {@link NormalizedFrame} for one capture. */
export function normalizeFrame(output: string): NormalizedFrame {
  const clean = normalizeTuiFrameForDetection(stripAnsi(output));
  const lines = clean.split('\n');

  // Strip trailing empty lines (tmux terminal padding) before windowing.
  // tmux buffers often end with many empty padding lines that would otherwise
  // fill the entire detection window, hiding the actual prompt/status content.
  let lastNonEmptyIndex = lines.length - 1;
  while (lastNonEmptyIndex >= 0 && lines[lastNonEmptyIndex].trim() === '') {
    lastNonEmptyIndex--;
  }
  const contentLines = lines.slice(0, lastNonEmptyIndex + 1);

  return {
    raw: output,
    clean,
    lines,
    contentLines,
    lastLines: contentLines.slice(-STATUS_CHECK_LINE_COUNT).join('\n'),
    // DR-003: Separate thinking detection window (5 lines) from prompt detection window (15 lines)
    thinkingLines: contentLines.slice(-THINKING_TAIL_LINE_COUNT).join('\n'),
  };
}
