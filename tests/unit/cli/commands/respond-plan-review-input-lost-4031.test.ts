/**
 * `commandmate respond --plan-review` reports a review stopped part-way
 * (Issue #4031).
 *
 * The bodies are the server's own: `planReviewAnswerError` turns the plan
 * review's `PlanReviewInputLostError` into an answer error, and
 * `promptAnswerErrorResponse` writes the body `/prompt-response` returns.
 *
 * - positive: a step was sent (`stepsSent >= 1`) → the InputLost warning, exit 99
 * - negative: no step was sent → "not sent, safe to retry", no InputLost warning
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';
import { PlanReviewInputLostError } from '../../../../src/lib/cli-tools/command-code-plan-review';
import { planReviewAnswerError } from '../../../../src/app/api/worktrees/[id]/prompt-response/plan-review';
import { promptAnswerErrorResponse } from '../../../../src/lib/prompt-answer-errors';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

const SESSION = 'mcbd-command-code-wt1';

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

function printed(): string {
  return mockConsoleError.mock.calls.map((call) => String(call[0])).join('\n');
}

/** The body and status `/prompt-response` answers a plan review stopped after `stepsSent` steps with. */
function serverReply(stepsSent: number): { status: number; body: Record<string, unknown> } {
  const mapped = promptAnswerErrorResponse(
    planReviewAnswerError(new PlanReviewInputLostError(SESSION, stepsSent), SESSION),
    'prompt-response',
  );
  if (mapped === null) throw new Error('not mapped');
  if (mapped.status === 200) mapped.body.answer = 'split it';
  return mapped;
}

async function respond(args: string[]): Promise<void> {
  const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
  await createRespondCommand().parseAsync(['node', 'respond', ...args]);
}

describe('[#4031] respond --plan-review: stopped part-way', () => {
  it('positive: a step was sent — the InputLost warning and exit 99', async () => {
    const { status, body } = serverReply(1);
    expect(status).toBe(500);
    mockFetchResponse(body, status);
    await respond(['wt1', 'split it', '--plan-review', 'comment', '--agent', 'command-code']);

    expect(printed()).toContain('may have been only partly typed (reason: answer_input_lost)');
    expect(printed()).toContain('`commandmate capture wt1 --agent command-code --pane --tail 40`');
    expect(printed()).not.toContain('Response sent.');
    expect(mockExit).toHaveBeenCalledWith(99);
  });

  it('negative: no step was sent — not delivered, no InputLost warning', async () => {
    const { status, body } = serverReply(0);
    expect(status).toBe(200);
    mockFetchResponse(body, status);
    await respond(['wt1', 'split it', '--plan-review', 'comment', '--agent', 'command-code']);

    expect(printed()).toContain('Reason: answer_not_delivered');
    expect(printed()).toContain('safe to run respond again');
    expect(printed()).not.toContain('partly typed');
    expect(mockExit).toHaveBeenCalledWith(99);
  });
});
