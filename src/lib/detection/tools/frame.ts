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
import { LIVE_REGION_SPECS } from './live-region-specs';
import { locateLiveRegion } from './live-region';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { LiveRegion, NormalizedFrame } from './types';

/**
 * Number of lines from the end to check for prompt and input indicators.
 *
 * Moved here from `status-detector.ts` (Issue #1927) because it is the window
 * every tool module measures against; re-exported from the facade so the many
 * existing importers are unaffected.
 */
export const STATUS_CHECK_LINE_COUNT: number = 15;

/**
 * Build the shared {@link NormalizedFrame} for one capture.
 *
 * @param output - The capture. Pass it as captured (ANSI and box drawing
 *   intact): the input-box markers of claude / Command Code / copilot / opencode
 *   are rule rows that `stripBoxDrawing` blanks.
 * @param tool - The CLI the capture came from. Names the live-region declaration
 *   to apply (Issue #3183); omitted, the region is the whole frame — the reading
 *   every rule had before.
 */
export function normalizeFrame(output: string, tool?: CLIToolType): NormalizedFrame {
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
    liveRegion: locateLiveRegion(tool === undefined ? undefined : LIVE_REGION_SPECS[tool], tool ?? null, {
      raw: output,
      contentLines,
    }),
    lastLines: contentLines.slice(-STATUS_CHECK_LINE_COUNT).join('\n'),
    // DR-003: Separate thinking detection window (5 lines) from prompt detection window (15 lines)
    thinkingLines: contentLines.slice(-THINKING_TAIL_LINE_COUNT).join('\n'),
  };
}

/**
 * The live region of `frame` as `tool` declares it (Issue #3183).
 *
 * `frame.liveRegion` when the frame was normalised for `tool`; recomputed
 * otherwise — a caller that built the frame without naming the tool (older
 * call sites, tests) still gets the tool's own reading, never a stale one.
 */
export function liveRegionOf(frame: NormalizedFrame, tool: CLIToolType): LiveRegion {
  if (frame.liveRegion.tool === tool) return frame.liveRegion;
  return locateLiveRegion(LIVE_REGION_SPECS[tool], tool, { raw: frame.raw, contentLines: frame.contentLines });
}

/** `frame` with its live region located for `tool` (the same object when it already is). */
export function withLiveRegion(frame: NormalizedFrame, tool: CLIToolType): NormalizedFrame {
  const liveRegion = liveRegionOf(frame, tool);
  return liveRegion === frame.liveRegion ? frame : { ...frame, liveRegion };
}
