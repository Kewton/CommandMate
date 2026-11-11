/**
 * Issue #4300: `agent-not-in-foreground` is read by code, through the tools'
 * wraps (`Failed to send message to <tool>: …`, `cause`), never by wording.
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { classifySendFailure } from '@/lib/session/send-attempt-state';
import { AGENT_NOT_IN_FOREGROUND_CODE } from '@/lib/session/send-attempt-types';

function refusal(): Error {
  return Object.assign(
    new Error('The agent in session s is not running: the pane is back at its shell, so nothing was typed (Issue #4300).'),
    { code: AGENT_NOT_IN_FOREGROUND_CODE }
  );
}

describe('classifySendFailure — agent-not-in-foreground (Issue #4300)', () => {
  it('the re-check refusal itself is not-sent / agent-not-in-foreground', () => {
    expect(classifySendFailure(refusal())).toEqual({ state: 'not-sent', reason: 'agent-not-in-foreground' });
  });

  it('a tool wrap keeps it through cause', () => {
    const wrapped = new Error(`Failed to send message to Codex: ${refusal().message}`, { cause: refusal() });
    expect(classifySendFailure(wrapped)).toEqual({ state: 'not-sent', reason: 'agent-not-in-foreground' });
  });

  it('the wording alone, without the code, is not read as the reason', () => {
    const worded = new Error(refusal().message);
    expect(classifySendFailure(worded).reason).not.toBe('agent-not-in-foreground');
  });
});
