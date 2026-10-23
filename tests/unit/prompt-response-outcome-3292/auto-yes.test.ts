/**
 * Browser-side Auto-Yes's column of the shared table (Issue #3292) — see
 * `./cases`.
 *
 * `useAutoYes` answers on its own: it draws no card and raises no toast, so
 * what the rows can say about it is how often it sends. Whatever the reply, an
 * approval is answered ONCE and not again until the display changes — a
 * refused or failed answer must not turn every poll into another POST.
 *
 * What the hook then announces ("Auto responded" only for an `answered`
 * reply) is pinned per row in `../prompt-response-outcome-3331/` (Issue #3331).
 *
 * Issue #3821: the browser no longer answers, so every row now asserts that
 * nothing is sent — for the approval, its repeats, and a different approval.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAutoYes, type UseAutoYesParams } from '@/hooks/useAutoYes';
import type { PromptData } from '@/types/models';
import { PROMPT_RESPONSE_ROWS, replyOf } from './cases';

const WORKTREE_ID = 'wt-3292';

/** A fresh object each time, same content: what a poll hands the hook. */
function approval(question: string): PromptData {
  return {
    type: 'multiple_choice',
    question,
    status: 'pending',
    options: [
      { number: 1, label: 'Yes', isDefault: true },
      { number: 2, label: 'No', isDefault: false },
    ],
  };
}

function params(promptData: PromptData): UseAutoYesParams {
  return {
    worktreeId: WORKTREE_ID,
    cliTool: 'claude',
    isPromptWaiting: true,
    promptData,
    autoYesEnabled: true,
    serverPollerActive: false,
  };
}

describe('[#3292] an answer from browser-side Auto-Yes', () => {
  beforeEach(() => {
    // The hook logs a request that got no reply; that line is not the result.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(PROMPT_RESPONSE_ROWS)('%s: [#3821] never sent, whatever the reply would be', async (_name, testCase) => {
    const posted: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => {
        posted.push(String(input));
        return replyOf(testCase);
      }),
    );

    const { rerender } = renderHook((props: UseAutoYesParams) => useAutoYes(props), {
      initialProps: params(approval('Do you want to proceed?')),
    });
    expect(posted).toEqual([]);

    // Two more polls show the same approval.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    rerender(params(approval('Do you want to proceed?')));
    rerender(params(approval('Do you want to proceed?')));
    expect(posted).toEqual([]);

    // A different approval (which the hook used to answer) is not answered either.
    rerender(params(approval('Run the migration?')));
    expect(posted).toEqual([]);
    expect(testCase.name).toBeTruthy();
  });
});
