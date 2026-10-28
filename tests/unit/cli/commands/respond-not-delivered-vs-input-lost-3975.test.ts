/**
 * `commandmate respond` tells the two #3952 outcomes apart (Issue #3975).
 *
 * - `answer_not_delivered` (`PromptAnswerNotDeliveredError`): stopped before
 *   the first key, so nothing reached the pane — "not sent, safe to retry".
 *   Before #3975 it printed `Warning: Response may not have been applied.`,
 *   which says the opposite.
 * - `answer_input_lost` (`PromptAnswerInputLostError`): stopped part-way, so
 *   some keys may be on the pane — "look with capture before answering again".
 *   Before #3975 it printed only the server error.
 *
 * Both keep exit 99, the code `decision_not_delivered` uses. Negative control:
 * `prompt_no_longer_active` keeps its "may not have been applied" wording.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';

// `--instance` resolves through the server; here it resolves as the roster would.
vi.mock('../../../../src/cli/commands/instances', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/cli/commands/instances')>();
  return {
    ...actual,
    resolveInstanceTarget: vi.fn(async () => ({ cliToolId: 'claude', instanceId: 'claude-2' })),
  };
});
import {
  ANSWER_INPUT_LOST_REASON,
  ANSWER_NOT_DELIVERED_REASON,
  PromptAnswerInputLostError,
} from '../../../../src/lib/prompt-answer-errors';
import { ANSWER_INPUT_LOST, ANSWER_NOT_DELIVERED } from '../../../../src/cli/commands/respond';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

function printed(): string {
  return mockConsoleError.mock.calls.map((call) => String(call[0])).join('\n');
}

async function respond(args: string[]): Promise<void> {
  const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
  await createRespondCommand().parseAsync(['node', 'respond', ...args]);
}

describe('[#3975] respond: answer_not_delivered vs answer_input_lost', () => {
  it('the CLI\'s restated reason codes are the server\'s', () => {
    expect(ANSWER_NOT_DELIVERED).toBe(ANSWER_NOT_DELIVERED_REASON);
    expect(ANSWER_INPUT_LOST).toBe(ANSWER_INPUT_LOST_REASON);
    expect(new PromptAnswerInputLostError('s').reason).toBe(ANSWER_INPUT_LOST_REASON);
    // `/prompt-response`'s 500 body is the message: the code has to be in it.
    expect(new PromptAnswerInputLostError('s').message).toContain(ANSWER_INPUT_LOST_REASON);
  });

  it('answer_not_delivered: says nothing was sent and a retry is safe (exit 99)', async () => {
    mockFetchResponse(
      {
        success: false,
        answer: '1',
        reason: 'answer_not_delivered',
        message: 'The answer was not sent to s: … (target-changed). Nothing was typed.',
      },
      200,
    );
    await respond(['wt1', '1', '--agent', 'claude']);

    expect(printed()).toContain('Error: Answer was not sent. Reason: answer_not_delivered');
    expect(printed()).toContain('safe to run respond again');
    expect(printed()).not.toContain('may not have been applied');
    expect(printed()).not.toContain('commandmate capture');
    expect(mockExit).toHaveBeenCalledWith(99);
  });

  it('answer_input_lost: says it may be partly typed and to look with capture first (exit 99)', async () => {
    const lost = new PromptAnswerInputLostError('mcbd-claude-wt1');
    mockFetchResponse({ error: `Failed to send answer to tmux: ${lost.message}` }, 500);
    await respond(['wt1', '1', '--agent', 'claude']);

    expect(printed()).toContain('may have been only partly typed (reason: answer_input_lost)');
    // The pane the answer went to (review P2-2), not the worktree default's reply.
    expect(printed()).toContain('`commandmate capture wt1 --agent claude --pane --tail 40`');
    expect(printed()).not.toContain('safe to run respond again');
    expect(printed()).not.toContain('Response sent.');
    expect(mockExit).toHaveBeenCalledWith(99);
  });

  it('answer_input_lost read from `reason` as well (the /respond route\'s 500 body)', async () => {
    mockFetchResponse({ error: 'Failed to send answer to tmux: stopped', reason: 'answer_input_lost' }, 500);
    await respond(['wt1', '1', '--agent', 'claude']);

    expect(printed()).toContain('reason: answer_input_lost');
    expect(mockExit).toHaveBeenCalledWith(99);
  });

  it('answer_input_lost after `--instance`: the capture names the resolved instance and reads its pane', async () => {
    const lost = new PromptAnswerInputLostError('mcbd-claude-2-wt1');
    mockFetchResponse({ error: `Failed to send answer to tmux: ${lost.message}` }, 500);
    await respond(['wt1', '1', '--instance', 'Claude 2']);

    expect(printed()).toContain('`commandmate capture wt1 --instance claude-2 --pane --tail 40`');
    expect(printed()).not.toContain('--agent');
    expect(mockExit).toHaveBeenCalledWith(99);
  });

  it('answer_input_lost with no target named: the capture adds no selector but still reads the pane', async () => {
    const lost = new PromptAnswerInputLostError('mcbd-claude-wt1');
    mockFetchResponse({ error: `Failed to send answer to tmux: ${lost.message}` }, 500);
    await respond(['wt1', '1']);

    expect(printed()).toContain('`commandmate capture wt1 --pane --tail 40`');
    expect(mockExit).toHaveBeenCalledWith(99);
  });

  it('negative: another 500 is still reported as the server error', async () => {
    mockFetchResponse({ error: 'Failed to send answer to tmux: tmux went away' }, 500);
    await respond(['wt1', '1', '--agent', 'claude']);

    expect(printed()).toContain('tmux went away');
    expect(printed()).not.toContain('answer_input_lost');
    expect(printed()).not.toContain('partly typed');
    expect(mockExit).toHaveBeenCalledWith(99);
  });

  it('negative: prompt_no_longer_active keeps the "may not have been applied" wording', async () => {
    mockFetchResponse({ success: false, answer: '1', reason: 'prompt_no_longer_active' }, 200);
    await respond(['wt1', '1', '--agent', 'claude']);

    expect(printed()).toContain('Warning: Response may not have been applied. Reason: prompt_no_longer_active');
    expect(printed()).not.toContain('safe to run respond again');
    expect(mockExit).toHaveBeenCalledWith(99);
  });
});
