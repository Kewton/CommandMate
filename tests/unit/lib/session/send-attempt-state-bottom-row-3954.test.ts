/**
 * Issue #3954: copilot's `/model` failure wordings no longer quote the pane, so
 * a screen that holds a classification keyword cannot steer `classifySendFailure`.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { classifySendFailure } from '@/lib/session/send-attempt-state';

const IDLE = 'copilot did not become idle within 30000ms, so /model was not sent';
const NO_ANSWER =
  'copilot printed no answer to /model within 30000ms; the switch may still take effect, and nothing further was typed';

describe('copilot /model failure wordings (Issue #3954)', () => {
  it.each([IDLE, NO_ANSWER])('classify as send-error whatever the screen said: %s', (message) => {
    expect(classifySendFailure(new Error(message))).toEqual({ state: 'indeterminate', reason: 'send-error' });
  });

  it('positive control: the old wording with a quoted keyword was steered', () => {
    const old = `${IDLE} (bottom row: "prompt not ready")`;
    expect(classifySendFailure(new Error(old)).reason).toBe('prompt-not-ready');
  });
});
