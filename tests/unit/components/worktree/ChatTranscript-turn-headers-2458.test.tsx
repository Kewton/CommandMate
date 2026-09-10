/**
 * The turn header on the real transcript (Issue #2458).
 *
 * `chat-turn-headers-2458.test.ts` pins the rule; this file pins what the
 * reader actually sees, which the pure function cannot answer. Three things
 * only a render can establish:
 *
 *  - **the variant reaches the markup.** `showHeader` and `header` are two
 *    props that must not disagree, and a bubble that simply drew a role label
 *    whenever a header existed would pass every pure test in the sibling file;
 *  - **the clock is the one the row was given.** The pure function reports
 *    `startedAtMs`; whether the header then renders `18:18 → 18:33` or the
 *    localized `'PPp'` stamp it used before this Issue is decided here;
 *  - **the boundary is not a ROW.** The virtualizer counts rows and
 *    `messageRowIndexById` maps a search hit to one of those numbers. A
 *    divider emitted as its own row would shift every index after it, so the
 *    virtualized branch is driven and the `data-index` values are read off the
 *    DOM rather than assumed.
 *
 * ## Non-vacuity
 *
 * `18:18` is asserted to appear EXACTLY ONCE across the whole transcript. It is
 * the only prompt clock in the fixture, so a component that reused it — the
 * defect the Issue forbids — would put it on four rows and fail here even
 * though every row would still carry "a header with a time in it".
 *
 * The role-label count is asserted the same way, against the same render: three
 * role headers and three time boundaries, not "at least one of each".
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import { ChatTranscript } from '@/components/worktree/ChatTranscript';
import {
  CHAT_TURN_HEADER_TESTID,
  CHAT_TURN_TIME_TESTID,
} from '@/components/worktree/ChatMessageBubble';
import { installVirtualLayout } from '@tests/helpers/virtual-layout';
import {
  turnHeaderMessages,
  TURN_HEADERS_NOW,
} from '@tests/fixtures/chat-turn-headers-2458';

const WORKTREE_ID = 'chat-turn-headers-2458';

/** What the mocked `useTranslations` resolves the two role labels to. */
const ASSISTANT_LABEL = 'worktree.conversation.assistant';
const USER_LABEL = 'worktree.conversation.you';

function renderTranscript(messages: ChatMessage[] = turnHeaderMessages()) {
  return render(
    <ChatTranscript
      messages={messages}
      worktreeId={WORKTREE_ID}
      cliToolId="claude"
      instanceId="claude"
      onFilePathClick={vi.fn()}
    />,
  );
}

function headers(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${CHAT_TURN_HEADER_TESTID}"]`));
}

function headersOfVariant(variant: 'role' | 'time'): HTMLElement[] {
  return headers().filter((header) => header.dataset.headerVariant === variant);
}

/** The header drawn above one message row, or null when the row has none. */
function headerOfRow(messageId: string): HTMLElement | null {
  const row = document.querySelector<HTMLElement>(`[data-row-message-id="${messageId}"]`);
  return row?.querySelector<HTMLElement>(`[data-testid="${CHAT_TURN_HEADER_TESTID}"]`) ?? null;
}

