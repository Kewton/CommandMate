/**
 * Issue #3179 — the shared pieces of the starting display: the notice (and its
 * elapsed time past 5 s), the composer's stop / mode gate, the chat surface's
 * strip, and the shared "ターミナルを見る" reveal.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

vi.mock('@/lib/api-client', () => ({
  worktreeApi: {
    sendMessage: vi.fn().mockResolvedValue({}),
    uploadImageFile: vi.fn().mockResolvedValue({ path: '.commandmate/attachments/test.png' }),
  },
  handleApiError: vi.fn((err: Error) => err?.message || 'Unknown error'),
}));

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: vi.fn(() => ({ groups: [], isCatalogStale: false })),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}));

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: ({ liveTurn }: { liveTurn?: unknown }) => (
    <div data-testid="chat-transcript">
      <div data-testid="chat-transcript-scroll-container" />
      {liveTurn ? <div data-testid="chat-transcript-live-turn" /> : null}
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

vi.mock('@/hooks/useRealtimeConnection', () => ({
  useRealtime: () => ({
    status: 'connected',
    connected: true,
    subscribe: () => {},
    unsubscribe: () => {},
    addListener: () => () => {},
  }),
}));

import { SessionStartingNotice } from '@/components/worktree/SessionStartingNotice';
import { MessageInput } from '@/components/worktree/MessageInput';
import { ChatSurface, resolveBlockedReason } from '@/components/worktree/ChatSurface';
import {
  resetRevealedStartingTerminals,
  sessionStartingScopeKey,
  useSessionStartingGate,
} from '@/hooks/useSessionStartingGate';
import { formatElapsed } from '@/components/common/format-elapsed';
import { formatElapsed as formatElapsedFromPane } from '@/components/worktree/VerificationPane';

const T0 = Date.UTC(2026, 9, 4, 1, 0, 0);

beforeEach(() => {
  resetRevealedStartingTerminals();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('[#3179] SessionStartingNotice', () => {
  it('says "<agent> を起動中…" and adds the elapsed time only after 5 seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    render(<SessionStartingNotice cliToolId="antigravity" startingSince={T0} />);

    expect(screen.getByTestId('session-starting-title')).toHaveTextContent('Antigravity を起動中…');
    expect(screen.getByTestId('session-starting-title').textContent).not.toMatch(/\ds/);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    // Exactly 5 s is not "over" 5 s.
    expect(screen.getByTestId('session-starting-title').textContent).toBe('Antigravity を起動中…');

    act(() => {
      vi.advanceTimersByTime(7_000);
    });
    expect(screen.getByTestId('session-starting-title')).toHaveTextContent('Antigravity を起動中… 12s');

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId('session-starting-title')).toHaveTextContent('Antigravity を起動中… 1m 12s');
  });

  it('names the tool it is starting', () => {
    render(<SessionStartingNotice cliToolId="claude" startingSince={Date.now()} />);
    expect(screen.getByTestId('session-starting-title')).toHaveTextContent('Claude を起動中…');
  });

  it('"ターミナルを見る" calls back, and is not drawn without a callback', () => {
    const onShow = vi.fn();
    const { rerender } = render(
      <SessionStartingNotice cliToolId="codex" startingSince={Date.now()} onShowTerminal={onShow} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /ターミナルを見る/ }));
    expect(onShow).toHaveBeenCalledTimes(1);

    rerender(<SessionStartingNotice cliToolId="codex" startingSince={Date.now()} />);
    expect(screen.queryByTestId('session-starting-show-terminal')).toBeNull();
  });

  it('never prints a negative time when the browser clock is behind the server', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    render(<SessionStartingNotice cliToolId="gemini" startingSince={T0 + 30_000} />);
    expect(screen.getByTestId('session-starting-title').textContent).toBe('Gemini を起動中…');
  });
});

describe('[#3179] formatElapsed is shared with the verification pane', () => {
  it('is the same function under both names', () => {
    expect(formatElapsedFromPane).toBe(formatElapsed);
    expect(formatElapsed(12_400)).toBe('12s');
    expect(formatElapsed(185_000)).toBe('3m 05s');
  });
});

describe('[#3179] MessageInput while the agent is launching', () => {
  const modeSlot = <div data-testid="fake-agent-mode">mode</div>;

  it('keeps the stop button disabled and drops the mode control', () => {
    render(
      <MessageInput
        worktreeId="wt-3179"
        cliToolId="claude"
        isSessionRunning
        isSessionStarting
        agentModeSlot={modeSlot}
      />,
    );
    expect(screen.getByTestId('interrupt-button')).toBeDisabled();
    expect(screen.queryByTestId('fake-agent-mode')).toBeNull();
  });

  it('enables both once the launch is over', () => {
    render(
      <MessageInput worktreeId="wt-3179" cliToolId="claude" isSessionRunning agentModeSlot={modeSlot} />,
    );
    expect(screen.getByTestId('interrupt-button')).not.toBeDisabled();
    expect(screen.getByTestId('fake-agent-mode')).toBeInTheDocument();
  });
});

describe('[#3179] ChatSurface while the agent is launching', () => {
  it('resolveBlockedReason answers null whatever else is raised', () => {
    expect(
      resolveBlockedReason({
        startingSince: T0,
        isSelectionListActive: true,
        isPagerActive: true,
        isUnclassifiedActive: true,
        isPromptWaiting: true,
        promptData: null,
      }),
    ).toBeNull();
    expect(resolveBlockedReason({ startingSince: null, isUnclassifiedActive: true })).toBe('unclassified');
  });

  it('draws the starting strip, no dialog card and no "responding" bubble', () => {
    render(
      <ChatSurface
        messages={[]}
        worktreeId="wt-3179"
        cliToolId="antigravity"
        instanceId="antigravity"
        live={{ isRunning: true, sessionStatus: 'running', isUnclassifiedActive: true, startingSince: Date.now() }}
        onSurfaceModeChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('chat-surface-starting')).toHaveTextContent('Antigravity を起動中…');
    expect(screen.queryByTestId('chat-surface-live')).toBeNull();
    expect(screen.queryByTestId('chat-transcript-live-turn')).toBeNull();
  });

  it('its link switches to the terminal surface AND reveals the pane there', () => {
    const onSurfaceModeChange = vi.fn();
    const since = Date.now();
    render(
      <ChatSurface
        messages={[]}
        worktreeId="wt-3179"
        cliToolId="antigravity"
        instanceId="antigravity"
        live={{ isRunning: true, sessionStatus: 'running', startingSince: since }}
        onSurfaceModeChange={onSurfaceModeChange}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByTestId('session-starting-show-terminal'));
    });
    expect(onSurfaceModeChange).toHaveBeenCalledWith('terminal');

    const { result } = renderHook(() =>
      useSessionStartingGate(sessionStartingScopeKey('wt-3179', 'antigravity'), since),
    );
    expect(result.current.starting).toBe(true);
    expect(result.current.noticeVisible).toBe(false);
  });
});

describe('[#3179] useSessionStartingGate', () => {
  it('is idle without a launch, and scopes a reveal to one launch of one instance', () => {
    const key = sessionStartingScopeKey('wt-3179', 'codex');
    const { result, rerender } = renderHook(
      ({ since }: { since: number | null }) => useSessionStartingGate(key, since),
      { initialProps: { since: null as number | null } },
    );
    expect(result.current).toMatchObject({ starting: false, noticeVisible: false });

    rerender({ since: 1_000 });
    expect(result.current).toMatchObject({ starting: true, noticeVisible: true });
    act(() => result.current.revealTerminal());
    expect(result.current.noticeVisible).toBe(false);

    const other = renderHook(() => useSessionStartingGate(sessionStartingScopeKey('wt-3179', 'codex-2'), 1_000));
    expect(other.result.current.noticeVisible).toBe(true);

    rerender({ since: 2_000 });
    expect(result.current.noticeVisible).toBe(true);
  });
});
