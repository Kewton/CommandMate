/**
 * Opening the transcript's search from outside, and where the bar opens (Issue #2823).
 *
 * The phone's transcript draws no search icon (`hideCornerControls`, #2821), so
 * its entry is the "More actions" sheet, which raises the window event
 * `chat-search-open`. What this file pins on the transcript's side:
 *
 *  1. only a transcript given `openSearchOnWindowEvent` answers — the PC split
 *     (several transcripts, none opted in) ignores the event;
 *  2. the event opens the bar with its input focused, and a second event while
 *     the bar is open puts focus back in the input;
 *  3. withdrawing the prop withdraws the listener;
 *  4. `searchBarTopClassName` replaces the strip's `top-2`, and the default
 *     class list is unchanged.
 *
 * The sheet's focus restore racing the input is pinned end to end in
 * `WorktreeDetailRefactored-mobile-search-2823.test.tsx`.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import { ChatTranscript } from '@/components/worktree/ChatTranscript';

const WORKTREE_ID = 'wt-2823';
/** The next-intl stub echoes keys, so the search input's label is its key. */
const SEARCH_INPUT_LABEL = 'worktree.history.search.keywordLabel';
const SEARCH_TOGGLE_TESTID = 'chat-transcript-search-toggle';
const STRIP_CLASS = 'pointer-events-none absolute right-2 top-2 z-10 flex items-start justify-end gap-1';

const MESSAGES: ChatMessage[] = [
  {
    id: 'u1',
    worktreeId: WORKTREE_ID,
    role: 'user',
    content: 'find the probe',
    timestamp: new Date(Date.UTC(2026, 8, 21, 10, 0, 0)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
  },
];

function transcript(props: Partial<React.ComponentProps<typeof ChatTranscript>> = {}) {
  return (
    <ChatTranscript
      messages={MESSAGES}
      worktreeId={WORKTREE_ID}
      cliToolId="claude"
      onFilePathClick={vi.fn()}
      {...props}
    />
  );
}

/** What `MobileTerminalTab` passes on the phone. */
const PHONE = { hideCornerControls: true, openSearchOnWindowEvent: true } as const;

function raise(): void {
  act(() => {
    window.dispatchEvent(new CustomEvent('chat-search-open'));
  });
}

describe('[#2823] who answers chat-search-open', () => {
  it('is ignored by a transcript that did not opt in (the PC default)', () => {
    render(transcript());
    raise();

    expect(screen.queryByLabelText(SEARCH_INPUT_LABEL)).toBeNull();
    expect(screen.getByTestId(SEARCH_TOGGLE_TESTID)).toBeInTheDocument();
  });

  it('opens the bar with its input focused when opted in', () => {
    render(transcript(PHONE));
    expect(screen.queryByLabelText(SEARCH_INPUT_LABEL)).toBeNull();

    raise();

    const input = screen.getByLabelText(SEARCH_INPUT_LABEL);
    expect(document.activeElement).toBe(input);
    expect(screen.queryByTestId(SEARCH_TOGGLE_TESTID)).toBeNull();
  });

  it('opens only the opted-in transcript when several are mounted', () => {
    render(
      <>
        <div data-testid="split-0">{transcript({ splitIndex: 0 })}</div>
        <div data-testid="split-1">{transcript({ splitIndex: 1 })}</div>
        <div data-testid="phone">{transcript(PHONE)}</div>
      </>,
    );
    raise();

    expect(within(screen.getByTestId('split-0')).queryByLabelText(SEARCH_INPUT_LABEL)).toBeNull();
    expect(within(screen.getByTestId('split-1')).queryByLabelText(SEARCH_INPUT_LABEL)).toBeNull();
    expect(within(screen.getByTestId('phone')).getByLabelText(SEARCH_INPUT_LABEL)).toBeInTheDocument();
  });

  it('stops answering once the prop is withdrawn', () => {
    const { rerender } = render(transcript(PHONE));
    rerender(transcript({ hideCornerControls: true }));
    raise();

    expect(screen.queryByLabelText(SEARCH_INPUT_LABEL)).toBeNull();
  });
});

describe('[#2823] a request while the bar is already open', () => {
  it('puts focus back in the input and does not open a second bar', () => {
    render(
      <>
        <button type="button" data-testid="elsewhere">elsewhere</button>
        {transcript(PHONE)}
      </>,
    );
    raise();
    const input = screen.getByLabelText(SEARCH_INPUT_LABEL);

    screen.getByTestId('elsewhere').focus();
    expect(document.activeElement).not.toBe(input);

    raise();

    expect(document.activeElement).toBe(input);
    expect(screen.getAllByLabelText(SEARCH_INPUT_LABEL)).toHaveLength(1);
  });
});

describe('[#2823] where the strip starts', () => {
  it('keeps the pre-#2823 class list by default', () => {
    render(transcript());
    const strip = screen.getByTestId(SEARCH_TOGGLE_TESTID).parentElement?.parentElement;

    expect(strip?.className).toBe(STRIP_CLASS);
  });

  it('replaces top-2 with searchBarTopClassName, and the bar opens there', () => {
    render(transcript({ ...PHONE, searchBarTopClassName: 'top-16' }));
    raise();
    const strip = screen.getByRole('search').parentElement?.parentElement;

    expect(strip?.className).toBe(STRIP_CLASS.replace('top-2', 'top-16'));
    expect(strip?.className.split(' ')).not.toContain('top-2');
  });
});