beforeEach(() => {
  window.localStorage.clear();
  // The header stamps `M/d` once a row is not from the reference day, so
  // "today" has to be the fixture's own day rather than whenever the suite ran.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(TURN_HEADERS_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// What the column looks like
// ===========================================================================

describe('[#2458] the fixture column, rendered', () => {
  it('draws three role headers and three time boundaries', () => {
    renderTranscript();
    expect(headersOfVariant('role')).toHaveLength(3);
    expect(headersOfVariant('time')).toHaveLength(3);
  });

  it('puts the role label and the range on the first reply', () => {
    renderTranscript();
    const header = headerOfRow('2458-row-2');
    expect(header).not.toBeNull();
    expect(header!.dataset.headerVariant).toBe('role');
    expect(within(header!).getByText(ASSISTANT_LABEL)).toBeInTheDocument();
    expect(within(header!).getByTestId(CHAT_TURN_TIME_TESTID).textContent).toBe('18:18 → 18:33');
  });

  it('puts a clock and NO role label on each of the three later turns', () => {
    renderTranscript();
    const expected: Record<string, string> = {
      '2458-row-3': '18:59',
      '2458-row-4': '19:14',
      '2458-row-5': '19:26',
    };
    for (const [id, clock] of Object.entries(expected)) {
      const header = headerOfRow(id);
      expect(header, id).not.toBeNull();
      expect(header!.dataset.headerVariant, id).toBe('time');
      expect(within(header!).getByTestId(CHAT_TURN_TIME_TESTID).textContent, id).toBe(clock);
      expect(within(header!).queryByText(ASSISTANT_LABEL), id).toBeNull();
      expect(within(header!).queryByText(USER_LABEL), id).toBeNull();
    }
  });

  it('names the boundary for a screen reader instead of leaving a stray number', () => {
    renderTranscript();
    const separators = screen.getAllByRole('separator', {
      name: 'worktree.chatTranscript.turnBoundary',
    });
    expect(separators).toHaveLength(3);
  });

  it('never reuses 18:18 on a later turn', () => {
    // The defect, stated as a count. A component that fell back to "the last
    // user message" would render 18:18 four more times.
    renderTranscript();
    const stamps = Array.from(
      document.querySelectorAll<HTMLElement>(`[data-testid="${CHAT_TURN_TIME_TESTID}"]`),
    ).map((node) => node.textContent);
    expect(stamps).toEqual(['18:18', '18:18 → 18:33', '18:59', '19:14', '19:26', '21:25']);
    expect(stamps.filter((stamp) => stamp?.includes('18:18'))).toHaveLength(2);
  });

  it('gives each user row a role header and no range', () => {
    renderTranscript();
    for (const [id, clock] of [['2458-row-1', '18:18'], ['2458-row-6', '21:25']] as const) {
      const header = headerOfRow(id);
      expect(header!.dataset.headerVariant, id).toBe('role');
      expect(within(header!).getByText(USER_LABEL), id).toBeInTheDocument();
      expect(within(header!).getByTestId(CHAT_TURN_TIME_TESTID).textContent, id).toBe(clock);
    }
  });

  it('draws no header at all on a row that continues the turn above it', () => {
    // The control for every count above: the component really can render a row
    // with no header, so "three and three" is a choice rather than a ceiling.
    const [prompt, reply] = turnHeaderMessages();
    const continuation: ChatMessage = {
      ...reply,
      id: 'continuation',
      content: 'the same turn, saved twice',
      timestamp: new Date(2026, 8, 7, 18, 40),
    };
    renderTranscript([prompt, reply, continuation]);
    expect(headerOfRow('continuation')).toBeNull();
    expect(headers()).toHaveLength(2);
  });
});

// ===========================================================================
// The boundary is not a row
// ===========================================================================

describe('[#2458] the virtualizer still counts one row per message', () => {
  let restoreLayout: (() => void) | undefined;

  afterEach(() => {
    restoreLayout?.();
    restoreLayout = undefined;
  });

  it('mounts six indexed rows for six messages, each carrying its own header', () => {
    restoreLayout = installVirtualLayout({
      scrollContainerTestId: 'chat-transcript-scroll-container',
      viewportHeight: 2000,
      rowHeight: 100,
    });
    renderTranscript();

    // The virtualized branch, not the #1123 fallback.
    expect(screen.queryByTestId('chat-transcript-fallback-list')).toBeNull();
    const indices = Array.from(document.querySelectorAll<HTMLElement>('[data-index]'))
      .map((node) => Number(node.dataset.index))
      .sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2, 3, 4, 5]);

    // Every header is INSIDE a message row, so no index belongs to a divider.
    for (const header of headers()) {
      expect(header.closest('[data-row-message-id]')).not.toBeNull();
    }
  });

  it('leaves search able to find and highlight the last turn', async () => {
    restoreLayout = installVirtualLayout({
      scrollContainerTestId: 'chat-transcript-scroll-container',
      viewportHeight: 2000,
      rowHeight: 100,
    });
    renderTranscript();

    fireEvent.click(screen.getByTestId('chat-transcript-search-toggle'));
    fireEvent.change(screen.getByLabelText('worktree.history.search.keywordLabel'), {
      target: { value: 'ビルド' },
    });

    // The bar's own counter, and the row the hit resolved to — a divider that
    // had become a row would move the index this jump aims at.
    const counter = within(screen.getByRole('search')).getByRole('status');
    await waitFor(() => expect(counter.textContent).toBe('1/1'));
    expect(document.querySelector('[data-row-message-id="2458-row-5"]')).not.toBeNull();
  });
});

