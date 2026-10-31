/**
 * Issue #4031 (item 3): `readPromptResponseReply` marks an answer stopped
 * part-way, and `promptResponseNotice` picks its own toast for it.
 *
 * Positive: a 500 with `reason: answer_input_lost` and `keysSent: true` is
 * `partial`. Negative: every other reply is not, and keeps the notice it had
 * (`PROMPT_RESPONSE_NOTICES`).
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ANSWER_INPUT_LOST_REASON,
  PROMPT_RESPONSE_NOTICES,
  PROMPT_RESPONSE_PARTIAL_NOTICE,
  promptResponseNotice,
  readPromptResponseReply,
} from '@/lib/prompt-response-outcome';
import { ANSWER_INPUT_LOST_REASON as SERVER_REASON } from '@/lib/prompt-answer-errors';

function reply(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe('[#4031] readPromptResponseReply: partial', () => {
  it('the restated reason is the server\'s', () => {
    expect(ANSWER_INPUT_LOST_REASON).toBe(SERVER_REASON);
  });

  it('positive: 500 answer_input_lost with keysSent: true is a partial failure', async () => {
    const read = await readPromptResponseReply(
      reply(500, { error: 'Failed to send answer to tmux: …', reason: 'answer_input_lost', keysSent: true }),
    );
    expect(read).toMatchObject({ outcome: 'failed', partial: true });
    expect(promptResponseNotice(read.outcome as 'failed', read.partial)).toBe(PROMPT_RESPONSE_PARTIAL_NOTICE);
  });

  it.each([
    ['a plain 500', reply(500, { error: 'Failed to send answer to tmux: no server running' })],
    ['500 answer_input_lost without keysSent (an older server)', reply(500, { reason: 'answer_input_lost' })],
    ['500 answer_input_lost with keysSent: false', reply(500, { reason: 'answer_input_lost', keysSent: false })],
    ['500 answer_aborted with keysSent: true', reply(500, { reason: 'answer_aborted', keysSent: true })],
    ['200 success: false answer_not_delivered', reply(200, { success: false, reason: 'answer_not_delivered', keysSent: false })],
    ['200 success', reply(200, { success: true })],
    ['404 decision_not_found', reply(404, { code: 'decision_not_found' })],
  ])('negative: %s is not partial', async (_name, response) => {
    const read = await readPromptResponseReply(response);
    expect(read.partial).toBe(false);
    if (read.outcome !== 'answered') {
      expect(promptResponseNotice(read.outcome, read.partial)).toBe(PROMPT_RESPONSE_NOTICES[read.outcome]);
    }
  });

  it('the partial notice is a warning with its own message in both locales', () => {
    expect(PROMPT_RESPONSE_PARTIAL_NOTICE).toEqual({ messageKey: 'promptResponse.partial', type: 'warning' });
    for (const locale of ['ja', 'en']) {
      const file = path.resolve(__dirname, `../../../locales/${locale}/worktree.json`);
      const messages = JSON.parse(readFileSync(file, 'utf8')) as {
        promptResponse: Record<string, string>;
        planReview: { refusal: Record<string, string> };
      };
      expect(messages.promptResponse.partial).toBeTruthy();
      expect(messages.promptResponse.partial).not.toBe(messages.promptResponse.failed);
      expect(messages.planReview.refusal.inputLost).toBeTruthy();
    }
  });
});
