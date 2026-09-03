/**
 * The jump FAB — one control, both ends (Issue #2283).
 *
 * Before this Issue the chat surface offered exactly ONE way to move: a
 * jump-to-latest chip that appeared only when something new had arrived below
 * the reader or a turn was running. There was no way to reach the BEGINNING of
 * a conversation at all, Home/End did nothing (the scroll region was not
 * focusable), and the chip's own `scrollTop = scrollHeight` could not reach the
 * real end of a virtual list whose tail rows had never been measured.
 *
 * So the control moved here, to the component that owns the virtualizer, and
 * took the shape the terminal surface has had since Issue #1079: a single
 * circular button that offers the beginning while you are at the end and the
 * end while you are anywhere else.
 *
 * ## What each case is protecting
 *
 *  - **the direction** is derived from the scroll position, not from arrival of
 *    new content, which is what makes "get me back to the top" reachable at all;
 *  - **`scrollToIndex`, never `scrollTop`**. Measured on the reported worktree,
 *    the direct assignment stopped 7,770px short of the last row. The spy
 *    assertions and the `not.toBe(scrollHeight)` position assertion are both
 *    here because either one alone survives the mutation the other catches;
 *  - **the generating spinner**, which Issue #2233 put on the chip and this
 *    Issue folds into the FAB, along with #2248's rule that a HELD body must not
 *    claim to still be responding;
 *  - **exactly one control**, ever. `ChatSurface` withdraws its chip when this
 *    component publishes scroll controls; both halves of that are asserted, here
 *    and in `ChatSurface-jump-controls-2283.test.tsx`.
 *
 * The fixture is the one `ChatTranscript-tail-anchor-2283.test.tsx` explains:
 * jsdom computes no layout, so the viewport, the scroll height and the scroll
 * position all have to be supplied, and the `scroll` event a browser fires after
 * a programmatic scroll has to be supplied too.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import { installVirtualLayout } from '@tests/helpers/virtual-layout';

const SCROLL_CONTAINER_TESTID = 'chat-transcript-scroll-container';
const FAB_TESTID = 'chat-transcript-jump-fab';
const VIEWPORT_HEIGHT = 600;

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

const { ChatTranscript, CHAT_TRANSCRIPT_JUMP_FAB_TESTID } = await import(
  '@/components/worktree/ChatTranscript'
);

const WORKTREE_ID = 'wt-2283-fab';

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

const scrollTops = new WeakMap<HTMLElement, number>();

function installScrollMetrics(): () => void {
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
      return isContainer(this) ? VIEWPORT_HEIGHT : 0;
    },
  });
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (!isContainer(this)) return 0;
      const sizer = this.querySelector<HTMLElement>(':scope > div[style*="position: relative"]');
      const sized = sizer ? Number.parseFloat(sizer.style.height || '0') : 0;
      return Math.max(sized, VIEWPORT_HEIGHT);
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

async function settle(el: HTMLElement, frames = 14): Promise<void> {
  for (let i = 0; i < frames; i += 1) {
    await act(async () => {
      fireEvent.scroll(el);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
  }
}

function container(): HTMLElement {
  return screen.getByTestId(SCROLL_CONTAINER_TESTID);
}

function fab(): HTMLElement | null {
  return screen.queryByTestId(FAB_TESTID);
}

function maxScrollOffset(): number {
  return container().scrollHeight - container().clientHeight;
}

/** Move the reader up the way a real wheel scroll would. */
function scrollUp(): void {
  scrollTops.set(container(), 0);
  fireEvent.scroll(container());
}

type LiveTurn = React.ComponentProps<typeof ChatTranscript>['liveTurn'];

function renderTranscript(messages: ChatMessage[], liveTurn: LiveTurn = null) {
  return render(
    <ChatTranscript
      messages={messages}
      worktreeId={WORKTREE_ID}
      cliToolId="claude"
      liveTurn={liveTurn}
      onFilePathClick={vi.fn()}
    />,
  );
}

