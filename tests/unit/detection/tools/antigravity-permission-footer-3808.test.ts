/**
 * agy's numbered screens are read as a permission dialog only under the
 * `tab Amend` footer (Issue #3808).
 *
 * #3797 taught the prompt observation (`prompt-observation/classify.ts`) that
 * agy's login-method screen — `Select login method:` over `> 1. Google OAuth` /
 * `2. Use a Google Cloud project`, footer `↑/↓ Navigate · enter Select` — is
 * not a permission dialog. The status layer kept reading it as
 * `prompt_detected` / `multiple_choice` (with the logo rows in
 * `approvalTarget`), and every producer of an answerable agy prompt reads the
 * same reader, so the Auto-Yes poller could answer it by number. The rule now
 * lives in the reader (`tools/antigravity/dialog.ts`), and every consumer —
 * the status verdict, the response poller, `/prompt-response`'s
 * re-verification, the observation — follows it.
 *
 * Positive control: the measured agy 1.1.27 permission dialogs keep their
 * reading. Negative: the measured 1.4.2 login-method screen
 * (`prompt-observation-3797/`, read, not rewritten), and a permission dialog
 * whose footer was cut by a narrow pane or spelled differently by another
 * version (`prompt-observation-3808/`, constructed — see its README): those
 * fall to the side that does not answer.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAntigravityNumberedDialog, stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { detectSessionStatus, SELECTION_LIST_REASONS } from '@/lib/detection/status-detector';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import {
  detectAntigravityNumberedDialogPrompt,
  readAntigravityNumberedDialog,
} from '@/lib/detection/tools/antigravity/dialog';
import { detectPromptOnCleanFrame } from '@/lib/polling/response-checker';
import { assessPromptAnswerability } from '@/lib/polling/auto-yes-dialog-gate';
import { isUnclassifiedFrame } from '@/lib/session/status-evidence';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const read = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

/** What the response poller reads: ANSI and box drawing already removed. */
const asPollerSees = (raw: string): string => stripBoxDrawing(stripAnsi(raw));

const PERMISSION_DIALOGS = [
  'antigravity-live-2364/dialog-bash-oneline.txt',
  'antigravity-live-2364/dialog-bash-wrapped.txt',
  'antigravity-live-2364/dialog-create-file.txt',
] as const;

const NOT_ANSWERED = [
  ['the login-method screen (agy 1.4.2, measured)', 'prompt-observation-3797/antigravity-login-method.txt'],
  ['a permission dialog whose footer a narrow pane cut', 'prompt-observation-3808/antigravity-permission-footer-truncated.txt'],
  ['a permission dialog whose footer a narrow pane wrapped', 'prompt-observation-3808/antigravity-permission-footer-wrapped.txt'],
  ['a permission dialog under another version\'s footer', 'prompt-observation-3808/antigravity-permission-footer-other-version.txt'],
] as const;

describe('[#3808] the permission dialogs keep their reading (positive control)', () => {
  it.each(PERMISSION_DIALOGS)('%s is an answerable multiple_choice prompt on every path', (rel) => {
    const raw = read(rel);
    const status = detectSessionStatus(raw, 'antigravity');
    expect(status.reason).toBe(STATUS_REASON.PROMPT_DETECTED);
    expect(status.promptDetection.promptData?.type).toBe('multiple_choice');

    expect(detectAntigravityNumberedDialogPrompt(asPollerSees(raw))?.isPrompt).toBe(true);
    expect(detectPromptOnCleanFrame(asPollerSees(raw), 'antigravity').isPrompt).toBe(true);
    expect(assessPromptAnswerability('antigravity', raw).refusal).toBeNull();
  });
});

describe('[#3808] numbered screens without the `tab Amend` footer are not answered', () => {
  it.each(NOT_ANSWERED)('%s: still a numbered agy screen, not a readable permission dialog', (_label, rel) => {
    const text = asPollerSees(read(rel));
    // Structurally numbered: the test that hands a frame to the reader passes,
    // so what declines it is the footer rule and nothing else.
    expect(isAntigravityNumberedDialog(text)).toBe(true);
    expect(readAntigravityNumberedDialog(text.split('\n'))).toBeNull();
    expect(detectAntigravityNumberedDialogPrompt(text)).toBeNull();
    expect(detectAntigravityNumberedDialogPrompt(stripAnsi(read(rel)))).toBeNull();
  });

  it.each(NOT_ANSWERED)('%s: the status layer publishes an unclassified frame, not a prompt', (_label, rel) => {
    const result = detectSessionStatus(read(rel), 'antigravity');
    expect(result.reason).toBe(STATUS_REASON.UNKNOWN_FRAME);
    expect(result.hasActivePrompt).toBe(false);
    expect(result.promptDetection.isPrompt).toBe(false);
    // A human is needed: the hatch opens and `wait` stops …
    expect(isUnclassifiedFrame(result.status, result.reason)).toBe(true);
    // … and the arrow pad, whose Enter would pick the highlighted row, is not offered.
    expect(SELECTION_LIST_REASONS.has(result.reason)).toBe(false);
  });

  it.each(NOT_ANSWERED)('%s: the response poller reads no prompt (the generic pass does not pick it up)', (_label, rel) => {
    const clean = asPollerSees(read(rel));
    const result = detectPromptOnCleanFrame(clean, 'antigravity', clean.split('\n'), read(rel));
    expect(result.isPrompt).toBe(false);
    expect(result.promptData).toBeUndefined();
  });

  it.each(NOT_ANSWERED)('%s: /prompt-response refuses to send a key', (_label, rel) => {
    const result = assessPromptAnswerability('antigravity', read(rel));
    expect(result.promptCheck.isPrompt).toBe(false);
    expect(result.refusal).not.toBeNull();
  });
});
