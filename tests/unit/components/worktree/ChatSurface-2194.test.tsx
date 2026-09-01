/**
 * ChatSurface — the chat output surface as a place you can work (Issue #2194).
 *
 * Four properties are load-bearing here, and each of them has a specific way of
 * quietly regressing:
 *
 *  1. **The banner's gate.** It exists for the frames chat cannot drive at all
 *     (selection list / pager / unreadable frame / a wait nobody could parse).
 *     Drop one flag from the condition and the surface silently becomes a dead
 *     end for that state — which is why every flag is exercised ALONE below, and
 *     why removing `isPagerActive` from `resolveBlockedReason` has to turn one of
 *     these red (Issue #2194's mutation-injection criterion).
 *  2. **No duplicated waiting indicator.** `ConversationPairCard` already draws a
 *     pending indicator inside the newest card when its pair has no reply yet, so
 *     a standalone "responding" row on top of it is the same fact twice.
 *  3. **No duplicated prompt UI.** An answerable wait is answered by the
 *     composer's own `PromptPanel` / `MobilePromptSheet`, which #2193 left
 *     rendering in chat mode. This surface must add nothing for that case — not
 *     even a banner.
 *  4. **Follow-the-tail.** Following on the MESSAGE count rather than the pair
 *     count is deliberate: an assistant reply joining the existing last pair grows
 *     the card without adding a row, so `HistoryPane`'s own pair-count follow
 *     (#1123) does not fire for the single most common arrival on this surface.
 *
 * `HistoryPane` is stubbed with a scroll container carrying the real testid. The
 * stub is what makes the scroll metrics controllable in a layout-less DOM; that
 * the selector still matches the REAL pane is pinned separately in
 * `ChatSurface-history-seam-2194.test.tsx`, because a stub cannot prove a seam.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ChatMessage, PromptData } from '@/types/models';
import { UNCLASSIFIED_PROMPT_TYPE } from '@/types/models';
import type { StructuredPromptWaitingData } from '@/lib/session/structured-prompt';

vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: ({ messages }: { messages: Array<{ id: string }> }) => (
    <div data-testid="history-pane" data-message-count={String(messages.length)}>
      {/* Same testid the real pane puts on its scroll region — ChatSurface finds
          the element to follow through exactly this selector. */}
      <div data-testid="history-scroll-container">
        {messages.map((m) => (
          <div key={m.id} data-message-id={m.id} />
        ))}
      </div>
    </div>
  ),
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
}));

import {
  ChatSurface,
  dedupeById,
  isAwaitingReply,
  resolveBlockedReason,
  type ChatSurfaceLiveState,
} from '@/components/worktree/ChatSurface';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKTREE_ID = 'wt-2194';
const T0 = new Date('2026-09-01T10:00:00Z');

function msg(
  id: string,
  role: ChatMessage['role'],
  offsetMs = 0,
  content = `content-${id}`,
): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content,
    timestamp: new Date(T0.getTime() + offsetMs),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
  };
}

const ANSWERABLE_PROMPT: PromptData = {
  type: 'yes_no',
  status: 'pending',
  question: 'Proceed?',
  options: ['yes', 'no'],
};

/**
 * #1725's degraded live payload: a wait IS on screen and its options were never
 * in the payload, so nothing on the composer side can render buttons for it.
 * This is the shape `prompt.data` actually carries for the unreadable case —
 * `promptData: null` is the older/rarer one, covered separately below.
 */
const UNREADABLE_PROMPT: StructuredPromptWaitingData = {
  type: UNCLASSIFIED_PROMPT_TYPE,
  status: 'pending',
  question: 'A dialog is waiting; read it in the terminal.',
  options: [],
  source: 'notification',
};

const IDLE: ChatSurfaceLiveState = {
  isRunning: false,
  isThinking: false,
  isPromptWaiting: false,
  promptData: null,
  isSelectionListActive: false,
  isPagerActive: false,
  isUnclassifiedActive: false,
};

