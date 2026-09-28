/**
 * Turning one detector verdict into a `screen-*` check result (Issue #2878).
 *
 * The frames come from a real agent CLI; the verdicts come from the production
 * detector (`detectSessionStatus`). These functions only state what each
 * screen must be judged as, so the expectations are readable in one place and
 * testable without a CLI.
 */

import { paneEvidence } from './report';
import type { AgentHealthCheckStatus } from './types';

/** The part of `StatusDetectionResult` the checks read. */
export interface ScreenVerdict {
  status: 'idle' | 'ready' | 'running' | 'waiting';
  reason: string;
  hasActivePrompt: boolean;
  evidence: 'positive' | 'none';
}

export type ScreenCheckId = 'screen-idle' | 'screen-running' | 'screen-approval' | 'screen-quoted-dialog';

export interface ScreenCheckVerdict {
  status: Exclude<AgentHealthCheckStatus, 'skip'>;
  summary: string;
  evidence?: string;
}

const EXPECTATIONS: Record<ScreenCheckId, { text: string; holds: (v: ScreenVerdict) => boolean }> = {
  'screen-idle': {
    text: '入力待ち（ready）で hasActivePrompt=false',
    holds: (v) => v.status === 'ready' && !v.hasActivePrompt,
  },
  'screen-running': {
    // `running` with evidence `none` is the detector's floor ("no rule could
    // read this frame"), not a recognition of the running screen.
    text: '実行中（running、evidence=positive）',
    holds: (v) => v.status === 'running' && v.evidence === 'positive',
  },
  'screen-approval': {
    text: '承認待ち（waiting）で hasActivePrompt=true',
    holds: (v) => v.status === 'waiting' && v.hasActivePrompt,
  },
  'screen-quoted-dialog': {
    text: '承認ダイアログの文面を引用した返答の後も入力待ち（ready）で hasActivePrompt=false',
    holds: (v) => v.status === 'ready' && !v.hasActivePrompt,
  },
};

export function describeVerdict(verdict: ScreenVerdict): string {
  return `status=${verdict.status} reason=${verdict.reason} hasActivePrompt=${verdict.hasActivePrompt} evidence=${verdict.evidence}`;
}

export function screenExpectationHolds(checkId: ScreenCheckId, verdict: ScreenVerdict): boolean {
  return EXPECTATIONS[checkId].holds(verdict);
}

/**
 * @param note - optional context appended to the summary (e.g. "承認ダイアログは出ていた")
 */
export function evaluateScreen(
  checkId: ScreenCheckId,
  verdict: ScreenVerdict,
  frame: string,
  note?: string
): ScreenCheckVerdict {
  const { text, holds } = EXPECTATIONS[checkId];
  const suffix = note ? `（${note}）` : '';
  if (holds(verdict)) {
    return { status: 'pass', summary: `期待: ${text}。実際: ${describeVerdict(verdict)}${suffix}` };
  }
  return {
    status: 'fail',
    summary: `期待: ${text}。実際: ${describeVerdict(verdict)}${suffix}`,
    evidence: paneEvidence(frame),
  };
}

/**
 * How many times `pattern` occurs in the ANSI-stripped frame. The driver
 * compares the count before and after a send, so a dialog quoted earlier in
 * the scrollback is not mistaken for a new one.
 */
export function countMatches(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return [...text.matchAll(new RegExp(pattern.source, flags))].length;
}
