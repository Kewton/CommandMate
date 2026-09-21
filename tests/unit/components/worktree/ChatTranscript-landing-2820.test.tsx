/**
 * Landing on the head of the latest reply (Issue #2820).
 *
 * A reply row is drawn answer first, then Thinking, then Tool calls. With the
 * tool-activity toggle on, one codex turn measured 2,508px against a 728px
 * viewport, and the transcript held the BOTTOM of that row (#2283's tail
 * anchor), so the answer sat 2,500px above the reader. The anchor now aims at
 * `resolveChatLandingTarget`: the head of the latest reply, or the end of the
 * last row when the newest thing is not a reply or a turn is live.
 *
 * ## The fixture
 *
 * `ChatTranscript-tail-anchor-2283.test.tsx` explains the three layout stubs
 * jsdom needs (`offsetHeight`, `scrollHeight` / `clientHeight`, `scrollTop`).
 * This file differs in one way: a row's height depends on WHICH row it is and
 * on whether its tool log is open, because "taller than the viewport" is the
 * whole question. And jsdom's `ResizeObserver` stub never fires, so a recording
 * one is installed: like a browser's, it reports every element once when it
 * starts observing it (the virtualizer skips its own mount-time measurement
 * while a scroll is in progress, so a row appended mid-scroll is measured by
 * this report alone), and the toggle test fires it again by hand for the size
 * change a browser would report in the same frame.
 *
 * @vitest-environment jsdom
 */

import React, { useLayoutEffect, useRef } from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import { separateTurnBody } from '@/lib/hooks/sources/turn-body';
import { CHAT_TOOL_ACTIVITY_STORAGE_KEY } from '@/lib/chat/chat-tool-activity';
import { CHAT_TOOL_LOG_BODY_TESTID } from '@/components/worktree/ChatMessageBubble';

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

const { ChatTranscript, resolveChatLandingTarget } = await import(
  '@/components/worktree/ChatTranscript'
);

const WORKTREE_ID = 'wt-2820';
const SCROLL_CONTAINER_TESTID = 'chat-transcript-scroll-container';
const FAB_TESTID = 'chat-transcript-jump-fab';
const TOOL_TOGGLE_TESTID = 'chat-transcript-tool-activity-toggle';
const VIEWPORT_HEIGHT = 600;
const ROW_HEIGHT = 100;

/** The latest reply: 300px folded (fits), 3,000px with its tool log open. */
const REPLY_ID = 'reply';
/** A reply whose ANSWER alone is taller than the viewport. */
const LONG_REPLY_ID = 'long-reply';
const HEIGHTS: Record<string, { folded: number; open: number }> = {
  [REPLY_ID]: { folded: 300, open: 3000 },
  [LONG_REPLY_ID]: { folded: 3000, open: 3000 },
};

const REPLY_BODY = separateTurnBody([
  { kind: 'prose', text: 'The answer the reader came back for.' },
  { kind: 'tool', text: '- `Bash` — ls' },
  { kind: 'tool', text: '- `apply_patch` — probe.txt' },
]).body;

function message(id: string, role: ChatMessage['role'], extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content: `content ${id}`,
    timestamp: new Date(Date.UTC(2026, 8, 21, 10, 0, 0)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'codex',
    requestId: role === 'user' ? `codex-prompt:${id}` : `codex-turn:${id}`,
    ...extra,
  };
}

function reply(id: string, content = REPLY_BODY): ChatMessage {
  return message(id, 'assistant', { content });
}

/** 20 short turns — 40 rows — ahead of whatever the test appends. */
function history(): ChatMessage[] {
  return Array.from({ length: 20 }, (_, i) => [
    message(`u-${i}`, 'user'),
    message(`a-${i}`, 'assistant'),
  ]).flat();
}

/** History, the question, and the latest reply at row 41. */
function withReply(id = REPLY_ID): ChatMessage[] {
  return [...history(), message('q', 'user'), reply(id)];
}

// ---------------------------------------------------------------------------
// Layout stubs
// ---------------------------------------------------------------------------

const scrollTops = new WeakMap<HTMLElement, number>();

