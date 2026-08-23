/**
 * How many rows a status probe asks tmux for, per tool (Issue #1933, §10.12).
 *
 * The ladder this replaces lived in `src/lib/session/worktree-status-helper.ts`
 * as a private `getStatusCaptureLines()`, which meant a module outside
 * `src/lib/cli-tools/**` had to import `@/lib/cli-tools/opencode` and
 * `@/lib/cli-tools/gemini` for two numbers — dragging opencode's
 * `child_process` use and gemini's whole graph into the sidebar's status poll,
 * and forcing four unrelated test files to mock both tool modules just to reach
 * a capture count.
 *
 * @module lib/cli-tools/capture-spec
 */

import { OPENCODE_PANE_HEIGHT } from '@/config/tmux-pane-config';
import { STATUS_DETECTION_CAPTURE_LINES } from '@/config/status-capture-config';
import type { CaptureSpec } from '@/types/cli-tool-contracts';
import { usesAlternateScreen, type CLIToolType } from './types';

/**
 * Gemini tmux pane height (rows).
 *
 * Declared here since Issue #1933 and re-exported from `./gemini`, so existing
 * importers are unchanged. It moved for the same reason `OPENCODE_PANE_HEIGHT`
 * moved to `@/config/tmux-pane-config` in #1906: the module that needs the
 * number must not have to import the tool.
 */
export const GEMINI_PANE_HEIGHT = 200;

/**
 * The capture description for a CLI tool.
 *
 * A tool with a fixed pane height asks for exactly that height, because it
 * renders in the alternate screen and `capture-pane` can return nothing else.
 * Everything else asks for {@link STATUS_DETECTION_CAPTURE_LINES}: detection
 * trims trailing blank padding before windowing, so it only needs the captured
 * slice to reach past that padding to the real content, and asking for the
 * display path's 10000 rows on every sidebar poll was measurably wasteful
 * (#965).
 *
 * @param cliToolId - CLI tool identifier
 * @returns That tool's {@link CaptureSpec}
 */
export function resolveCaptureSpec(cliToolId: CLIToolType): CaptureSpec {
  return {
    statusLines: resolveStatusCaptureLines(cliToolId),
    usesAlternateScreen: usesAlternateScreen(cliToolId),
  };
}

function resolveStatusCaptureLines(cliToolId: CLIToolType): number {
  if (cliToolId === 'opencode') return OPENCODE_PANE_HEIGHT;
  if (cliToolId === 'gemini') return GEMINI_PANE_HEIGHT;
  return STATUS_DETECTION_CAPTURE_LINES;
}
