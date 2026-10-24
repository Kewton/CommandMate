/**
 * Issue #3881 × #3880: the capture-top reading does not move the keys a hold
 * is matched by.
 *
 * Since the merge of #3887, `noteNoPromptOnScreen` takes agy's ungated reading
 * once, with the tick's capture top on it (`withCaptureTop`), and uses it both
 * to tell which of a person's in-flight sends the dialog on screen still
 * covers and as the receipt log's reader, which matches a person's hold. Both
 * matches go through the screen key, so the capture top must not change it:
 * only the resolver's deny judgement reads `approvalTargetCompleteness`.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { detectPromptWithOptions } from '@/lib/polling/response-checker';
import { withCaptureTopCompleteness } from '@/lib/polling/prompt-screen-reading';
import { ledgerScreenKey, partialAnswerScreenKey } from '@/lib/polling/auto-yes-poller-state';

/** A confirm whose upward scan reaches the frame's first row with no boundary. */
const FRAME = [
  '     13 +    return root',
  '     14 +  }',
  '',
  'Do you want to make this edit to cleanup.ts?',
  '❯ 1. Yes',
  '  2. Yes, allow all edits during this session (shift+tab)',
  '  3. No',
  '',
  'Esc to cancel · Tab to amend',
].join('\n');

describe('[#3881 × #3880] the capture top and the hold keys', () => {
  it('a clipped top marks the prompt and leaves its screen keys as they were', () => {
    const detection = detectPromptWithOptions(FRAME, 'claude');
    expect(detection.approvalContext?.completeness).toBe('top-unknown');
    const clipped = withCaptureTopCompleteness(detection, 'clipped');
    expect(clipped.promptData?.approvalTargetCompleteness).toBe('top-unknown');
    expect(detection.promptData?.approvalTargetCompleteness).toBeUndefined();
    expect(partialAnswerScreenKey(clipped.promptData!)).toBe(partialAnswerScreenKey(detection.promptData!));
    expect(ledgerScreenKey(clipped.promptData!)).toBe(ledgerScreenKey(detection.promptData!));
  });
});
