/**
 * @vitest-environment jsdom
 *
 * The opt-in waiting chime listener (Issue #1789).
 *
 * The rules under test are the ones that decide whether this feature is a help
 * or a reason to mute the tab:
 *
 *  - **silent unless asked for.** Default off, and off means no call at all —
 *    not a call that happens to fail.
 *  - **once per waiting episode.** The realtime layer (Issue #1788) sends the
 *    waiting edge, but a frame can repeat and the character of a wait can change
 *    mid-flight; both are one wait and get one chime.
 *  - **armed by a user gesture**, because no browser will start audio without
 *    one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';

const realtimeMock = vi.hoisted(() => {
  const listeners: Array<(e: unknown) => void> = [];
  return {
    listeners,
    emit: (event: unknown) => {
      for (const l of [...listeners]) l(event);
    },
    useRealtime: () => ({
      status: 'connected' as const,
      connected: true,
      subscribe: () => {},
      unsubscribe: () => {},
      addListener: (l: (e: unknown) => void) => {
        listeners.push(l);
        return () => {
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    }),
  };
});
vi.mock('@/hooks/useRealtimeConnection', () => ({
  useRealtime: realtimeMock.useRealtime,
}));

const soundMock = vi.hoisted(() => ({
  playWaitingSound: vi.fn(() => true),
  unlockWaitingSound: vi.fn(),
}));
vi.mock('@/lib/pwa/notification-sound', () => soundMock);

import { WaitingSoundListener } from '@/components/notifications/WaitingSoundListener';
import { INAPP_WAITING_SOUND_STORAGE_KEY } from '@/hooks/useInAppNotificationPrefs';

const SINCE = 1_760_000_000_000;

function frame(overrides: Record<string, unknown> = {}) {
  return {
    type: 'session_status_changed',
    worktreeId: 'wt-other',
    cliTool: 'claude',
    instance: 'claude',
    isWaitingForResponse: true,
    waitingKind: 'prompt',
    waitingSince: SINCE,
    ...overrides,
  };
}

function mount() {
  return render(<WaitingSoundListener />);
}

/** Mount with the chime switched on, waiting for the preference to sync in. */
function mountEnabled() {
  localStorage.setItem(INAPP_WAITING_SOUND_STORAGE_KEY, 'true');
  return mount();
}

beforeEach(() => {
  vi.clearAllMocks();
  realtimeMock.listeners.length = 0;
  localStorage.clear();
});

describe('WaitingSoundListener (Issue #1789)', () => {
  it('stays silent while the toggle is off (the default)', () => {
    mount();
    act(() => realtimeMock.emit(frame()));

    expect(soundMock.playWaitingSound).not.toHaveBeenCalled();
  });

  it('stays silent when the toggle is explicitly off', () => {
    localStorage.setItem(INAPP_WAITING_SOUND_STORAGE_KEY, 'false');
    mount();
    act(() => realtimeMock.emit(frame()));

    expect(soundMock.playWaitingSound).not.toHaveBeenCalled();
  });

  it('chimes on the waiting edge when the toggle is on', () => {
    mountEnabled();
    act(() => realtimeMock.emit(frame()));

    expect(soundMock.playWaitingSound).toHaveBeenCalledTimes(1);
  });

  it('chimes exactly once per episode however many frames repeat it', () => {
    mountEnabled();
    act(() => {
      realtimeMock.emit(frame());
      realtimeMock.emit(frame());
      // Same wait, different character (permission dialog → selection list):
      // `waitingSince` is frozen, so it is still one episode.
      realtimeMock.emit(frame({ waitingKind: 'menu' }));
    });

    expect(soundMock.playWaitingSound).toHaveBeenCalledTimes(1);
  });

  it('chimes again for a new episode', () => {
    mountEnabled();
    act(() => realtimeMock.emit(frame()));
    act(() => realtimeMock.emit(frame({ waitingSince: SINCE + 60_000 })));

    expect(soundMock.playWaitingSound).toHaveBeenCalledTimes(2);
  });

  it('chimes once per agent instance that starts waiting', () => {
    mountEnabled();
    act(() => {
      realtimeMock.emit(frame());
      realtimeMock.emit(frame({ instance: 'codex-2', cliTool: 'codex' }));
    });

    expect(soundMock.playWaitingSound).toHaveBeenCalledTimes(2);
  });

  it('says nothing when a wait ends, and re-arms that instance', () => {
    mountEnabled();
    act(() => realtimeMock.emit(frame()));
    expect(soundMock.playWaitingSound).toHaveBeenCalledTimes(1);

    act(() =>
      realtimeMock.emit(frame({ isWaitingForResponse: false, waitingSince: null, waitingKind: null })),
    );
    expect(soundMock.playWaitingSound).toHaveBeenCalledTimes(1);

    // A repeated `since` after the wait ended is a genuinely new episode.
    act(() => realtimeMock.emit(frame()));
    expect(soundMock.playWaitingSound).toHaveBeenCalledTimes(2);
  });

  it('ignores running/stopped frames, which carry no waiting verdict', () => {
    mountEnabled();
    act(() =>
      realtimeMock.emit({ type: 'session_status_changed', worktreeId: 'wt-other', isRunning: true }),
    );

    expect(soundMock.playWaitingSound).not.toHaveBeenCalled();
  });

  it('ignores frames of another type entirely', () => {
    mountEnabled();
    act(() => realtimeMock.emit({ type: 'message', worktreeId: 'wt-other' }));

    expect(soundMock.playWaitingSound).not.toHaveBeenCalled();
  });

  it('arms the audio context on the first user gesture, pointer or keyboard', () => {
    mount();
    expect(soundMock.unlockWaitingSound).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    expect(soundMock.unlockWaitingSound).toHaveBeenCalledTimes(1);

    // Registered `once`, so the same gesture type does not re-arm.
    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    expect(soundMock.unlockWaitingSound).toHaveBeenCalledTimes(1);
  });

  it('arms on a keyboard-only session too', () => {
    mount();
    act(() => {
      window.dispatchEvent(new Event('keydown'));
    });
    expect(soundMock.unlockWaitingSound).toHaveBeenCalled();
  });

  it('stops listening for gestures once unmounted', () => {
    const { unmount } = mount();
    unmount();

    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    expect(soundMock.unlockWaitingSound).not.toHaveBeenCalled();
  });
});
