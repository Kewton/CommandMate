/**
 * Landing at the tail, and staying there (Issue #2283).
 *
 * ## The defect this file describes
 *
 * Switching a codex worktree from the terminal surface to the chat surface
 * landed the reader at scrollTop 33,060 of 59,044 — around the THIRD of 208
 * rows — and getting to the newest reply took tens of screens of scrolling.
 * Nothing was broken in the follow-the-tail code; the tail was simply never
 * aimed at, because `ChatTranscript` only followed a row count that GREW and a
 * mount is a count that appears.
 *
 * ## Why one `scrollToIndex` is not the fix
 *
 * `@tanstack/virtual-core` 3.16 reconciles a programmatic scroll for as long as
 * its target keeps moving and then gives up after one stable frame. The
 * measurements that move the target arrive later than that: a row is only
 * measured once it MOUNTS, and it only mounts once a previous aim brought it
 * into the window. Against `CHAT_ESTIMATED_MESSAGE_HEIGHT_PX` (120px) and rows
 * that were really up to 33,476px, the first aim lands nowhere near the end.
 *
 * The tests below therefore assert the CONVERGED position, and one of them
 * makes the divergence extreme on purpose (`rowHeight` 3,000 against the same
 * 120px estimate) so that a single un-repeated aim cannot pass it.
 *
 * ## What the fixture has to supply
 *
 * jsdom performs no layout, so three things a browser would compute have to be
 * stubbed, and each of them is load-bearing rather than ceremony:
 *
 *  - `offsetHeight` (via `installVirtualLayout`): the virtualizer's viewport
 *    size and every row measurement come from it;
 *  - `scrollHeight` / `clientHeight`: `getMaxScrollOffset()` — which is what
 *    `scrollToIndex(last, 'end')` resolves to for the LAST index — reads them
 *    off the real element. Here `scrollHeight` is derived from the sizer div
 *    the component renders, so it grows as rows are measured exactly as a
 *    browser's would;
 *  - `scrollTop`: jsdom keeps no scroll position for an element with no layout
 *    box, and `Element.prototype.scrollTo` (stubbed in `tests/setup.ts`) writes
 *    through it.
 *
 * And one thing jsdom does not do at all: fire a `scroll` event when
 * `scrollTop` is assigned. `settle()` supplies it, which is why it interleaves
 * the event with the animation frames — the anchor's next aim depends on rows
 * that only mount once the virtualizer has been told the offset moved.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import { CHAT_ESTIMATED_MESSAGE_HEIGHT_PX } from '@/lib/chat/chat-transcript-view';
import { installVirtualLayout } from '@tests/helpers/virtual-layout';

const SCROLL_CONTAINER_TESTID = 'chat-transcript-scroll-container';

/**
 * Every `scrollToIndex` the component asks for, in order.
 *
 * Recorded by wrapping the instance the real hook returns rather than by
 * replacing the virtualizer: the assertions below are about the CONVERGED
 * scroll position as much as about the calls, and a fake virtualizer has no
 * position to converge to.
 */
const aims: Array<{ index: number; align?: string }> = [];

vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>();
  return {
    ...actual,
    useVirtualizer: ((options: Parameters<typeof actual.useVirtualizer>[0]) => {
      const instance = actual.useVirtualizer(options);
      const patchable = instance as unknown as {
        __aimsPatched?: boolean;
        scrollToIndex: (index: number, options?: { align?: string }) => void;
      };
      if (!patchable.__aimsPatched) {
        patchable.__aimsPatched = true;
        const original = patchable.scrollToIndex;
        patchable.scrollToIndex = (index, opts) => {
          aims.push({ index, align: opts?.align });
          return original(index, opts);
        };
      }
      return instance;
    }) as typeof actual.useVirtualizer,
  };
});

const { ChatTranscript } = await import('@/components/worktree/ChatTranscript');

const WORKTREE_ID = 'wt-2283-anchor';
const VIEWPORT_HEIGHT = 600;

function makeMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m-${i}`,
    worktreeId: WORKTREE_ID,
    role: (i % 2 === 0 ? 'user' : 'assistant') as ChatMessage['role'],
    content: `message body ${i}`,
    timestamp: new Date(Date.UTC(2026, 8, 3, 10, 0, i)),
    messageType: 'normal' as const,
    archived: false,
    cliToolId: 'claude' as const,
  }));
}

/** Per-element scroll positions, since jsdom keeps none of its own. */
const scrollTops = new WeakMap<HTMLElement, number>();

/**
 * Give the scroll container the metrics `getMaxScrollOffset()` reads.
 *
 * `scrollHeight` is taken from the virtualizer's sizer div, so it reports the
 * SAME total the virtualizer believes in and grows with every measurement — the
 * behaviour the anchor has to chase.
 */
function installScrollMetrics(viewportHeight = VIEWPORT_HEIGHT): () => void {
  const proto = HTMLElement.prototype;
  const saved: Record<string, PropertyDescriptor | undefined> = {
    scrollHeight: Object.getOwnPropertyDescriptor(proto, 'scrollHeight'),
    clientHeight: Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
    scrollTop: Object.getOwnPropertyDescriptor(proto, 'scrollTop'),
  };
  const isContainer = (el: HTMLElement) =>
    el.getAttribute('data-testid') === SCROLL_CONTAINER_TESTID;

  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isContainer(this) ? viewportHeight : 0;
    },
  });
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (!isContainer(this)) return 0;
      const sizer = this.querySelector<HTMLElement>(':scope > div[style*="position: relative"]');
      const sized = sizer ? Number.parseFloat(sizer.style.height || '0') : 0;
      return Math.max(sized, viewportHeight);
    },
  });
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return scrollTops.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      scrollTops.set(this, Number(value) || 0);
    },
  });

  return () => {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(proto, key, descriptor);
      else Reflect.deleteProperty(proto, key);
    }
  };
}

/**
 * The bookkeeping a browser does for free: the `scroll` event that follows a
 * programmatic scroll, and the animation frame the anchor's next aim rides on.
 */
async function settle(container: HTMLElement, frames = 14): Promise<void> {
  for (let i = 0; i < frames; i += 1) {
    await act(async () => {
      fireEvent.scroll(container);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
  }
}

function container(): HTMLElement {
  return screen.getByTestId(SCROLL_CONTAINER_TESTID);
}

/** Where a browser would stop: the bottom of the scrollable range. */
function maxScrollOffset(el: HTMLElement): number {
  return el.scrollHeight - el.clientHeight;
}

function mountedIndices(): number[] {
  return Array.from(document.querySelectorAll('[data-index]')).map((node) =>
    Number(node.getAttribute('data-index')),
  );
}

function renderTranscript(messages: ChatMessage[], isLoading = false) {
  return render(
    <ChatTranscript
      messages={messages}
      worktreeId={WORKTREE_ID}
      cliToolId="claude"
      isLoading={isLoading}
      onFilePathClick={vi.fn()}
    />,
  );
}

describe('[#2283] ChatTranscript lands at the tail', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
    aims.length = 0;
  });

  function withLayout(rowHeight: number): void {
    cleanups.push(
      installVirtualLayout({
        scrollContainerTestId: SCROLL_CONTAINER_TESTID,
        viewportHeight: VIEWPORT_HEIGHT,
        rowHeight,
      }),
    );
    cleanups.push(installScrollMetrics());
  }

  it('mounts 200 rows with the LAST one on screen', async () => {
    // The reported defect exactly: the transcript arrives with its history
    // already in hand, so no count ever grows and the old follow never fired.
    withLayout(100);
    renderTranscript(makeMessages(200));
    await settle(container());

    expect(Math.max(...mountedIndices())).toBe(199);
    expect(container().scrollTop).toBe(maxScrollOffset(container()));
  });

  it('aims at the last ROW on mount, by index, through the virtualizer', async () => {
    // The mutation guard for the mount branch: delete the `previous === -1`
    // arm of the layout effect and no aim is ever taken.
    withLayout(100);
    renderTranscript(makeMessages(200));

    expect(aims.length).toBeGreaterThan(0);
    expect(aims[0]).toEqual({ index: 199, align: 'end' });
    await settle(container());
  });

  it('lands at the tail across the loading → loaded swap', async () => {
    // No message count changes over that transition, so an append-shaped
    // condition cannot see the commonest way of arriving at a transcript.
    withLayout(100);
    const messages = makeMessages(200);
    const view = renderTranscript(messages, true);
    expect(screen.getByTestId('chat-transcript-loading')).toBeInTheDocument();
    expect(aims).toHaveLength(0);

    view.rerender(
      <ChatTranscript
        messages={messages}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        isLoading={false}
        onFilePathClick={vi.fn()}
      />,
    );
    await settle(container());

    expect(Math.max(...mountedIndices())).toBe(199);
    expect(container().scrollTop).toBe(maxScrollOffset(container()));
  });

  it('holds the tail while measurements dwarf the estimate', async () => {
    // 3,000px rows against a 120px estimate — the shape of the real transcript,
    // where 13 of 208 rows were over 200 lines. A single un-repeated aim lands
    // at a total that is still 96% guesswork; only re-aiming as the total moves
    // ends up at the bottom.
    expect(CHAT_ESTIMATED_MESSAGE_HEIGHT_PX).toBeLessThan(3000);
    withLayout(3000);
    renderTranscript(makeMessages(200));
    await settle(container());

    expect(container().scrollTop).toBe(maxScrollOffset(container()));
    // More than the one aim the mount took: the correction is the point.
    expect(aims.filter((aim) => aim.index === 199 && aim.align === 'end').length).toBeGreaterThan(1);
  });

  it('follows a message appended while the reader is at the tail', async () => {
    withLayout(100);
    const messages = makeMessages(50);
    const view = renderTranscript(messages);
    await settle(container());
    aims.length = 0;

    view.rerender(
      <ChatTranscript
        messages={[...messages, ...makeMessages(1).map((m) => ({ ...m, id: 'm-new' }))]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        onFilePathClick={vi.fn()}
      />,
    );
    await settle(container());

    expect(aims.some((aim) => aim.index === 50 && aim.align === 'end')).toBe(true);
    expect(container().scrollTop).toBe(maxScrollOffset(container()));
  });

  it('leaves a reader who scrolled up where they are when a message arrives', async () => {
    // The basis of the whole feature is unchanged: `isNearBottom`'s 80px
    // threshold decides, and a reader above it is not followed.
    withLayout(100);
    const messages = makeMessages(50);
    const view = renderTranscript(messages);
    await settle(container());

    scrollTops.set(container(), 0);
    fireEvent.scroll(container());
    aims.length = 0;

    view.rerender(
      <ChatTranscript
        messages={[...messages, ...makeMessages(1).map((m) => ({ ...m, id: 'm-new' }))]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        onFilePathClick={vi.fn()}
      />,
    );
    await settle(container());

    expect(aims).toHaveLength(0);
    expect(container().scrollTop).toBe(0);
  });

  it("does not fight the search's own scrollToIndex", async () => {
    // #1123's rule, inherited: a match is somewhere in the middle and the tail
    // anchor would drag the reader off it.
    withLayout(100);
    const messages = makeMessages(60);
    const view = renderTranscript(messages);
    await settle(container());

    fireEvent.click(screen.getByTestId('chat-transcript-search-toggle'));
    fireEvent.change(screen.getByLabelText('worktree.history.search.keywordLabel'), {
      target: { value: 'message body 3' },
    });
    // `useHistorySearch` debounces by SEARCH_DEBOUNCE_MS; until the matches
    // land, `isSearchActive` is false and the guard under test is not even
    // reached — so the wait is what makes this case non-vacuous.
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
    });
    expect(screen.getByRole('status').textContent).not.toBe('0/0');
    aims.length = 0;

    view.rerender(
      <ChatTranscript
        messages={[...messages, ...makeMessages(1).map((m) => ({ ...m, id: 'm-new' }))]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        onFilePathClick={vi.fn()}
      />,
    );

    expect(aims.some((aim) => aim.index === 60 && aim.align === 'end')).toBe(false);
  });
});