// ===========================================================================
// The #2445 fold is a wall
// ===========================================================================

describe('[#2458] nothing crosses the previous-session boundary', () => {
  it('opens the current segment with a role header and no borrowed start time', () => {
    // The row below answers `claude-prompt:eeee…0005`, which IS in the column —
    // but on the far side of the fold. Sharing one prompt index across the two
    // segments would put 21:25 on it and read it as a continuation of a
    // conversation that has ended; two `buildChatTranscriptRows` calls cannot.
    const previous = turnHeaderMessages();
    const { rerender } = render(
      <ChatTranscript
        messages={previous}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        instanceId="claude"
        sessionEnded
        onFilePathClick={vi.fn()}
      />,
    );

    const reply: ChatMessage = {
      ...previous[1],
      id: '2458-row-7',
      content: 'PR を作りました。',
      timestamp: new Date(2026, 8, 7, 21, 40),
      requestId: 'claude-turn:eeeeeeee-0000-4000-8000-000000000005',
    };
    rerender(
      <ChatTranscript
        messages={[...previous, reply]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        instanceId="claude"
        sessionEnded
        onFilePathClick={vi.fn()}
      />,
    );

    const header = headerOfRow('2458-row-7');
    expect(header).not.toBeNull();
    expect(header!.dataset.headerVariant).toBe('role');
    expect(within(header!).getByTestId(CHAT_TURN_TIME_TESTID).textContent).toBe('21:40');
  });
});

// ===========================================================================
// The header costs the surface no chrome
// ===========================================================================

describe('[#2458] the header is one line of scroll content', () => {
  it('lives inside the scroll region, not beside it', () => {
    // PC split and the phone's terminal tab mount this same component, and both
    // put the composer below it. A header rendered as a sibling of the scroll
    // container would take height from that layout on every turn boundary;
    // inside it, it scrolls away like any other row.
    renderTranscript();
    const scroller = screen.getByTestId('chat-transcript-scroll-container');
    for (const header of headers()) {
      expect(scroller.contains(header)).toBe(true);
      expect(header.parentElement).not.toBe(scroller.parentElement);
    }
  });

  it('keeps the scroll region shrinkable and scrollable', () => {
    renderTranscript();
    const scroller = screen.getByTestId('chat-transcript-scroll-container');
    // `min-h-0` is what lets the column shrink inside its flex parent instead
    // of pushing the composer off the phone; `overflow-y-auto` is the scroll.
    expect(scroller.className).toContain('min-h-0');
    expect(scroller.className).toContain('flex-1');
    expect(scroller.className).toContain('overflow-y-auto');
    expect(screen.getByTestId('chat-transcript').className).toContain('overflow-hidden');
  });

  it('renders each header as a single row of text', () => {
    renderTranscript();
    for (const header of headers()) {
      expect(header.className).toContain('items-center');
      expect(header.className).not.toContain('flex-col');
      expect(header.textContent).not.toContain('\n');
      expect(header.querySelector('br')).toBeNull();
    }
    // The clock itself never wraps mid-range, which is the one string here that
    // can hold a space.
    for (const clock of headersOfVariant('time')) {
      expect(within(clock).getByTestId(CHAT_TURN_TIME_TESTID).className).toContain(
        'whitespace-nowrap',
      );
    }
  });
});
