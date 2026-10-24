/**
 * Issue #3881 (横展開 (a)): the agent-health picker check reports what
 * Auto-Yes reads a frame as, and on agy that reading now has a condition the
 * poller adds once a hook receipt is in hand — a generic reading agy's reader
 * did not take needs evidence on the screen (`/feedback`, agy's permission
 * rows). The probe reads without a receipt scope (the frame carries no
 * receipt), so `readsAsAutoYesPrompt` applies the screen condition apart from
 * the receipt, and a reply's plain list reads as no Auto-Yes prompt, as it
 * does to the poller.
 *
 * Frames: the paired fixture `tests/fixtures/antigravity-receipt-pair-3881/`.
 *
 * Positive control (fails before): the reply list reads false. Negative
 * controls: the live approval and `/feedback` read true; the display reading
 * (no receipt scope) of the reply list is still a prompt.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readsAsAutoYesPrompt } from '@/lib/agent-health/screen-checks';
import { buildDetectPromptOptions, stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import { detectPromptOnCleanFrame } from '@/lib/polling/response-checker';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const read = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

const generic = (clean: string) => () =>
  detectPrompt(stripBoxDrawing(clean), buildDetectPromptOptions('antigravity')).isPrompt;

function autoYesReading(rel: string): boolean {
  const raw = read(rel);
  const clean = stripAnsi(raw);
  return readsAsAutoYesPrompt('antigravity', clean, raw, generic(clean));
}

describe('[#3881] readsAsAutoYesPrompt applies the screen condition, not the receipt', () => {
  it('the reply list: no Auto-Yes prompt', () => {
    expect(autoYesReading('antigravity-receipt-pair-3881/reply-list.txt')).toBe(false);
  });

  it('陰性対照: the display reading of the same frame is still a prompt', () => {
    const raw = read('antigravity-receipt-pair-3881/reply-list.txt');
    expect(detectPromptOnCleanFrame(stripBoxDrawing(stripAnsi(raw)), 'antigravity', undefined, raw).isPrompt).toBe(true);
  });

  it.each([
    'antigravity-receipt-pair-3881/permission-dialog.txt',
    'antigravity-live-2364/dialog-feedback-category.txt',
  ])('陰性対照: %s reads as an Auto-Yes prompt', rel => {
    expect(autoYesReading(rel)).toBe(true);
  });
});