function renderSurface(
  live: Partial<ChatSurfaceLiveState> = {},
  messages: ChatMessage[] = [msg('u1', 'user'), msg('a1', 'assistant', 1000)],
  onSurfaceModeChange = vi.fn(),
) {
  const result = render(
    <ChatSurface
      messages={messages}
      worktreeId={WORKTREE_ID}
      cliToolId="claude"
      instanceId="claude-2"
      live={{ ...IDLE, ...live }}
      onSurfaceModeChange={onSurfaceModeChange}
    />,
  );
  return { ...result, onSurfaceModeChange };
}

/**
 * Give one element deterministic scroll metrics.
 *
 * jsdom performs no layout, so `scrollHeight` / `clientHeight` are permanently 0
 * and `scrollTop` is not honoured by an element with no box. Backing all three
 * with real storage is what lets the pinned / scrolled-up distinction be stated
 * at all here.
 */
function stubScroll(
  el: HTMLElement,
  { scrollHeight, clientHeight, scrollTop }: { scrollHeight: number; clientHeight: number; scrollTop: number },
): { get scrollTop(): number } {
  let top = scrollTop;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    },
  });
  return {
    get scrollTop() {
      return top;
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('[#2194] ChatSurface helpers', () => {
  describe('dedupeById', () => {
    it('returns the very same array when there is nothing to collapse', () => {
      // Identity matters: a fresh array on every poll re-renders the memoized
      // HistoryPane (and re-runs its virtualizer) for no reason.
      const input = [msg('a', 'user'), msg('b', 'assistant', 1)];
      expect(dedupeById(input)).toBe(input);
    });

    it('keeps the first position and the last value for a repeated id', () => {
      const first = msg('dup', 'user', 0, 'optimistic');
      const later = msg('dup', 'user', 5, 'confirmed');
      const out = dedupeById([first, msg('other', 'assistant', 1), later]);
      expect(out.map((m) => m.id)).toEqual(['dup', 'other']);
      expect(out[0].content).toBe('confirmed');
    });
  });

  describe('isAwaitingReply', () => {
    it('is true when the newest turn is a user message', () => {
      expect(isAwaitingReply([msg('a', 'assistant'), msg('u', 'user', 1)])).toBe(true);
    });

    it('is false once an assistant reply follows it', () => {
      expect(isAwaitingReply([msg('u', 'user'), msg('a', 'assistant', 1)])).toBe(false);
    });

    it('is false for an empty transcript', () => {
      expect(isAwaitingReply([])).toBe(false);
    });

    it('is true for a lone user turn (the optimistic bubble case)', () => {
      expect(isAwaitingReply([msg('u', 'user')])).toBe(true);
    });
  });

  describe('resolveBlockedReason', () => {
    it('prefers the pager wording when a frame raises both flags', () => {
      // isPagerActive ⊂ isSelectionListActive server-side, so a pager frame
      // raises both and "you are in a pager" is the more actionable sentence.
      expect(
        resolveBlockedReason({ ...IDLE, isPagerActive: true, isSelectionListActive: true }),
      ).toBe('pager');
    });
  });
});

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

describe('[#2194] ChatSurface "open the terminal" banner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stays hidden while every flag is false', () => {
    renderSurface();
    expect(screen.queryByTestId('chat-surface-terminal-banner')).not.toBeInTheDocument();
  });

  it('shows for a selection list alone', () => {
    renderSurface({ isSelectionListActive: true });
    expect(screen.getByTestId('chat-surface-terminal-banner')).toHaveAttribute(
      'data-reason',
      'selectionList',
    );
  });

  it('shows for a pager alone', () => {
    // Mutation-injection target (Issue #2194): drop `isPagerActive` from
    // `resolveBlockedReason` and this is the test that must go red.
    renderSurface({ isPagerActive: true });
    expect(screen.getByTestId('chat-surface-terminal-banner')).toHaveAttribute(
      'data-reason',
      'pager',
    );
  });

  it('shows for an unclassified frame alone', () => {
    renderSurface({ isUnclassifiedActive: true });
    expect(screen.getByTestId('chat-surface-terminal-banner')).toHaveAttribute(
      'data-reason',
      'unclassified',
    );
  });

  it('shows for a wait whose payload nobody could parse', () => {
    renderSurface({ isPromptWaiting: true, promptData: UNREADABLE_PROMPT });
    expect(screen.getByTestId('chat-surface-terminal-banner')).toHaveAttribute(
      'data-reason',
      'promptUnreadable',
    );
  });

  it('shows for a wait that arrived with no payload at all', () => {
    renderSurface({ isPromptWaiting: true, promptData: null });
    expect(screen.getByTestId('chat-surface-terminal-banner')).toHaveAttribute(
      'data-reason',
      'promptUnreadable',
    );
  });

  it('stays hidden for an ANSWERABLE wait — the composer already has that', () => {
    // `PromptPanel` (PC) / `MobilePromptSheet` (phone) are still rendered in chat
    // mode by #2193. A banner here would send the user to the terminal for a
    // dialog they can answer where they are.
    renderSurface({ isPromptWaiting: true, promptData: ANSWERABLE_PROMPT });
    expect(screen.queryByTestId('chat-surface-terminal-banner')).not.toBeInTheDocument();
  });

  it('never renders a prompt panel of its own', () => {
    renderSurface({ isPromptWaiting: true, promptData: ANSWERABLE_PROMPT });
    expect(screen.queryByTestId('prompt-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mobile-prompt-sheet')).not.toBeInTheDocument();
  });

  it('gives the user exactly one button, and it switches the surface once', () => {
    const { onSurfaceModeChange } = renderSurface({ isSelectionListActive: true });
    const buttons = screen.getAllByTestId('chat-surface-open-terminal');
    expect(buttons).toHaveLength(1);

    fireEvent.click(buttons[0]);

    expect(onSurfaceModeChange).toHaveBeenCalledTimes(1);
    expect(onSurfaceModeChange).toHaveBeenCalledWith('terminal');
  });

  it('words each reason differently', () => {
    const seen = new Set<string>();
    for (const live of [
      { isPagerActive: true },
      { isSelectionListActive: true },
      { isUnclassifiedActive: true },
      { isPromptWaiting: true, promptData: null },
    ] as Partial<ChatSurfaceLiveState>[]) {
      const { unmount } = renderSurface(live);
      seen.add(screen.getByTestId('chat-surface-terminal-banner').textContent ?? '');
      unmount();
    }
    expect(seen.size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Generating indicator
// ---------------------------------------------------------------------------

describe('[#2194] ChatSurface generating indicator', () => {
  it('draws no standalone row while the newest turn is still pending', () => {
    // The pending pair's own indicator (ConversationPairCard) is already saying
    // this; a second line three pixels below it is noise.
    renderSurface({ isRunning: true }, [msg('a1', 'assistant'), msg('u1', 'user', 1000)]);
    expect(screen.queryByTestId('chat-surface-generating')).not.toBeInTheDocument();
  });

  it('draws the standalone row when there is no pending pair to hang it on', () => {
    renderSurface({ isRunning: true }, [msg('u1', 'user'), msg('a1', 'assistant', 1000)]);
    expect(screen.getByTestId('chat-surface-generating')).toBeInTheDocument();
  });

  it('draws the standalone row for a running session with no history yet', () => {
    renderSurface({ isRunning: true }, []);
    expect(screen.getByTestId('chat-surface-generating')).toBeInTheDocument();
  });

  it('draws nothing at all when the session is idle', () => {
    renderSurface({ isRunning: false }, [msg('u1', 'user')]);
    expect(screen.queryByTestId('chat-surface-generating')).not.toBeInTheDocument();
  });

  it('changes its wording when the CLI reports thinking', () => {
    const history = [msg('u1', 'user'), msg('a1', 'assistant', 1000)];
    const { unmount } = renderSurface({ isRunning: true, isThinking: false }, history);
    const running = screen.getByTestId('chat-surface-generating').textContent;
    unmount();

    renderSurface({ isRunning: true, isThinking: true }, history);
    expect(screen.getByTestId('chat-surface-generating').textContent).not.toBe(running);
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe('[#2194] ChatSurface empty state', () => {
  it('says a send will start the session when there is nothing yet', () => {
    renderSurface({}, []);
    expect(screen.getByTestId('chat-surface-empty-hint')).toBeInTheDocument();
  });

  it('says nothing once the session is running', () => {
    renderSurface({ isRunning: true }, []);
    expect(screen.queryByTestId('chat-surface-empty-hint')).not.toBeInTheDocument();
  });

  it('says nothing once there is history', () => {
    renderSurface({}, [msg('u1', 'user')]);
    expect(screen.queryByTestId('chat-surface-empty-hint')).not.toBeInTheDocument();
  });

  it('renders no live region at all when there is nothing live to say', () => {
    // The region is `shrink-0`; on the phone every pixel it takes comes out of
    // the transcript (Issue #2106's budget), so an always-present empty strip is
    // a real cost.
    renderSurface({}, [msg('u1', 'user'), msg('a1', 'assistant', 1000)]);
    expect(screen.queryByTestId('chat-surface-live')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Optimistic rows
// ---------------------------------------------------------------------------

describe('[#2194] ChatSurface optimistic rows', () => {
  it('does not grow the transcript when the same id arrives again', () => {
    const optimistic = msg('same-id', 'user', 0, 'hello');
    const { rerender } = renderSurface({}, [optimistic]);
    expect(screen.getByTestId('history-pane').getAttribute('data-message-count')).toBe('1');

    // The confirmed row carries the same id (#2195's `upsertMessage` matches on
    // it), so the pane must still be handed exactly one row.
    rerender(
      <ChatSurface
        messages={[optimistic, { ...optimistic, content: 'hello (confirmed)' }]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        live={IDLE}
        onSurfaceModeChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('history-pane').getAttribute('data-message-count')).toBe('1');
    expect(document.querySelectorAll('[data-message-id="same-id"]')).toHaveLength(1);
  });

  it('keeps a pending user row out of the standalone generating row', () => {
    // The optimistic bubble IS the newest turn, so it makes the pair pending and
    // `ConversationPairCard` owns the indicator from that moment on.
    renderSurface({ isRunning: true }, [msg('pending-0', 'user', 5000)]);
    expect(screen.queryByTestId('chat-surface-generating')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Follow the tail
// ---------------------------------------------------------------------------

describe('[#2194] ChatSurface follow-the-tail', () => {
  function renderForScroll(metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
    const initial = [msg('u1', 'user'), msg('a1', 'assistant', 1000)];
    const view = render(
      <ChatSurface
        messages={initial}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        live={IDLE}
        onSurfaceModeChange={vi.fn()}
      />,
    );
    const container = screen.getByTestId('history-scroll-container');
    const scroll = stubScroll(container, metrics);
    // Publish the stubbed metrics through the same event the component listens
    // to, so its pinned/unpinned state is derived rather than assumed.
    fireEvent.scroll(container);

    const append = (extra: ChatMessage[]) =>
      view.rerender(
        <ChatSurface
          messages={[...initial, ...extra]}
          worktreeId={WORKTREE_ID}
          cliToolId="claude"
          live={IDLE}
          onSurfaceModeChange={vi.fn()}
        />,
      );

    return { ...view, container, scroll, append };
  }

  it('follows to the end while the reader is already at the end', () => {
    const { scroll, append } = renderForScroll({ scrollHeight: 1000, clientHeight: 200, scrollTop: 800 });

    append([msg('a2', 'assistant', 2000)]);

    expect(scroll.scrollTop).toBe(1000);
    expect(screen.queryByTestId('chat-surface-new-messages')).not.toBeInTheDocument();
  });

  it('does not move the view while the reader has scrolled up, and offers a chip instead', () => {
    const { scroll, append } = renderForScroll({ scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });

    append([msg('a2', 'assistant', 2000)]);

    expect(scroll.scrollTop).toBe(0);
    expect(screen.getByTestId('chat-surface-new-messages')).toBeInTheDocument();
  });

  it('jumps to the end and clears the chip when it is pressed', () => {
    const { scroll, append } = renderForScroll({ scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    append([msg('a2', 'assistant', 2000)]);

    fireEvent.click(screen.getByTestId('chat-surface-new-messages'));

    expect(scroll.scrollTop).toBe(1000);
    expect(screen.queryByTestId('chat-surface-new-messages')).not.toBeInTheDocument();
  });

  it('clears the chip when the reader scrolls back down themselves', () => {
    const { container, append } = renderForScroll({
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 0,
    });
    append([msg('a2', 'assistant', 2000)]);
    expect(screen.getByTestId('chat-surface-new-messages')).toBeInTheDocument();

    // The stub's setter is the same storage the getter reads, so moving the
    // element and re-publishing is exactly what a real scroll does.
    container.scrollTop = 800;
    fireEvent.scroll(container);

    expect(screen.queryByTestId('chat-surface-new-messages')).not.toBeInTheDocument();
  });

  it('does not flag the first render as new arrivals', () => {
    // Opening a worktree with 200 messages of history is not "new output"; the
    // baseline render must scroll nothing and flag nothing.
    render(
      <ChatSurface
        messages={[msg('u1', 'user'), msg('a1', 'assistant', 1000)]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        live={IDLE}
        onSurfaceModeChange={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('chat-surface-new-messages')).not.toBeInTheDocument();
  });

  it('survives a pane that exposes no scroll container', () => {
    // The mobile tab mounts this before the pane has any layout, and both
    // surfaces mock the pane in their own suites. A missing container is a
    // no-follow, never a crash.
    const view = render(
      <ChatSurface
        messages={[msg('u1', 'user')]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        live={IDLE}
        onSurfaceModeChange={vi.fn()}
      />,
    );
    const container = screen.getByTestId('history-scroll-container');
    container.remove();
    expect(() =>
      view.rerender(
        <ChatSurface
          messages={[msg('u1', 'user'), msg('a1', 'assistant', 1000)]}
          worktreeId={WORKTREE_ID}
          cliToolId="claude"
          live={IDLE}
          onSurfaceModeChange={vi.fn()}
        />,
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe('[#2194] ChatSurface structure', () => {
  it('keeps the live region OUTSIDE the transcript, as a shrink-0 sibling', () => {
    // A "responding" row placed inside the virtual list is unmounted the moment
    // the reader scrolls away from the end — exactly when they most need it.
    renderSurface({ isRunning: true }, [msg('u1', 'user'), msg('a1', 'assistant', 1000)]);
    const live = screen.getByTestId('chat-surface-live');
    expect(live.className).toContain('shrink-0');
    expect(screen.getByTestId('history-pane').contains(live)).toBe(false);
  });

  it('names the instance it is showing', () => {
    renderSurface();
    expect(screen.getByTestId('chat-surface')).toHaveAttribute('data-instance-id', 'claude-2');
  });

  it('writes no raw palette colour into the shared surface', () => {
    // The transcript follows the theme (the terminal is the dark island, not
    // this). A light-on-dark literal here would be invisible in one of the two.
    renderSurface({ isSelectionListActive: true, isRunning: true }, []);
    const html = screen.getByTestId('chat-surface').outerHTML;
    expect(html).not.toMatch(/(bg|text|border|ring)-(gray|slate|zinc|neutral|stone|red|green|yellow|amber|orange|purple|violet|sky|blue)-[0-9]/);
  });

  it('keeps the chip reachable on touch (no hover-only reveal)', () => {
    const view = render(
      <ChatSurface
        messages={[msg('u1', 'user')]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        live={IDLE}
        onSurfaceModeChange={vi.fn()}
      />,
    );
    const container = screen.getByTestId('history-scroll-container');
    stubScroll(container, { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    fireEvent.scroll(container);
    view.rerender(
      <ChatSurface
        messages={[msg('u1', 'user'), msg('a1', 'assistant', 1000)]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        live={IDLE}
        onSurfaceModeChange={vi.fn()}
      />,
    );
    const chip = screen.getByTestId('chat-surface-new-messages');
    // It is shown/hidden by state, not by `group-hover:opacity-100` — a
    // hover-reveal here would be permanently invisible on a phone, which is the
    // screen this chip matters most on.
    expect(chip.className).not.toContain('opacity-0');
    expect(chip.className).toContain('touch-manipulation');
  });
});
