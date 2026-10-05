/**
 * Reading the reply to an answered approval (Issue #3292).
 *
 * `readPromptResponseOutcome` is the one place that decides what a reply from
 * `/prompt-response` or `/respond` means. The rows are the replies the two
 * routes really send; what each handler then does with the outcome is pinned
 * per path in `tests/unit/prompt-response-outcome-3292/`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  PROMPT_RESPONSE_NOTICES,
  readPromptResponseOutcome,
  type PromptResponseOutcome,
} from '@/lib/prompt-response-outcome';

function reply(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function unreadable(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  } as unknown as Response;
}

const ROWS: Array<[name: string, response: Response, expected: PromptResponseOutcome]> = [
  // 2xx
  ['200 success:true', reply(200, { success: true, answer: '1' }), 'answered'],
  ['200 with no success field', reply(200, {}), 'answered'],
  ['200 with an unreadable body (not a refusal)', unreadable(200), 'answered'],
  [
    '200 success:false prompt_no_longer_active (#2468)',
    reply(200, { success: false, reason: 'prompt_no_longer_active', answer: '1' }),
    'refused',
  ],
  [
    '200 success:false decision_not_delivered',
    reply(200, { success: false, reason: 'decision_not_delivered', answer: '1' }),
    'refused',
  ],
  // not 2xx, and the body says the approval is gone
  [
    '404 decision_not_found (/respond: the approval is no longer pending)',
    reply(404, { error: 'not pending', code: 'decision_not_found', reason: 'decision_not_found' }),
    'refused',
  ],
  ['404 naming it by code only', reply(404, { error: 'not pending', code: 'decision_not_found' }), 'refused'],
  ['404 naming it by reason only', reply(404, { error: 'not pending', reason: 'decision_not_found' }), 'refused'],
  // not 2xx, and nothing says the dialog changed: never guessed
  ["404 with no code (Worktree 'x' not found)", reply(404, { error: "Worktree 'x' not found" }), 'failed'],
  [
    '404 decision_source_unaddressable',
    reply(404, { error: 'x', code: 'decision_source_unaddressable', reason: 'decision_source_unaddressable' }),
    'failed',
  ],
  ['404 with an unreadable body', unreadable(404), 'failed'],
  [
    '400 answer_out_of_range',
    reply(400, { error: 'x', code: 'answer_out_of_range', reason: 'answer_out_of_range' }),
    'failed',
  ],
  ['400 with no code (session is not running)', reply(400, { error: 'Claude session is not running' }), 'failed'],
  [
    '409 session_owned_by_other_server',
    reply(409, { error: 'x', code: 'session_owned_by_other_server', sessionName: 's', sessionPath: null }),
    'failed',
  ],
  ['500', reply(500, { error: 'Failed to send answer to tmux' }), 'failed'],
  [
    '502 decision_source_unreachable',
    reply(502, { error: 'x', code: 'decision_source_unreachable', reason: 'decision_source_unreachable' }),
    'failed',
  ],
  // the code alone is not enough: it has to arrive as the 404 the route sends
  [
    '500 that happens to carry decision_not_found',
    reply(500, { error: 'x', code: 'decision_not_found', reason: 'decision_not_found' }),
    'failed',
  ],
  ['500 with a body that is not an object', reply(500, 'Internal Server Error'), 'failed'],
];

describe('readPromptResponseOutcome', () => {
  it.each(ROWS)('%s', async (_name, response, expected) => {
    expect(await readPromptResponseOutcome(response)).toBe(expected);
  });
});

describe('PROMPT_RESPONSE_NOTICES', () => {
  it('keeps the wording and level of a refusal (#2468) and names a failure as an error', () => {
    expect(PROMPT_RESPONSE_NOTICES).toEqual({
      refused: { messageKey: 'promptResponse.refused', type: 'warning' },
      failed: { messageKey: 'promptResponse.failed', type: 'error' },
    });
  });

  it('has both messages in both locales', () => {
    for (const locale of ['ja', 'en']) {
      const file = path.resolve(__dirname, `../../../locales/${locale}/worktree.json`);
      const messages = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
      for (const notice of Object.values(PROMPT_RESPONSE_NOTICES)) {
        const [group, key] = notice.messageKey.split('.');
        expect(typeof messages[group]?.[key], `${locale} ${notice.messageKey}`).toBe('string');
        expect(String(messages[group]?.[key]).trim(), `${locale} ${notice.messageKey}`).not.toBe('');
      }
    }
  });
});
