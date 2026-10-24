/**
 * Reading a stored `promptData.reading` back (Issue #3881).
 *
 * The reading is written by the response poller's save
 * (`polling/prompt-screen-reading`) and read by whatever shows the row later —
 * the chat transcript first. A row is data from the database, written by any
 * version of the server or by none (a row from before #3881 has no reading),
 * so this checks every field and answers null for anything it cannot vouch
 * for. Null is not a kind: the caller then applies its compatibility rules for
 * a row without a reading, explicitly, rather than treating the row as one
 * kind or another.
 *
 * Client-safe: types and plain checks only.
 *
 * @module lib/detection/prompt-reading
 */

import {
  PROMPT_READING_VERSION,
  type ApprovalTargetCompleteness,
  type CaptureTop,
  type PromptReading,
  type PromptReadingEvidence,
  type PromptReadingKind,
  type PromptReadingPhase,
} from '@/types/prompt-reading';

const KINDS: ReadonlySet<PromptReadingKind> = new Set<PromptReadingKind>([
  'question',
  'permission',
  'confirmation',
  'menu',
  'unknown',
]);
const PHASES: ReadonlySet<PromptReadingPhase> = new Set<PromptReadingPhase>(['question', 'confirmation']);
const COMPLETENESS: ReadonlySet<ApprovalTargetCompleteness | 'not-measured'> = new Set<
  ApprovalTargetCompleteness | 'not-measured'
>(['complete', 'truncated', 'top-unknown', 'not-measured']);
const CAPTURE_TOPS: ReadonlySet<CaptureTop> = new Set<CaptureTop>(['history-start', 'clipped']);
const EVIDENCE: ReadonlySet<PromptReadingEvidence> = new Set<PromptReadingEvidence>([
  'confirm-page-reader',
  'question-picker-chrome',
  'ask-user-question-payload',
  'permission-option-effect',
  'yes-no-pattern',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRow(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * The reading a stored `promptData` carries, or null when it carries none this
 * version can vouch for: no `reading`, another version, an unknown kind, a
 * phase on a kind that has none, a malformed range or evidence list.
 *
 * @param promptData - A row's `promptData`, as stored (any shape)
 */
export function readStoredPromptReading(promptData: unknown): PromptReading | null {
  if (!isRecord(promptData)) return null;
  const reading = promptData.reading;
  if (!isRecord(reading) || reading.version !== PROMPT_READING_VERSION) return null;

  const kind = reading.kind as PromptReadingKind;
  if (!KINDS.has(kind)) return null;

  const phase = reading.phase;
  const hasPhase = kind === 'question' || kind === 'confirmation';
  if (phase !== undefined && (!hasPhase || !PHASES.has(phase as PromptReadingPhase))) return null;

  const approvalTarget = reading.approvalTarget as ApprovalTargetCompleteness | 'not-measured';
  if (!COMPLETENESS.has(approvalTarget)) return null;

  const evidence = reading.evidence;
  if (!Array.isArray(evidence) || !evidence.every((e) => EVIDENCE.has(e as PromptReadingEvidence))) return null;

  const captureTop = reading.captureTop;
  if (captureTop !== undefined && !CAPTURE_TOPS.has(captureTop as CaptureTop)) return null;

  const range = reading.liveRange;
  if (range !== undefined && !(isRecord(range) && isRow(range.startRow) && isRow(range.endRow))) return null;

  return {
    version: PROMPT_READING_VERSION,
    kind,
    ...(phase !== undefined ? { phase: phase as PromptReadingPhase } : {}),
    ...(isRecord(range) ? { liveRange: { startRow: range.startRow as number, endRow: range.endRow as number } } : {}),
    approvalTarget,
    ...(captureTop !== undefined ? { captureTop: captureTop as CaptureTop } : {}),
    evidence: [...(evidence as PromptReadingEvidence[])],
  };
}
