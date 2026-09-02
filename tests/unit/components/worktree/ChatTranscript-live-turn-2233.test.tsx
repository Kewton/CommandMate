/**
 * The in-flight reply as the last bubble in the column (Issue #2233).
 *
 * Issue #2199 drew it in a footer strip below the transcript. That kept it
 * mounted while the reader scrolled — the whole reason #2194 built the strip —
 * but it also meant the reply grew in one place and, the instant the turn
 * completed, vanished and reappeared somewhere else looking like something else:
 *
 *   |                | in flight (#2199)          | settled (#2232)             |
 *   |----------------|----------------------------|-----------------------------|
 *   | Markdown class | `.assistant-md`            | `.chat-md`                  |
 *   | size           | `text-xs`                  | `text-sm`                   |
 *   | shape          | `rounded-lg` full-width    | `rounded-2xl` bubble        |
 *   | width          | the whole pane             | `max-w-[92%]`               |
 *   | height         | `max-h-[7.5rem]`, scrolled | unclamped                   |
 *
 * So this file asserts two things that pull in opposite directions and both
 * have to hold at once:
 *
 *  1. **It is not a virtualized row.** `@tanstack/react-virtual` unmounts every
 *     row outside the visible window, so a live bubble placed at index `n-1`
 *     disappears the moment the reader scrolls up — the one moment they most
 *     need to know a turn is running. This is #2194's reason, and moving the
 *     bubble into the transcript does not retire it. The mutation Issue #2233
 *     requires: render the live bubble as a row of the virtual list and the
 *     first two tests below go red.
 *  2. **It is the same bubble the settled row wears.** Not "similar" — the same
 *     constants, compared class string against class string, so a change to one
 *     that is not a change to the other is a failure here rather than a visible
 *     jerk on screen a month later.
 *
 * What Issue #2233 deliberately gives up: the bubble is in the scroll flow, so
 * scrolling up carries it off screen. `ChatSurface` answers that on its
 * jump-to-latest chip (`ChatSurface-live-chip-2233.test.tsx`), not by pinning a
 * second copy of the reply to the viewport.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import { ChatTranscript, type ChatTranscriptLiveTurn } from '@/components/worktree/ChatTranscript';
import {
  CHAT_BUBBLE_ASSISTANT_CLASS,
  CHAT_BUBBLE_MARKDOWN_BODY_CLASS,
  CHAT_BUBBLE_MAX_WIDTH_ASSISTANT,
} from '@/components/worktree/ChatMessageBubble';
import {
  CHAT_FALLBACK_RENDER_COUNT,
  shouldShowLiveRoleHeader,
} from '@/lib/chat/chat-transcript-view';
import { installVirtualLayout } from '@tests/helpers/virtual-layout';

const WORKTREE_ID = 'wt-2233';
const SCROLL_CONTAINER = 'chat-transcript-scroll-container';

/** A turn key that marks the row as agent-authored Markdown (Issue #2041). */
const MD_REQUEST_ID = 'claude-turn:u-1';

function msg(
  id: string,
  role: ChatMessage['role'],
  content = `message body ${id}`,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content,
    timestamp: new Date(Date.UTC(2026, 8, 2, 10, 0, 0)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
    ...extra,
  };
}

function makeMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) =>
    msg(`m-${i}`, i % 2 === 0 ? 'user' : 'assistant', `message body ${i}`),
  );
}

const LIVE: ChatTranscriptLiveTurn = {
  turnKey: MD_REQUEST_ID,
  version: 3,
  body: 'The reply so far.',
  partial: false,
  isThinking: false,
};

function renderTranscript(
  messages: ChatMessage[],
  liveTurn: ChatTranscriptLiveTurn | null = LIVE,
  props: Record<string, unknown> = {},
) {
  return render(
    <ChatTranscript
      messages={messages}
      worktreeId={WORKTREE_ID}
      cliToolId="claude"
      liveTurn={liveTurn}
      onFilePathClick={vi.fn()}
      {...props}
    />,
  );
}

function liveRow(): HTMLElement {
  return screen.getByTestId('chat-live-turn');
}

