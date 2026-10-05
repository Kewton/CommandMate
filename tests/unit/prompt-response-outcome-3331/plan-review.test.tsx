/**
 * Command Code's plan review, per row of #3292's shared table (Issue #3331) —
 * see `../prompt-response-outcome-3292/cases`.
 *
 * `PlanReviewControls` read its reply for itself and took anything but a 2xx
 * `success: true` as a failure. It now reads it with the shared
 * `readPromptResponseReply`; what the user sees stays in the controls (no
 * toast): a refused or failed answer shows the error, an answered one clears
 * the box and refreshes the pane. The one row that changes is a 2xx whose body
 * has no `success`: it is now delivered, as on every other path.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PlanReviewControls } from '@/components/worktree/PlanReviewControls';
import { PROMPT_RESPONSE_ROWS, jsonReply, replyOf } from '../prompt-response-outcome-3292/cases';

const WORKTREE_ID = 'wt-3331';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function submitWith(reply: Promise<Response>) {
  fetchMock.mockReturnValue(reply);
  const onKeysSent = vi.fn();
  render(<PlanReviewControls worktreeId={WORKTREE_ID} cliToolId="command-code" onKeysSent={onKeysSent} />);
  fireEvent.change(screen.getByTestId('plan-review-comment-input'), { target: { value: 'tighten step 2' } });
  fireEvent.click(screen.getByTestId('plan-review-submit'));
  await waitFor(() => expect(screen.getByTestId('plan-review-submit')).not.toBeDisabled());
  return onKeysSent;
}

describe('[#3331] the plan review reads its reply like every other path', () => {
  it.each(PROMPT_RESPONSE_ROWS)('%s', async (_name, testCase) => {
    const onKeysSent = await submitWith(replyOf(testCase));

    expect(fetchMock).toHaveBeenCalledWith(`/api/worktrees/${WORKTREE_ID}/prompt-response`, expect.anything());
    if (testCase.outcome === 'answered') {
      expect(screen.queryByTestId('plan-review-error')).not.toBeInTheDocument();
      expect(onKeysSent).toHaveBeenCalledOnce();
      expect(screen.getByTestId('plan-review-comment-input')).toHaveValue('');
    } else {
      expect(screen.getByTestId('plan-review-error')).toHaveTextContent('worktree.planReview.refusal.generic');
      expect(onKeysSent).not.toHaveBeenCalled();
      expect(screen.getByTestId('plan-review-comment-input')).toHaveValue('tighten step 2');
    }
  });

  it('a 2xx with no `success` field is delivered (it used to show the error)', async () => {
    const onKeysSent = await submitWith(Promise.resolve(jsonReply(200, { answer: 'tighten step 2' })));

    expect(screen.queryByTestId('plan-review-error')).not.toBeInTheDocument();
    expect(onKeysSent).toHaveBeenCalledOnce();
  });

  it('control: a 404 that does not name decision_not_found still shows the error and its words', async () => {
    const onKeysSent = await submitWith(Promise.resolve(jsonReply(404, { error: 'Worktree not found' })));

    expect(screen.getByTestId('plan-review-error-detail')).toHaveTextContent('Worktree not found');
    expect(onKeysSent).not.toHaveBeenCalled();
  });

  it('control: a 200 refusal keeps its localized plan_review_* sentence and message', async () => {
    await submitWith(
      Promise.resolve(jsonReply(200, { success: false, reason: 'plan_review_busy', message: 'Move the focus back.' })),
    );

    expect(screen.getByTestId('plan-review-error')).toHaveTextContent('worktree.planReview.refusal.busy');
    expect(screen.getByTestId('plan-review-error-detail')).toHaveTextContent('Move the focus back.');
  });
});
