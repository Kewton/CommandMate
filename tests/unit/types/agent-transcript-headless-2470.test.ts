/**
 * The key a Claude reply is saved under when its prompt record is out of reach
 * (Issue #2470).
 *
 * Every other Claude row is keyed on the prompt record's `uuid`. A turn longer
 * than the widest window the history reader reads back has no prompt record in
 * reach, and its row is keyed on the record that closed it instead. The
 * properties asserted here are the ones a key in this module has to have — it
 * must not collide with any other key, and it must be recognised as a turn by
 * every reader of `request_id` — plus the one that separates it from the live
 * bubble's key: two such turns in one session are two rows.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import {
  CLAUDE_HEADLESS_TURN_ID_PREFIX,
  claudeHeadlessTurnId,
  claudePromptRequestId,
  claudeTurnRequestId,
  correlatedPromptRequestId,
  isAgentAuthoredMarkdown,
  resolveAgentTurnKey,
} from '@/types/agent-transcript';

const SESSION = '5f3a1c00-2470-4a00-9000-0000000000aa';
const CLOSING = '5f3a1c00-2470-4a00-9000-0000000000f1';
const LATER_CLOSING = '5f3a1c00-2470-4a00-9000-0000000000f2';

describe('[#2470] claudeHeadlessTurnId', () => {
  it('names the session and the record that closed the turn', () => {
    expect(claudeHeadlessTurnId(SESSION, CLOSING)).toBe(`partial:${SESSION}:${CLOSING}`);
  });

  it('gives two headless turns of one session two keys', () => {
    // The whole reason the live key could not be reused: it is one per session,
    // so the second long turn would read "already saved" and be lost.
    expect(claudeHeadlessTurnId(SESSION, CLOSING)).not.toBe(
      claudeHeadlessTurnId(SESSION, LATER_CLOSING)
    );
  });

  it('never equals the live bubble’s key', () => {
    const live = claudeTurnRequestId(`${CLAUDE_HEADLESS_TURN_ID_PREFIX}${SESSION}`);
    expect(claudeTurnRequestId(claudeHeadlessTurnId(SESSION, CLOSING))).not.toBe(live);
  });

  it('cannot collide with a prompt-derived key, even on the same uuid', () => {
    expect(claudeTurnRequestId(claudeHeadlessTurnId(SESSION, CLOSING))).not.toBe(
      claudeTurnRequestId(CLOSING)
    );
  });

  it('is drawn as the agent’s Markdown and read back as a turn', () => {
    const requestId = claudeTurnRequestId(claudeHeadlessTurnId(SESSION, CLOSING));
    expect(isAgentAuthoredMarkdown(requestId)).toBe(true);
    expect(resolveAgentTurnKey(requestId)).toBe(requestId);
  });

  it('correlates to a prompt id no writer produces — there is no user row', () => {
    const requestId = claudeTurnRequestId(claudeHeadlessTurnId(SESSION, CLOSING));
    expect(correlatedPromptRequestId(requestId)).toBe(
      `claude-prompt:partial:${SESSION}:${CLOSING}`
    );
    expect(correlatedPromptRequestId(requestId)).not.toBe(claudePromptRequestId(CLOSING));
  });
});
