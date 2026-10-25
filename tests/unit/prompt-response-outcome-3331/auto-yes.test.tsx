/**
 * What browser-side Auto-Yes announces, per row of #3292's shared table
 * (Issue #3331) — see `../prompt-response-outcome-3292/cases`.
 *
 * `useAutoYes` used to set `lastAutoResponse` before the reply arrived, so
 * `AutoYesToggle` said "Auto responded" for a refused (200 `success: false`,
 * 404 `decision_not_found`) or failed (500, no reply) answer too. It now reads
 * the reply with `readPromptResponseOutcome` and announces `answered` only.
 * How often it sends is #3292's `auto-yes.test.ts` and is not changed here.
 *
 * The toggle's notice: shown once per answer and gone after
 * `NOTIFICATION_DISMISS_MS`, even when the value returns to null before then
 * (it used to stay on screen) and when the same answer comes twice in a row
 * (the second used to show nothing).
 *
 * A reply that lands after the screen moved to another worktree, tool or
 * instance is not announced there.
 *
 * Issue #3821: the browser no longer answers and the toggle no longer has a
 * notice. Every case now asserts what remains true of all of the above —
 * nothing is announced, for any reply, on any agent, for any value the toggle
 * is handed — rather than when the notice comes and goes.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import { useAutoYes, type UseAutoYesParams } from '@/hooks/useAutoYes';
import { AutoYesToggle } from '@/components/worktree/AutoYesToggle';
import { NOTIFICATION_DISMISS_MS } from '@/config/ui-feedback-config';
import type { PromptData } from '@/types/models';
import { PROMPT_RESPONSE_ROWS, jsonReply, replyOf } from '../prompt-response-outcome-3292/cases';

const WORKTREE_ID = 'wt-3331';
const NOTICE = 'Auto responded: "1"';

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

/** The hook wired to the toggle, as the detail screen does. */
function Harness(props: UseAutoYesParams) {
  const { lastAutoResponse } = useAutoYes(props);
  return (
    <AutoYesToggle
      enabled
      expiresAt={null}
      onToggle={async () => {}}
      lastAutoResponse={lastAutoResponse}
    />
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('[#3331] browser-side Auto-Yes announces only an answer that was taken', () => {
  beforeEach(() => {
    // The hook logs a request that got no reply; that line is not the result.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(PROMPT_RESPONSE_ROWS)('%s: [#3821] lastAutoResponse stays null, whatever the reply', async (_name, testCase) => {
    vi.stubGlobal('fetch', vi.fn(() => replyOf(testCase)));

    const { result } = renderHook((props: UseAutoYesParams) => useAutoYes(props), {
      initialProps: params(approval('Do you want to proceed?')),
    });
    // Nothing is announced while the answer is in flight.
    expect(result.current.lastAutoResponse).toBeNull();

    await settle();
    expect(result.current.lastAutoResponse).toBeNull();
    expect(testCase.outcome).toBeTruthy();
  });

  it.each(PROMPT_RESPONSE_ROWS)('%s: [#3821] the toggle never says "Auto responded"', async (_name, testCase) => {
    vi.stubGlobal('fetch', vi.fn(() => replyOf(testCase)));

    render(<Harness {...params(approval('Do you want to proceed?'))} />);
    await settle();

    expect(screen.queryByText(/Auto responded/)).not.toBeInTheDocument();
    expect(testCase.outcome).toBeTruthy();
  });

  it('[#3821] two approvals in a row: nothing reaches the display', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonReply(200, { success: true }))));
    const seen: Array<string | null> = [];

    const { rerender } = renderHook(
      (props: UseAutoYesParams) => {
        const value = useAutoYes(props).lastAutoResponse;
        if (seen[seen.length - 1] !== value) seen.push(value);
        return value;
      },
      { initialProps: params(approval('Do you want to proceed?')) },
    );
    await settle();
    rerender(params(approval('Run the migration?')));
    await settle();

    expect(seen).toEqual([null]);
  });
});

describe('[#3331] a reply is announced only for the agent it was sent for', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A fetch whose reply lands only when `land()` is called. */
  function delayedFetch() {
    let land: () => void = () => {};
    const reply = new Promise<Response>((resolve) => {
      land = () => resolve(jsonReply(200, { success: true }));
    });
    vi.stubGlobal('fetch', vi.fn(() => reply));
    return { land: () => land() };
  }

  /** The same screen showing another agent, with nothing waiting yet. */
  function switchedTo(change: Partial<UseAutoYesParams>): UseAutoYesParams {
    return { ...params(approval('Do you want to proceed?')), isPromptWaiting: false, promptData: null, ...change };
  }

  it.each([
    ['another tool', { cliTool: 'codex' }],
    ['another instance of the same tool', { instanceId: 'claude-2' }],
    ['another worktree', { worktreeId: 'wt-other' }],
  ] as const)('switching to %s while the reply is pending: no notice there', async (_name, change) => {
    const { land } = delayedFetch();
    const { rerender } = render(<Harness {...params(approval('Do you want to proceed?'))} />);

    rerender(<Harness {...switchedTo(change)} />);
    land();
    await settle();

    expect(screen.queryByText(/Auto responded/)).not.toBeInTheDocument();
  });

  it('[#3821] staying on the agent: nothing is sent, so nothing is announced', async () => {
    const { land } = delayedFetch();
    const { rerender } = render(<Harness {...params(approval('Do you want to proceed?'))} />);

    rerender(<Harness {...switchedTo({})} />);
    land();
    await settle();

    expect(screen.queryByText(/Auto responded/)).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('[#3821] switching away and back: nothing is announced either', async () => {
    const { land } = delayedFetch();
    const { rerender } = render(<Harness {...params(approval('Do you want to proceed?'))} />);

    rerender(<Harness {...switchedTo({ cliTool: 'codex' })} />);
    rerender(<Harness {...switchedTo({})} />);
    land();
    await settle();

    expect(screen.queryByText(/Auto responded/)).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('[#3331] AutoYesToggle: the notice is shown once per answer and then goes (#3821: never shown)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function toggle(lastAutoResponse: string | null) {
    return (
      <AutoYesToggle enabled expiresAt={null} onToggle={async () => {}} lastAutoResponse={lastAutoResponse} />
    );
  }

  it('[#3821] a value handed to the toggle is not shown, then or later', () => {
    const { rerender } = render(toggle('1'));
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();

    rerender(toggle(null));
    act(() => {
      vi.advanceTimersByTime(NOTIFICATION_DISMISS_MS);
    });
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it('[#3821] the same string twice (with null between) is not shown either', () => {
    const { rerender } = render(toggle('1'));
    rerender(toggle(null));
    rerender(toggle('1'));
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it('[#3821] another string is not shown either', () => {
    const { rerender } = render(toggle('1'));
    rerender(toggle(null));
    rerender(toggle('2'));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText(/Auto responded/)).not.toBeInTheDocument();
  });
});
