/**
 * What `ChatSurface` stopped doing when the transcript took over the tail
 * (Issue #2283).
 *
 * Two of this surface's three scroll writes were defects, and both were the
 * same shape: `scrollTop = scrollHeight` against a virtual list whose tail rows
 * have never been measured. That number is mostly the 120px-per-row ESTIMATE,
 * so the write lands short and every measurement that arrives afterwards leaves
 * it further behind — 7,770px, measured on the worktree the Issue was filed
 * against.
 *
 * ## (1) The mount-time write
 *
 * The in-flight-reply follow ran on mount too, because `isPinnedRef` starts
 * true. At that moment the DOM under it is either the #1123 plain-flow fallback
 * or an estimated-height sizer — a DOM about to be REPLACED by the virtual list
 * — and nothing re-aimed after the replacement. It is one half of why the
 * terminal → chat toggle landed near the top of a 208-row transcript, and it is
 * gone: the transcript's own tail anchor lands the first paint now.
 *
 * The half of the old behaviour that must NOT go with it is the rule that a
 * baseline render flags nothing: arriving at a full history is not new output.
 * That is `ChatSurface-2194.test.tsx`'s case, and it is asserted here too, with
 * the write itself observed rather than inferred.
 *
 * ## (2) The chip
 *
 * It survives — for a caller whose transcript publishes no scroll controls,
 * which is every suite in this directory that stubs `ChatTranscript`, and where
 * the scroll region's own height really is all there is to aim at. But when the
 * real transcript is mounted it is drawing a FAB that can land on the last ROW,
 * and offering the reader two ways back to the same place is worse than
 * offering one. So the chip is withdrawn the moment controls arrive, and this
 * file is where that hand-off is pinned from the surface's side.
 * `ChatTranscript-jump-fab-2283.test.tsx` pins the other side.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';

/**
 * Whether the stubbed transcript publishes scroll controls on mount — i.e.
 * whether it is standing in for the real component (which always does) or for
 * something that cannot jump through a virtualizer.
 */
const stub = { publishControls: false, latest: vi.fn(), top: vi.fn() };

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: ({
    messages,
    onScrollControlsChange,
  }: {
    messages: Array<{ id: string }>;
    onScrollControlsChange?: (
      controls: { scrollToLatest: () => void; scrollToTop: () => void } | null,
    ) => void;
  }) => {
    // The real component publishes from an effect and withdraws on unmount;
    // the stub does the same, so the surface sees the same lifecycle.
    React.useEffect(() => {
      if (!stub.publishControls || !onScrollControlsChange) return;
      onScrollControlsChange({ scrollToLatest: stub.latest, scrollToTop: stub.top });
      return () => onScrollControlsChange(null);
    }, [onScrollControlsChange]);
    return (
      <div data-testid="chat-transcript" data-message-count={String(messages.length)}>
        <div data-testid="chat-transcript-scroll-container">
          {messages.map((m) => (
            <div key={m.id} data-message-id={m.id} />
          ))}
        </div>
      </div>
    );
  },
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

import { ChatSurface, type ChatSurfaceLiveState } from '@/components/worktree/ChatSurface';

const WORKTREE_ID = 'wt-2283-surface';
const T0 = new Date('2026-09-03T10:00:00Z');
const IDLE: ChatSurfaceLiveState = { isRunning: false, sessionStatus: 'idle' };

function msg(id: string, role: ChatMessage['role'], offsetMs = 0): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content: `content-${id}`,
    timestamp: new Date(T0.getTime() + offsetMs),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
  };
}

const SCROLL_CONTAINER_TESTID = 'chat-transcript-scroll-container';

/**
 * Every write to the scroll region's `scrollTop`, recorded from BEFORE the
 * first render.
 *
 * The mount-time write this Issue removed happens inside a layout effect, so a
 * per-element stub installed after `render()` returns cannot see it — it would
 * make the assertion below pass whether the write exists or not. A
 * prototype-level accessor is installed first instead, which is also what gives
 * the element the metrics jsdom computes for nothing.
 */
const containerWrites: number[] = [];
const scrollTops = new WeakMap<HTMLElement, number>();

function installScrollRecorder(metrics: {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}): () => void {
  const proto = HTMLElement.prototype;
  const saved: Record<string, PropertyDescriptor | undefined> = {
    scrollHeight: Object.getOwnPropertyDescriptor(proto, 'scrollHeight'),
    clientHeight: Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
    scrollTop: Object.getOwnPropertyDescriptor(proto, 'scrollTop'),
  };
  const isContainer = (el: HTMLElement) =>
    el.getAttribute('data-testid') === SCROLL_CONTAINER_TESTID;

  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isContainer(this) ? metrics.scrollHeight : 0;
    },
  });
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isContainer(this) ? metrics.clientHeight : 0;
    },
  });
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      const stored = scrollTops.get(this);
      if (stored !== undefined) return stored;
      return isContainer(this) ? metrics.scrollTop : 0;
    },
    set(this: HTMLElement, value: number) {
      const next = Number(value) || 0;
      if (isContainer(this)) containerWrites.push(next);
      scrollTops.set(this, next);
    },
  });

  return () => {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(proto, key, descriptor);
      else Reflect.deleteProperty(proto, key);
    }
  };
}

/** Movable scroll metrics that also RECORD every write. */
function stubScroll(
  el: HTMLElement,
  { scrollHeight, clientHeight, scrollTop }: { scrollHeight: number; clientHeight: number; scrollTop: number },
): { get scrollTop(): number; get writes(): number[] } {
  let top = scrollTop;
  const writes: number[] = [];
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      writes.push(v);
      top = v;
    },
  });
  return {
    get scrollTop() {
      return top;
    },
    get writes() {
      return writes;
    },
  };
}

