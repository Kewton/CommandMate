/**
 * Frame → detection verdicts (Issue #1727).
 *
 * Both call shapes are copied from production so a canary result means what it
 * says:
 *
 * - status path — `src/lib/session/worktree-status-helper.ts` passes the RAW
 *   `capture-pane -p -e` output to `detectSessionStatus()`, which strips ANSI
 *   itself. Stripping it here would hide an escape-sequence regression.
 * - Auto-Yes path — `src/lib/auto-yes-poller.ts` does NOT go through
 *   status-detector: it calls `detectPrompt(stripBoxDrawing(stripAnsi(output)))`
 *   directly. A prompt only one of the two sees is exactly the class of bug the
 *   canary is for (#1495 changed the default model through this path).
 */

import { detectSessionStatus } from '@/lib/detection/status-detector';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import { buildDetectPromptOptions, stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import type { Observation } from './types';

/** CLI tool under test. Other tools are out of scope for this Issue. */
export const CANARY_CLI_TOOL = 'claude' as const;

/**
 * Capture window used by the production status path
 * (`STATUS_DETECTION_CAPTURE_LINES`, and `REDUCED_CAPTURE_LINES` for Auto-Yes —
 * both 1000 lines).
 */
export const CANARY_CAPTURE_LINES = 1000;

/** Run both production detection paths over one captured frame. */
export function probeFrame(frame: string): Observation {
  return {
    frame,
    status: detectSessionStatus(frame, CANARY_CLI_TOOL),
    autoYes: detectPrompt(
      stripBoxDrawing(stripAnsi(frame)),
      buildDetectPromptOptions(CANARY_CLI_TOOL)
    ),
  };
}

/** Compact verdict summary for the run report and fixture headers. */
export function summarizeObservation(observation: Observation): {
  status: string;
  reason: string;
  hasActivePrompt: boolean;
  autoYesIsPrompt: boolean;
  promptType?: string;
} {
  return {
    status: observation.status.status,
    reason: observation.status.reason,
    hasActivePrompt: observation.status.hasActivePrompt,
    autoYesIsPrompt: observation.autoYes.isPrompt,
    ...(observation.autoYes.promptData?.type
      ? { promptType: observation.autoYes.promptData.type }
      : {}),
  };
}