describe('[#2283] ChatTranscript jump FAB', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
    aims.length = 0;
  });

  function withLayout(rowHeight = 100): void {
    cleanups.push(
      installVirtualLayout({
        scrollContainerTestId: SCROLL_CONTAINER_TESTID,
        viewportHeight: VIEWPORT_HEIGHT,
        rowHeight,
      }),
    );
    cleanups.push(installScrollMetrics());
  }

  it('publishes the testid it is addressed by', () => {
    expect(CHAT_TRANSCRIPT_JUMP_FAB_TESTID).toBe(FAB_TESTID);
  });

  it('offers the BEGINNING while the reader is at the tail', async () => {
    withLayout();
    renderTranscript(makeMessages(200));
    await settle(container());

    expect(fab()).toHaveAttribute('data-direction', 'top');
    expect(fab()).toHaveAttribute('aria-label', 'worktree.chatTranscript.jumpToTop');
    // There was NO way to reach the top before this Issue; the arrow is the
    // difference the reader sees.
    expect(fab()?.querySelector('svg.lucide-arrow-up')).not.toBeNull();
  });

  it('offers the END once the reader has scrolled up', async () => {
    withLayout();
    renderTranscript(makeMessages(200));
    await settle(container());

    act(() => scrollUp());

    expect(fab()).toHaveAttribute('data-direction', 'latest');
    expect(fab()).toHaveAttribute('aria-label', 'worktree.chatSurface.jumpToLatest');
    expect(fab()).not.toHaveAttribute('data-generating');
  });

  it('reaches the true end through the virtualizer rather than by writing scrollTop', async () => {
    // The mutation guard: put `container.scrollTop = container.scrollHeight`
    // back in the handler and BOTH of the last two assertions fail — the aim is
    // never recorded, and the position lands a viewport past the bottom of the
    // scrollable range, which is exactly the "chip that does not reach the end"
    // the Issue reported.
    withLayout();
    renderTranscript(makeMessages(200));
    await settle(container());
    act(() => scrollUp());
    aims.length = 0;

    fireEvent.click(fab() as HTMLElement);
    await settle(container());

    expect(aims.some((aim) => aim.index === 199 && aim.align === 'end')).toBe(true);
    expect(container().scrollTop).toBe(maxScrollOffset());
    expect(container().scrollTop).not.toBe(container().scrollHeight);
  });

  it('gets there in ONE press from the very beginning of the conversation', async () => {
    // "Press it again" was the reported workaround for the chip; a control that
    // needs two presses to reach the end has not answered the Issue.
    withLayout(3000);
    renderTranscript(makeMessages(200));
    await settle(container());

    fireEvent.click(fab() as HTMLElement); // to the top
    await settle(container());
    expect(container().scrollTop).toBe(0);
    expect(fab()).toHaveAttribute('data-direction', 'latest');

    fireEvent.click(fab() as HTMLElement); // and back to the end, once
    await settle(container());

    expect(container().scrollTop).toBe(maxScrollOffset());
    expect(Math.max(...Array.from(document.querySelectorAll('[data-index]')).map((n) =>
      Number(n.getAttribute('data-index')),
    ))).toBe(199);
  });

  it('lands on the FIRST row, by index, when it offers the beginning', async () => {
    withLayout();
    renderTranscript(makeMessages(200));
    await settle(container());
    aims.length = 0;

    fireEvent.click(fab() as HTMLElement);

    expect(aims).toContainEqual({ index: 0, align: 'start' });
  });

  it('does not drag the reader back down after they jump to the top', async () => {
    // The Issue asks for this in as many words: going to the beginning UNPINS.
    // Without it the next message appended would undo the jump the reader just
    // asked for.
    withLayout();
    const messages = makeMessages(50);
    const view = renderTranscript(messages);
    await settle(container());
    fireEvent.click(fab() as HTMLElement);
    await settle(container());
    aims.length = 0;

    view.rerender(
      <ChatTranscript
        messages={[...messages, ...makeMessages(1).map((m) => ({ ...m, id: 'm-new' }))]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        liveTurn={null}
        onFilePathClick={vi.fn()}
      />,
    );
    await settle(container());

    expect(aims.some((aim) => aim.align === 'end')).toBe(false);
    expect(container().scrollTop).toBe(0);
  });

  it('wears the spinner while a turn is being generated below the reader', async () => {
    withLayout();
    renderTranscript(makeMessages(200), { turnKey: 'claude-turn:u-1', body: 'The reply so far.' });
    await settle(container());

    act(() => scrollUp());

    expect(fab()).toHaveAttribute('data-generating', 'true');
    expect(fab()).toHaveAttribute('aria-label', 'worktree.chatSurface.jumpToLatestGenerating');
    expect(fab()?.querySelector('svg.animate-spin')).not.toBeNull();
  });

  it('does not claim a HELD body is still responding', async () => {
    // Issue #2248's rule, inherited with the control: a settling turn is below
    // the reader in the same way, so the way back is still offered — with the
    // plain arrow, because nothing is running.
    withLayout();
    renderTranscript(makeMessages(200), {
      turnKey: 'claude-turn:u-1',
      body: 'The reply so far.',
      settling: true,
    });
    await settle(container());

    act(() => scrollUp());

    expect(fab()).toHaveAttribute('data-direction', 'latest');
    expect(fab()).not.toHaveAttribute('data-generating');
    expect(fab()?.querySelector('svg.animate-spin')).toBeNull();
  });

  it('shows exactly ONE control at a time', async () => {
    withLayout();
    renderTranscript(makeMessages(200), { turnKey: 'claude-turn:u-1', body: 'body' });
    await settle(container());
    expect(screen.getAllByTestId(FAB_TESTID)).toHaveLength(1);

    act(() => scrollUp());
    expect(screen.getAllByTestId(FAB_TESTID)).toHaveLength(1);
  });

  it('draws no control over an empty conversation', () => {
    withLayout();
    renderTranscript([]);
    expect(fab()).toBeNull();
    expect(screen.getByTestId('chat-transcript-empty')).toBeInTheDocument();
  });

  it('answers End and Home from the scroll region itself', async () => {
    // `tabIndex` is what makes the region focusable, and without it the browser
    // routes both keys to the document and the transcript never sees them.
    // Neither key is registered in `KEYBOARD_SHORTCUTS`, so nothing is being
    // taken away from anything else.
    withLayout();
    renderTranscript(makeMessages(200));
    await settle(container());
    expect(container()).toHaveAttribute('tabIndex', '0');
    aims.length = 0;

    fireEvent.keyDown(container(), { key: 'Home' });
    expect(aims).toContainEqual({ index: 0, align: 'start' });

    aims.length = 0;
    fireEvent.keyDown(container(), { key: 'End' });
    expect(aims).toContainEqual({ index: 199, align: 'end' });
    await settle(container());
  });

  it('leaves Home and End alone inside a text field', async () => {
    // The search bar is a sibling of the scroll region rather than a child, but
    // a future control inside it must not lose start-of-line / end-of-line.
    withLayout();
    renderTranscript(makeMessages(200));
    await settle(container());
    const input = document.createElement('input');
    container().appendChild(input);
    aims.length = 0;

    fireEvent.keyDown(input, { key: 'End' });

    expect(aims).toHaveLength(0);
  });
});