function surface(messages: ChatMessage[], live: ChatSurfaceLiveState = IDLE) {
  return (
    <ChatSurface
      messages={messages}
      worktreeId={WORKTREE_ID}
      cliToolId="claude"
      live={live}
      onSurfaceModeChange={vi.fn()}
    />
  );
}

function chip(): HTMLElement | null {
  return screen.queryByTestId('chat-surface-new-messages');
}

beforeEach(() => {
  stub.publishControls = false;
  stub.latest = vi.fn();
  stub.top = vi.fn();
});

describe('[#2283] ChatSurface writes no scroll position on mount', () => {
  let restoreRecorder: (() => void) | undefined;

  afterEach(() => {
    restoreRecorder?.();
    restoreRecorder = undefined;
    containerWrites.length = 0;
  });

  it('leaves scrollTop untouched by the baseline render', () => {
    // The reader is deliberately NOT at the end (1,200 of 4,000 with a 400px
    // viewport). `isPinnedRef` starts true regardless, which is why the old
    // mount-time follow fired here and moved a DOM that was about to be
    // replaced by the virtual list.
    restoreRecorder = installScrollRecorder({
      scrollHeight: 4000,
      clientHeight: 400,
      scrollTop: 1200,
    });

    render(surface([msg('u1', 'user'), msg('a1', 'assistant', 1000)]));

    expect(containerWrites).toEqual([]);
    expect(screen.getByTestId(SCROLL_CONTAINER_TESTID).scrollTop).toBe(1200);
  });

  it('writes nothing on a mount that has a live turn in flight already', () => {
    // The removed write lived on the in-flight-reply follow, whose deps are the
    // progress body and the live-turn flag — so a surface that mounts with a
    // turn already running is the state that fired it hardest.
    restoreRecorder = installScrollRecorder({
      scrollHeight: 4000,
      clientHeight: 400,
      scrollTop: 1200,
    });

    render(
      surface([msg('u1', 'user')], { isRunning: true, sessionStatus: 'running' }),
    );

    expect(containerWrites).toEqual([]);
  });

  it('still flags nothing on the baseline render', () => {
    // #2194's rule, unchanged: opening a worktree with a full history is not
    // new output.
    render(surface([msg('u1', 'user'), msg('a1', 'assistant', 1000)]));
    expect(chip()).toBeNull();
  });

  it('still follows an appended message for a reader at the end', () => {
    // The follow that SHOULD write is untouched; only the mount case went.
    const view = render(surface([msg('u1', 'user')]));
    const scroll = stubScroll(screen.getByTestId('chat-transcript-scroll-container'), {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 800,
    });
    fireEvent.scroll(screen.getByTestId('chat-transcript-scroll-container'));

    view.rerender(surface([msg('u1', 'user'), msg('a1', 'assistant', 1000)]));

    expect(scroll.scrollTop).toBe(1000);
  });
});

describe('[#2283] ChatSurface hands the way back to the transcript', () => {
  it('withdraws its chip once the transcript publishes scroll controls', () => {
    stub.publishControls = true;
    const view = render(surface([msg('u1', 'user')]));
    stubScroll(screen.getByTestId('chat-transcript-scroll-container'), {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 0,
    });
    fireEvent.scroll(screen.getByTestId('chat-transcript-scroll-container'));

    view.rerender(surface([msg('u1', 'user'), msg('a1', 'assistant', 1000)]));

    // The reader HAS something below them — the chip's own condition is met —
    // and the control they are offered is the transcript's FAB instead.
    expect(chip()).toBeNull();
  });

  it('keeps the chip for a transcript that publishes nothing', () => {
    // Not a fallback for its own sake: it is the only reachable way back when
    // the slot is filled by something with no virtualizer to ask.
    const view = render(surface([msg('u1', 'user')]));
    const scroll = stubScroll(screen.getByTestId('chat-transcript-scroll-container'), {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 0,
    });
    fireEvent.scroll(screen.getByTestId('chat-transcript-scroll-container'));

    view.rerender(surface([msg('u1', 'user'), msg('a1', 'assistant', 1000)]));
    expect(chip()).toBeInTheDocument();

    fireEvent.click(chip() as HTMLElement);
    expect(scroll.scrollTop).toBe(1000);
  });

  it('brings the chip back if the controls are withdrawn', () => {
    // Unmounting the transcript must not leave the surface with no way back at
    // all — the published controls are a live fact, not a one-way latch.
    stub.publishControls = true;
    const view = render(surface([msg('u1', 'user')]));
    stubScroll(screen.getByTestId('chat-transcript-scroll-container'), {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 0,
    });
    fireEvent.scroll(screen.getByTestId('chat-transcript-scroll-container'));
    view.rerender(surface([msg('u1', 'user'), msg('a1', 'assistant', 1000)]));
    expect(chip()).toBeNull();

    act(() => {
      stub.publishControls = false;
    });
    view.unmount();
    const remount = render(surface([msg('u1', 'user')]));
    stubScroll(screen.getByTestId('chat-transcript-scroll-container'), {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 0,
    });
    fireEvent.scroll(screen.getByTestId('chat-transcript-scroll-container'));
    remount.rerender(surface([msg('u1', 'user'), msg('a1', 'assistant', 1000)]));

    expect(chip()).toBeInTheDocument();
  });
});
