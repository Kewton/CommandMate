/**
 * Small builders for the status verdicts a tool detector returns (Issue #3219).
 *
 * They only assemble the `ToolStatusVerdict` object literal the detectors used to
 * spell out by hand. Each builder produces exactly the fields its call sites
 * wrote: the `promptDetection` key is present only for the builders that take
 * one, and is never added as `undefined` where the original omitted it.
 *
 * Types and small functions only: no tool file and no `cli-patterns` import.
 */

import type { PromptDetectionResult } from '../prompt-detector';
import type { SessionStatus } from '../status-detector';
import type { ToolStatusVerdict } from './types';

/** A verdict resting on something the detector positively recognised, no prompt of its own. */
export function positiveVerdict(status: SessionStatus, reason: string): ToolStatusVerdict {
  return {
    status,
    confidence: 'high',
    reason,
    hasActivePrompt: false,
    evidence: 'positive',
  };
}

/** {@link positiveVerdict} that also carries the branch's own `promptDetection` key. */
export function positiveVerdictWithPrompt(
  status: SessionStatus,
  reason: string,
  promptDetection: PromptDetectionResult | undefined
): ToolStatusVerdict {
  return {
    status,
    confidence: 'high',
    reason,
    hasActivePrompt: false,
    evidence: 'positive',
    promptDetection,
  };
}

/** `waiting` on a positively detected prompt (`hasActivePrompt: true`). */
export function activePromptVerdict(
  reason: string,
  promptDetection: PromptDetectionResult | undefined
): ToolStatusVerdict {
  return {
    status: 'waiting',
    confidence: 'high',
    reason,
    hasActivePrompt: true,
    evidence: 'positive',
    promptDetection,
  };
}

/** `running` with low confidence and no evidence, carrying the `promptDetection` key. */
export function unreadVerdictWithPrompt(
  reason: string,
  promptDetection: PromptDetectionResult | undefined
): ToolStatusVerdict {
  return {
    status: 'running',
    confidence: 'low',
    reason,
    hasActivePrompt: false,
    evidence: 'none',
    promptDetection,
  };
}
