/**
 * Issue #4031 (items 1 and 3): Command Code's plan review controls name an
 * answer stopped part-way.
 *
 * Since #4031 `/prompt-response` answers a plan review whose keys stopped after
 * a step as a 500 with `reason: answer_input_lost` (and `keysSent: true`). The
 * controls show its own sentence (look at the screen first) rather than the
 * generic one. Negative: a plain 500 keeps the generic sentence.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PlanReviewControls } from '@/components/worktree/PlanReviewControls';
import { jsonReply } from '../prompt-response-outcome-3292/cases';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function submitWith(reply: Response): Promise<void> {
  fetchMock.mockResolvedValue(reply);
  render(<PlanReviewControls worktreeId="wt-4031" cliToolId="command-code" />);
  fireEvent.change(screen.getByTestId('plan-review-comment-input'), { target: { value: 'tighten step 2' } });
  fireEvent.click(screen.getByTestId('plan-review-submit'));
  await waitFor(() => expect(screen.getByTestId('plan-review-submit')).not.toBeDisabled());
}

describe('[#4031] the plan review controls on an answer stopped part-way', () => {
  it('positive: 500 answer_input_lost — its own sentence', async () => {
    await submitWith(
      jsonReply(500, { error: 'Failed to send answer to tmux: stopped', reason: 'answer_input_lost', keysSent: true }),
    );
    expect(screen.getByTestId('plan-review-error')).toHaveTextContent('worktree.planReview.refusal.inputLost');
  });

  it('negative: a plain 500 — the generic sentence', async () => {
    await submitWith(jsonReply(500, { error: 'Failed to send answer to tmux: no server running' }));
    expect(screen.getByTestId('plan-review-error')).toHaveTextContent('worktree.planReview.refusal.generic');
    expect(screen.getByTestId('plan-review-error')).not.toHaveTextContent('inputLost');
  });
});