/** The bubble box inside a live-turn row or a settled row. */
function bubbleIn(row: HTMLElement): HTMLElement {
  const bubble = row.querySelector<HTMLElement>('[class*="rounded-2xl"]');
  expect(bubble, 'row has a bubble').not.toBeNull();
  return bubble!;
}

function settledRow(messageId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-row-message-id="${messageId}"]`);
  expect(row, `row for ${messageId}`).not.toBeNull();
  return row!;
}

/**
 * Give the scroll container real, movable metrics.
 *
 * jsdom performs no layout, so `scrollTop` is a no-op property on a real
 * element; `installVirtualLayout` only teaches the virtualizer how tall things
 * are. This makes the offset the virtualizer reads on every `scroll` event
 * actually settable, which is what lets a test move the reader up and down.
 */
function stubScrollOffset(el: HTMLElement, totalHeight: number, viewport: number) {
  let top = 0;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => totalHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => viewport });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    },
  });
  return (to: number) => {
    el.scrollTop = to;
    fireEvent.scroll(el);
  };
}

// ---------------------------------------------------------------------------
// 1. Not a virtualized row — #2194's reason, preserved
// ---------------------------------------------------------------------------

describe('[#2233] the live bubble is outside the virtual list', () => {
  let restoreLayout: (() => void) | undefined;

  afterEach(() => {
    restoreLayout?.();
    restoreLayout = undefined;
  });

  function renderVirtualized(messageCount = 200) {
    restoreLayout = installVirtualLayout({
      scrollContainerTestId: SCROLL_CONTAINER,
      viewportHeight: 600,
      rowHeight: 100,
    });
    return renderTranscript(makeMessages(messageCount));
  }

  it('stays mounted while the rows at the tail are not', () => {
    // The mounted window is at the TOP (offset 0), so the last rows are
    // unmounted — which is precisely the state a live bubble rendered as row
    // `n-1` would not survive.
    renderVirtualized();

    expect(screen.queryByTestId('chat-transcript-fallback-list')).toBeNull();
    expect(screen.queryByText('message body 199')).toBeNull();
    expect(liveRow()).toBeInTheDocument();
    expect(liveRow().textContent).toContain('The reply so far.');
  });

  it('survives the reader scrolling to the end and back up', () => {
    renderVirtualized();
    const container = screen.getByTestId(SCROLL_CONTAINER);
    const scrollTo = stubScrollOffset(container, 1_000_000, 600);

    // Past the end on purpose: the virtualizer clamps its range to the last
    // index, so this is "the reader is at the bottom" without the test having to
    // predict a total height that `measureElement` keeps revising.
    scrollTo(1_000_000);
    expect(screen.getByText('message body 199')).toBeInTheDocument();
    expect(liveRow()).toBeInTheDocument();

    scrollTo(0);
    // The tail row is gone with the window; the live bubble is not.
    expect(screen.queryByText('message body 199')).toBeNull();
    expect(liveRow()).toBeInTheDocument();
  });

  it('is described by no virtual item at all', () => {
    // The structural half of the same property: `measureElement` wrappers carry
    // `data-index`, so a live bubble the virtualizer knows about would have one
    // as an ancestor. Asserted as "no ancestor", because a mutation that adds it
    // as an extra row would otherwise pass whenever the window happened to
    // include the end.
    renderVirtualized();

    expect(liveRow().closest('[data-index]')).toBeNull();
    const positioned = document.querySelectorAll('[data-index]');
    expect(positioned.length).toBeGreaterThan(0);
    for (const el of Array.from(positioned)) {
      expect(el.contains(liveRow())).toBe(false);
    }
  });

  it('sits inside the scroll region, not beside it', () => {
    // The other half of the move: a sibling of the scroll box is a footer strip
    // again, in a different place from the settled row that replaces it.
    renderVirtualized();
    expect(screen.getByTestId(SCROLL_CONTAINER).contains(liveRow())).toBe(true);
  });

  it('is the last thing in the scroll region', () => {
    renderVirtualized();
    const container = screen.getByTestId(SCROLL_CONTAINER);
    expect(container.lastElementChild).toBe(liveRow());
  });
});

// ---------------------------------------------------------------------------
// 2. The #1123 zero-measurement fallback path
// ---------------------------------------------------------------------------

describe('[#2233] the live bubble on the #1123 fallback path', () => {
  it('renders in plain flow when the virtualizer measured nothing', () => {
    // jsdom reports a 0px viewport, so `virtualItems` is empty and the
    // transcript falls back to a bounded slice. A live bubble wired only into
    // the virtualized branch would be invisible here — and on the real first
    // paint, which reports 0px too.
    renderTranscript(makeMessages(5));

    expect(screen.getByTestId('chat-transcript-fallback-list')).toBeInTheDocument();
    expect(liveRow()).toBeInTheDocument();
  });

  it('follows the truncated slice rather than being truncated with it', () => {
    renderTranscript(makeMessages(CHAT_FALLBACK_RENDER_COUNT + 15));

    expect(document.querySelectorAll('[data-testid="chat-message-row"]')).toHaveLength(
      CHAT_FALLBACK_RENDER_COUNT,
    );
    expect(liveRow()).toBeInTheDocument();
    expect(screen.getByTestId(SCROLL_CONTAINER).lastElementChild).toBe(liveRow());
  });

  it('replaces the empty state when the very first turn is still running', () => {
    // "No messages yet" printed above a bubble that is visibly being written is
    // a contradiction the reader can see.
    renderTranscript([]);

    expect(screen.queryByTestId('chat-transcript-empty')).toBeNull();
    expect(liveRow()).toBeInTheDocument();
  });

  it('keeps the empty state when nothing is running', () => {
    renderTranscript([], null);

    expect(screen.getByTestId('chat-transcript-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-live-turn')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Same presentation as the settled row
// ---------------------------------------------------------------------------

describe('[#2233] the live bubble looks like the row that replaces it', () => {
  it('wears byte-identical bubble classes', () => {
    renderTranscript([msg('a1', 'assistant', 'settled reply', { requestId: MD_REQUEST_ID })]);

    const settled = bubbleIn(settledRow('a1'));
    const live = bubbleIn(liveRow());

    expect(live.className).toBe(settled.className);
    expect(live.className).toBe(CHAT_BUBBLE_ASSISTANT_CLASS);
    // By literal value too: a comparison against the constant the markup came
    // from stays green when the constant itself is emptied.
    expect(live.className).toContain('text-sm');
    expect(live.className).toContain('rounded-2xl');
    expect(live.className).toContain(CHAT_BUBBLE_MAX_WIDTH_ASSISTANT);
    expect(CHAT_BUBBLE_MAX_WIDTH_ASSISTANT).toBe('max-w-[92%]');
  });

  it('wears byte-identical body classes, `.chat-md` included', () => {
    renderTranscript([msg('a1', 'assistant', 'settled reply', { requestId: MD_REQUEST_ID })]);

    const settledBody = settledRow('a1').querySelector('[data-message-id="a1"]') as HTMLElement;
    const liveBody = screen.getByTestId('chat-live-turn-body');

    expect(liveBody.className).toBe(settledBody.className);
    expect(liveBody.className).toBe(CHAT_BUBBLE_MARKDOWN_BODY_CLASS);
    expect(liveBody.className).toContain('chat-md');
  });

  it('leaves no `.assistant-md` on the chat surface at all', () => {
    // The last consumer on this surface was #2199's footer body. `.assistant-md`
    // is History's and `/chat`'s; a live bubble reaching back into it would
    // restyle two surfaces this Issue must not touch.
    renderTranscript([msg('a1', 'assistant', '**bold**', { requestId: MD_REQUEST_ID })]);
    expect(document.body.innerHTML).not.toContain('assistant-md');
  });

  it('renders the body as Markdown, the way the settled row will', () => {
    renderTranscript(makeMessages(2), { ...LIVE, body: '## A heading\n\n- one\n- two' });

    const body = screen.getByTestId('chat-live-turn-body');
    expect(body.querySelector('h2')?.textContent).toBe('A heading');
    expect(body.querySelectorAll('li')).toHaveLength(2);
  });

  it('is not clamped to a fixed height', () => {
    // #2199 capped the footer body at `max-h-[7.5rem]` and scrolled it, because
    // an unbounded box there would have eaten the transcript. Inside the
    // transcript there is nothing to eat: the reply is the content.
    renderTranscript(makeMessages(2));

    expect(liveRow().innerHTML).not.toContain('max-h-[');
    expect(liveRow().innerHTML).not.toContain('overflow-y-auto');
  });

  it('carries the header the settled row is about to carry', () => {
    // Same predicate, same `previous` — so the "Assistant" label does not blink
    // into or out of existence at the moment the turn settles.
    renderTranscript([msg('u1', 'user')]);
    expect(liveRow().textContent).toContain('worktree.conversation.assistant');

    expect(shouldShowLiveRoleHeader(undefined)).toBe(true);
    expect(shouldShowLiveRoleHeader(msg('u1', 'user'))).toBe(true);
    expect(shouldShowLiveRoleHeader(msg('a1', 'assistant'))).toBe(false);
  });

  it('omits the header when it continues an assistant run', () => {
    renderTranscript([msg('a1', 'assistant')]);
    expect(liveRow().textContent).not.toContain('worktree.conversation.assistant');
  });
});

// ---------------------------------------------------------------------------
// 4. The indicator, the partial badge, and the tools with no body at all
// ---------------------------------------------------------------------------

describe('[#2233] what the live bubble says about itself', () => {
  it('publishes the turn key and version it was handed', () => {
    renderTranscript(makeMessages(2));

    expect(liveRow()).toHaveAttribute('data-turn-key', MD_REQUEST_ID);
    expect(liveRow()).toHaveAttribute('data-version', '3');
  });

  it('shows the indicator under the body, not over it', () => {
    // Over it, the indicator's disappearance at settle-time pulls the whole
    // reply up by a line — the exact jump this Issue exists to remove.
    renderTranscript(makeMessages(2));

    const bubble = bubbleIn(liveRow());
    const children = Array.from(bubble.children);
    expect(children.indexOf(screen.getByTestId('chat-live-turn-body'))).toBeLessThan(
      children.indexOf(screen.getByTestId('chat-live-turn-indicator')),
    );
  });

  it('says the body starts mid-turn when it does', () => {
    renderTranscript(makeMessages(2), { ...LIVE, partial: true });
    expect(screen.getByTestId('chat-live-turn-partial')).toBeInTheDocument();
  });

  it('says nothing of the sort when the body is whole', () => {
    renderTranscript(makeMessages(2), { ...LIVE, partial: false });
    expect(screen.queryByTestId('chat-live-turn-partial')).toBeNull();
  });

  it('draws the indicator alone for a tool that publishes no body', () => {
    // codex / antigravity / vibe-local. The bubble is the same bubble in the
    // same place, so the body simply appearing later moves nothing.
    renderTranscript(makeMessages(2), { isThinking: false });

    expect(liveRow()).toHaveAttribute('data-has-body', 'false');
    expect(screen.queryByTestId('chat-live-turn-body')).toBeNull();
    expect(screen.getByTestId('chat-live-turn-indicator').textContent).toContain(
      'worktree.chatSurface.generating',
    );
  });

  it('treats an empty body as no body', () => {
    renderTranscript(makeMessages(2), { ...LIVE, body: '' });
    expect(screen.queryByTestId('chat-live-turn-body')).toBeNull();
  });

  it('switches the wording when the CLI reports thinking', () => {
    renderTranscript(makeMessages(2), { ...LIVE, isThinking: true });
    expect(screen.getByTestId('chat-live-turn-indicator').textContent).toContain(
      'worktree.chatSurface.thinking',
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Theme
// ---------------------------------------------------------------------------

describe('[#2233] the live bubble follows the theme', () => {
  it('writes no raw palette colour of its own', () => {
    // docs/design-system.md: the terminal is the dark island, a transcript is
    // not. A light-on-dark literal here would be unreadable in one of the two
    // themes, and this bubble is on screen for the whole of every turn.
    renderTranscript(makeMessages(2), { ...LIVE, partial: true });

    expect(liveRow().outerHTML).not.toMatch(
      /(bg|text|border|ring)-(gray|slate|zinc|neutral|stone|red|green|yellow|amber|orange|purple|violet|sky|blue)-[0-9]/,
    );
  });
});