function isContainer(el: HTMLElement): boolean {
  return el.getAttribute('data-testid') === SCROLL_CONTAINER_TESTID;
}

/** A measured row wrapper's height: by message id, and by the open tool log. */
function rowHeight(el: HTMLElement): number {
  for (const [id, height] of Object.entries(HEIGHTS)) {
    if (el.querySelector(`[data-row-message-id="${id}"]`)) {
      return el.querySelector(`[data-testid="${CHAT_TOOL_LOG_BODY_TESTID}"]`)
        ? height.open
        : height.folded;
    }
  }
  return ROW_HEIGHT;
}

function installLayout(): () => void {
  const proto = HTMLElement.prototype;
  const keys = ['offsetHeight', 'offsetWidth', 'scrollHeight', 'clientHeight', 'scrollTop'] as const;
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const);

  Object.defineProperty(proto, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (isContainer(this)) return VIEWPORT_HEIGHT;
      return this.hasAttribute('data-index') ? rowHeight(this) : 0;
    },
  });
  Object.defineProperty(proto, 'offsetWidth', { configurable: true, get: () => 800 });
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
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(proto, key, descriptor);
      else Reflect.deleteProperty(proto, key);
    }
  };
}

/**
 * A ResizeObserver that reports each element once on the next frame after it
 * starts observing it, as a browser does, and again on {@link fireResize}.
 */
