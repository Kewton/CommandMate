/**
 * `respond --plan-review` for Command Code's plan review overlay (Issue #3125).
 *
 * The CLI half: which body reaches `/prompt-response`, which flag combinations
 * are refused before any request, and what is printed after each action.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

const stderr = (): string => mockConsoleError.mock.calls.map((call) => String(call[0])).join('\n');
const stdout = (): string => mockConsoleLog.mock.calls.map((call) => String(call[0])).join('\n');

/** The JSON bodies POSTed to `/prompt-response`, in order. */
function promptResponseBodies(): Array<Record<string, unknown>> {
  return vi
    .mocked(global.fetch)
    .mock.calls.filter(([url]) => String(url).includes('/prompt-response'))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

/** Every request but the capability probe. */
function requestPaths(): string[] {
  return vi
    .mocked(global.fetch)
    .mock.calls.map(([url]) => String(url))
    .filter((url) => !url.includes('/api/capabilities'));
}

async function run(...args: string[]): Promise<void> {
  const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
  await createRespondCommand().parseAsync(['node', 'respond', 'wt1', ...args]);
}

describe('respond --plan-review (Issue #3125)', () => {
  it('approve sends planReviewAction with no answer, and skips the decision probe', async () => {
    mockFetchResponse(
      { success: true, answer: '', planReview: { action: 'approve', comment: null, phase: 'body', pendingCommentsBefore: 0 } },
      200,
    );
    await run('--plan-review', 'approve', '--agent', 'command-code');

    expect(promptResponseBodies()).toEqual([{ cliTool: 'command-code', planReviewAction: 'approve' }]);
    expect(requestPaths().every((p) => p.includes('/prompt-response'))).toBe(true);
    expect(stdout()).toContain('approved the plan (ctrl+a)');
    expect(stderr()).toContain('Response sent.');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('submit with text sends the comment and the action together', async () => {
    mockFetchResponse(
      { success: true, answer: 'Split it', planReview: { action: 'submit', comment: 'Split it', phase: 'body', pendingCommentsBefore: 0 } },
      200,
    );
    await run('Split it', '--plan-review', 'submit', '--agent', 'command-code');

    expect(promptResponseBodies()).toEqual([
      { answer: 'Split it', cliTool: 'command-code', planReviewAction: 'submit' },
    ]);
    expect(stdout()).toContain('submitted the review (ctrl+r)');
  });

  it('a plain comment names the next step (submit or approve)', async () => {
    mockFetchResponse(
      { success: true, answer: 'Add tests', planReview: { action: 'comment', comment: 'Add tests', phase: 'body', pendingCommentsBefore: 0 } },
      200,
    );
    await run('Add tests', '--agent', 'command-code');

    expect(stdout()).toContain('pinned comment "Add tests"');
    expect(stderr()).toContain('commandmate respond wt1 --plan-review submit');
  });

  it('cancel with pending comments says they were discarded', async () => {
    mockFetchResponse(
      { success: true, answer: '', planReview: { action: 'cancel', comment: null, phase: 'body', pendingCommentsBefore: 2 } },
      200,
    );
    await run('--plan-review', 'cancel', '--agent', 'command-code');

    expect(stdout()).toContain('cancelled the plan (esc)');
    expect(stderr()).toContain('2 pending comment(s) were discarded');
  });

  it('a plan_review_* refusal is reported as "not sent"', async () => {
    mockFetchResponse(
      { success: false, answer: '', reason: 'plan_review_busy', message: 'focus on the action list' },
      200,
    );
    await run('--plan-review', 'approve', '--agent', 'command-code');

    expect(stderr()).toContain('Answer was not sent. Reason: plan_review_busy (focus on the action list)');
    expect(mockExit).toHaveBeenCalledWith(99);
  });

  it.each([
    [['--plan-review', 'merge'], 'must be one of'],
    [['looks good', '--plan-review', 'approve'], 'takes no <answer>'],
    [['--plan-review', 'cancel', '--default'], 'mutually exclusive'],
    [['--plan-review', 'comment'], 'needs the comment text'],
  ])('refuses %j with exit 2', async (args, message) => {
    mockFetchResponse({ success: true, answer: '' }, 200);
    await run(...args);

    expect(stderr()).toContain(message);
    expect(mockExit).toHaveBeenCalledWith(2);
  });
});
