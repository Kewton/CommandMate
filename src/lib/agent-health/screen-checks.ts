/**
 * Turning one detector verdict into a `screen-*` check result (Issue #2878).
 *
 * The frames come from a real agent CLI; the verdicts come from the production
 * detector (`detectSessionStatus`). These functions only state what each
 * screen must be judged as, so the expectations are readable in one place and
 * testable without a CLI.
 */

import { SELECTION_LIST_REASONS } from '@/lib/detection/status-detector';
import { paneEvidence, truncateEvidence } from './report';
import type { AgentHealthCheckStatus } from './types';

/** The part of `StatusDetectionResult` the checks read. */
export interface ScreenVerdict {
  status: 'idle' | 'ready' | 'running' | 'waiting';
  reason: string;
  hasActivePrompt: boolean;
  evidence: 'positive' | 'none';
  /**
   * `detectPrompt(...).isPrompt` on the same frame — what Auto-Yes reads
   * (Issue #3053). Only `screen-picker` reads it; absent elsewhere.
   */
  isPrompt?: boolean;
}

export type ScreenCheckId =
  | 'screen-idle'
  | 'screen-picker'
  | 'screen-running'
  | 'screen-approval'
  | 'screen-quoted-dialog';

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
  'screen-picker': {
    // Issue #3053: a picker (`/model`, `/effort`) must read as a selection
    // list — that is what puts the navigation buttons up — and must not read
    // as a prompt, or Auto-Yes would answer it and change the user's default
    // (#1495).
    text: '選択画面（waiting、reason が SELECTION_LIST_REASONS のいずれか）で hasActivePrompt=false、detectPrompt も isPrompt=false',
    holds: (v) =>
      v.status === 'waiting' && !v.hasActivePrompt && SELECTION_LIST_REASONS.has(v.reason) && v.isPrompt === false,
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
  const prompt = verdict.isPrompt === undefined ? '' : ` isPrompt=${verdict.isPrompt}`;
  return `status=${verdict.status} reason=${verdict.reason} hasActivePrompt=${verdict.hasActivePrompt} evidence=${verdict.evidence}${prompt}`;
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

/** One picker the probe opened (Issue #3053). */
export interface PickerScreenResult {
  /** The command that opens it (`/model`). */
  screen: string;
  /** Whether the picker's own text (not the detector's pattern) appeared. */
  opened: boolean;
  /** The verdict on the open picker; null when it never opened. */
  verdict: ScreenVerdict | null;
  /** The frame judged, or the last frame seen when it never opened. */
  frame: string;
  /** False when Esc did not bring the composer back (`ready`). */
  closed: boolean;
}

function pickerScreenHolds(result: PickerScreenResult): boolean {
  return result.opened && result.closed && result.verdict !== null && screenExpectationHolds('screen-picker', result.verdict);
}

function describePickerScreen(result: PickerScreenResult): string {
  if (!result.opened || result.verdict === null) return `${result.screen}: 不合格（画面が開いたことを確認できなかった）`;
  const closed = result.closed ? '' : '、Esc の後に入力待ちに戻らなかった';
  return `${result.screen}: ${pickerScreenHolds(result) ? '合格' : '不合格'}（${describeVerdict(result.verdict)}${closed}）`;
}

/**
 * The one `screen-picker` check for every picker a tool opened: the summary
 * lists each screen's verdict, any miss fails the check, and the evidence is
 * the tail of each screen that missed.
 */
export function evaluatePickerScreens(results: readonly PickerScreenResult[]): ScreenCheckVerdict {
  const summary = `期待: ${EXPECTATIONS['screen-picker'].text}。実際: ${
    results.length === 0 ? '選択画面を 1 つも開いていない' : results.map(describePickerScreen).join(' / ')
  }`;
  const missed = results.filter((result) => !pickerScreenHolds(result));
  if (results.length > 0 && missed.length === 0) return { status: 'pass', summary };
  return {
    status: 'fail',
    summary,
    evidence: truncateEvidence(missed.map((result) => `── ${result.screen}\n${paneEvidence(result.frame)}`).join('\n')),
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