const observers = new Set<RecordingResizeObserver>();
class RecordingResizeObserver {
  private readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    observers.add(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
    requestAnimationFrame(() => {
      if (!this.targets.has(target)) return;
      this.callback([{ target } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    });
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
    observers.delete(this);
  }
  fire(): void {
    const entries = Array.from(this.targets, (target) => ({ target }) as unknown as ResizeObserverEntry);
    if (entries.length > 0) this.callback(entries, this as unknown as ResizeObserver);
  }
}

function fireResize(): void {
  for (const observer of Array.from(observers)) observer.fire();
}

function installResizeObserver(): () => void {
  const win = window as unknown as { ResizeObserver: unknown };
  const saved = win.ResizeObserver;
  win.ResizeObserver = RecordingResizeObserver;
  return () => {
    win.ResizeObserver = saved;
    observers.clear();
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function settle(frames = 16): Promise<void> {
  for (let i = 0; i < frames; i += 1) {
    await act(async () => {
      fireEvent.scroll(container());
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

/** Where the row carrying `id` starts, read off the virtualizer's own transform. */
function rowStart(id: string): number {
  const row = container().querySelector(`[data-row-message-id="${id}"]`)?.closest<HTMLElement>('[data-index]');
  if (!row) throw new Error(`row ${id} is not mounted`);
  const match = /translateY\((-?[\d.]+)px\)/.exec(row.style.transform);
  if (!match) throw new Error(`row ${id} has no transform`);
  return Number(match[1]);
}

type LiveTurn = React.ComponentProps<typeof ChatTranscript>['liveTurn'];

function transcript(messages: ChatMessage[], liveTurn: LiveTurn = null) {
  return (
    <ChatTranscript
      messages={messages}
      worktreeId={WORKTREE_ID}
      cliToolId="codex"
      liveTurn={liveTurn}
      onFilePathClick={vi.fn()}
    />
  );
}

/**
 * `ChatSurface`'s own follow, reduced to the line that matters: when a message
 * is appended or the live turn comes or goes, it writes
 * `scrollTop = scrollHeight` in a layout effect — which runs AFTER the
 * transcript's own (children first), in the same commit as the transcript's aim.
 */
function WithSurfaceFollow({ messages, liveTurn }: { messages: ChatMessage[]; liveTurn: LiveTurn }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const isFirstRun = useRef(true);
  const hasLiveTurn = liveTurn !== null;
  useLayoutEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-testid="${SCROLL_CONTAINER_TESTID}"]`);
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, hasLiveTurn]);
  return <div ref={rootRef}>{transcript(messages, liveTurn)}</div>;
}

// ---------------------------------------------------------------------------
// resolveChatLandingTarget
// ---------------------------------------------------------------------------

describe('[#2820] resolveChatLandingTarget', () => {
  const row = (m: ChatMessage) => ({ kind: 'message', message: m });
  const approvals = { kind: 'approvals' };
  const scrape = message('scrape', 'assistant', { requestId: undefined });

  it('has no landing for an empty column', () => {
    expect(resolveChatLandingTarget([], false)).toBeNull();
  });

  it("lands on the latest reply's head", () => {
    const rows = [row(message('q', 'user')), row(reply('r'))];
    expect(resolveChatLandingTarget(rows, false)).toEqual({ index: 1, align: 'start' });
  });

  it('keeps the end of the last row while a turn is live', () => {
    const rows = [row(message('q', 'user')), row(reply('r'))];
    expect(resolveChatLandingTarget(rows, true)).toEqual({ index: 1, align: 'end' });
  });

  it('keeps the end when the newest row is the question, not the previous reply', () => {
    const rows = [row(reply('r')), row(message('q', 'user'))];
    expect(resolveChatLandingTarget(rows, false)).toEqual({ index: 1, align: 'end' });
  });

  it('walks past an approval run and a folded pane scrape to the reply', () => {
    const rows = [row(message('q', 'user')), approvals, row(reply('r')), row(scrape)];
    expect(resolveChatLandingTarget(rows, false)).toEqual({ index: 2, align: 'start' });
  });

  it('keeps the end when only approvals and scrapes follow the question', () => {
    const rows = [row(reply('r0')), row(message('q', 'user')), approvals, row(scrape)];
    expect(resolveChatLandingTarget(rows, false)).toEqual({ index: 3, align: 'end' });
  });

  it('keeps the end over the previous-session header alone', () => {
    expect(resolveChatLandingTarget([{ kind: 'previousSessionHeader' }], false)).toEqual({
      index: 0,
      align: 'end',
    });
  });

  it('treats a key-less row from a tool with no transcript reader as a reply', () => {
    // `isFoldedPaneScrape` is false for copilot / gemini / vibe-local: those
    // rows ARE the answers, so they are a landing like any other reply.
    const copilot = message('c', 'assistant', { cliToolId: 'copilot', requestId: undefined });
    expect(resolveChatLandingTarget([row(message('q', 'user')), row(copilot)], false)).toEqual({
      index: 1,
      align: 'start',
    });
  });
});

// ---------------------------------------------------------------------------
// ChatTranscript
// ---------------------------------------------------------------------------

describe('[#2820] ChatTranscript lands on the head of the latest reply', () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    cleanups.push(installLayout());
    cleanups.push(installResizeObserver());
  });

  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
    aims.length = 0;
    window.localStorage.clear();
  });

  function toolActivityOn(): void {
    window.localStorage.setItem(CHAT_TOOL_ACTIVITY_STORAGE_KEY, 'true');
  }

  it('opens on the head of a reply taller than the viewport', async () => {
    toolActivityOn();
    render(transcript(withReply()));
    await settle();

    expect(aims).toContainEqual({ index: 41, align: 'start' });
    expect(container().scrollTop).toBe(rowStart(REPLY_ID));
    expect(container().scrollTop).toBeLessThan(maxScrollOffset());
  });

  it('keeps the bottom for a reply that fits in the viewport', async () => {
    render(transcript(withReply()));
    await settle();

    expect(container().scrollTop).toBe(maxScrollOffset());
  });

  it('lands on the head of a long ANSWER with the toggle off as well', async () => {
    render(transcript(withReply(LONG_REPLY_ID)));
    await settle();

    expect(container().scrollTop).toBe(rowStart(LONG_REPLY_ID));
    expect(container().scrollTop).toBeLessThan(maxScrollOffset());
  });

  it('lands on the head when a new reply arrives while following', async () => {
    toolActivityOn();
    const view = render(transcript([...history(), message('q', 'user')]));
    await settle();
    expect(container().scrollTop).toBe(maxScrollOffset());

    view.rerender(transcript(withReply()));
    await settle();

    expect(container().scrollTop).toBe(rowStart(REPLY_ID));
  });

  it("wins over the surface's own scrollTop = scrollHeight in the same commit", async () => {
    toolActivityOn();
    const view = render(<WithSurfaceFollow messages={withReply()} liveTurn={{ isThinking: true }} />);
    await settle();
    expect(container().scrollTop).toBe(maxScrollOffset());
    // Let the virtualizer's scroll state go idle (150ms) so nothing of its own
    // is still reconciling: the surface's write is then the only thing between
    // the transcript's aim and the head.
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    });

    view.rerender(<WithSurfaceFollow messages={withReply()} liveTurn={null} />);
    await settle();

    expect(container().scrollTop).toBe(rowStart(REPLY_ID));
  });

  it('does not pull back a reader who scrolls away while the anchor is settling', async () => {
    // The off-landing check above is for the FIRST frame only. On a later frame
    // the only thing that moves the position off the landing is the reader.
    toolActivityOn();
    const view = render(transcript(withReply()));
    await settle();
    const scrape = message('scrape', 'assistant', { requestId: undefined });

    view.rerender(transcript([...withReply(), scrape]));
    await settle(2);
    scrollTops.set(container(), 0);
    await settle();

    expect(container().scrollTop).toBe(0);
    expect(fab()).toHaveAttribute('data-direction', 'latest');
  });

  it('moves to the head when the tool-activity toggle opens the row', async () => {
    render(transcript(withReply()));
    await settle();
    expect(container().scrollTop).toBe(maxScrollOffset());

    // Two acts: the size change can only be reported once the click has been
    // committed and the tool log is in the DOM.
    act(() => {
      fireEvent.click(screen.getByTestId(TOOL_TOGGLE_TESTID));
    });
    act(() => fireResize());
    await settle();

    expect(container().scrollTop).toBe(rowStart(REPLY_ID));
    expect(container().scrollTop).toBeLessThan(maxScrollOffset());
  });

  it('follows the bottom while a turn is live, and moves to the head once it ends', async () => {
    toolActivityOn();
    const view = render(transcript(withReply(), { isThinking: true }));
    await settle();
    expect(container().scrollTop).toBe(maxScrollOffset());

    view.rerender(transcript(withReply(), null));
    await settle();

    expect(container().scrollTop).toBe(rowStart(REPLY_ID));
  });

  it('offers the beginning, not the latest, while parked at the head', async () => {
    toolActivityOn();
    render(transcript(withReply()));
    await settle();

    expect(container().scrollTop).toBe(rowStart(REPLY_ID));
    expect(fab()).toHaveAttribute('data-direction', 'top');
  });

  it('follows the next row from the head', async () => {
    toolActivityOn();
    const view = render(transcript(withReply()));
    await settle();
    aims.length = 0;

    view.rerender(transcript([...withReply(), message('q2', 'user')]));
    await settle();

    expect(aims).toContainEqual({ index: 42, align: 'end' });
    expect(container().scrollTop).toBe(maxScrollOffset());
  });

  it('leaves a reader who scrolled up where they are, and brings them back with the FAB', async () => {
    toolActivityOn();
    const view = render(transcript(withReply(), { isThinking: true }));
    await settle();

    act(() => {
      scrollTops.set(container(), 0);
      fireEvent.scroll(container());
    });
    expect(fab()).toHaveAttribute('data-direction', 'latest');
    aims.length = 0;

    view.rerender(transcript(withReply(), null));
    await settle();
    expect(aims).toHaveLength(0);
    expect(container().scrollTop).toBe(0);

    fireEvent.click(fab() as HTMLElement);
    await settle();

    expect(aims).toContainEqual({ index: 41, align: 'start' });
    expect(container().scrollTop).toBe(rowStart(REPLY_ID));
    expect(fab()).toHaveAttribute('data-direction', 'top');
  });

  it('lands on the reply, not on a pane scrape under it', async () => {
    toolActivityOn();
    const scrape = message('scrape', 'assistant', { requestId: undefined });
    render(transcript([...withReply(), scrape]));
    await settle();

    expect(aims).toContainEqual({ index: 41, align: 'start' });
    expect(container().scrollTop).toBe(rowStart(REPLY_ID));
  });
});
