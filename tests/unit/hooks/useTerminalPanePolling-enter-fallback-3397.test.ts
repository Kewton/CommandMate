/**
 * `prompt.autoYesEnterSent` on the pane hook (Issue #3397): the Enter record
 * reaches the PC prompt window by both delivery paths, read with the rule
 * `outcome === 'sent' && currentPrompt` (`isAutoYesEnterSentToCurrentPrompt`).
 *
 *  - the poll: `autoYes.lastEnterFallback`;
 *  - the push: `autoYesEnterFallback`, applied when the key is present and,
 *    when it is absent (a server older than the field), kept for the same
 *    window and dropped for another — the #2887 rule for `promptAnswerable`;
 *  - a prompt that goes away takes the value with it.
 *
 * Harness copied from `useTerminalPanePolling-prompt-answerable-push-2887.test.ts`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';
import type { TerminalSnapshotEvent } from '@/lib/realtime/types';

const realtimeMock = vi.hoisted(() => {
  const listeners: Array<(e: unknown) => void> = [];
  const api = {
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
  };
  return {
    listeners,
    emit: (event: unknown) => {
      for (const l of [...listeners]) l(event);
    },
    useRealtime: () => api,
  };
});
vi.mock('@/hooks/useRealtimeConnection', () => ({
  useRealtime: realtimeMock.useRealtime,
}));

const WORKTREE_ID = 'w-3397';

function promptData(labels: readonly string[]) {
  return {
    type: 'multiple_choice' as const,
    question: 'Select Model',
    status: 'pending' as const,
    options: labels.map((label, i) => ({ number: i + 1, label, isDefault: i === 0 })),
  };
}

const MODEL = promptData(['gpt-5.5', 'gpt-5.5-mini']);

/**
 * When `promptAnswerable` is omitted the returned frame carries NO such key at
 * all — the shape a server predating #2887 sends — rather than a key present
 * with value `undefined` (which JSON can't express and the real wire never
 * produces).
 */
function snapshot(
  version: number,
  data: ReturnType<typeof promptData> | null,
  promptAnswerable?: boolean,
): TerminalSnapshotEvent {
  const base: TerminalSnapshotEvent = {
    type: 'terminal_snapshot',
    worktreeId: WORKTREE_ID,
    cliToolId: 'codex',
    instanceId: 'codex',
    output: `frame-${version}`,
    isRunning: true,
    sessionStatus: 'waiting',
    thinking: false,
    isPromptWaiting: data !== null,
    promptData: data,
    isSelectionListActive: false,
    isPagerActive: false,
    isUnclassifiedActive: false,
    version,
  };
  return promptAnswerable === undefined ? base : { ...base, promptAnswerable };
}

function pollOnce(body: Record<string, unknown>): void {
  let answered = false;
  global.fetch = vi.fn(() => {
    if (answered) return new Promise(() => {});
    answered = true;
    return Promise.resolve({ ok: true, json: async () => body });
  }) as unknown as typeof fetch;
}

const POLLED = {
  isRunning: true,
  cliToolId: 'codex',
  sessionStatus: 'waiting',
  fullOutput: 'frame-0',
  isPromptWaiting: true,
};

async function renderPolled(body: Record<string, unknown>) {
  pollOnce({ ...POLLED, ...body });
  const hook = renderHook(() =>
    useTerminalPanePolling({ worktreeId: WORKTREE_ID, cliToolId: 'codex' }),
  );
  await waitFor(() => expect(hook.result.current.prompt.visible).toBe(true));
  return hook;
}

const SENT = {
  outcome: 'sent' as const,
  promptType: 'multiple_choice' as const,
  refusalReason: 'unsupported_dialog_layout' as const,
  sentAt: 1_000,
  at: 1_000,
  currentPrompt: true,
};
const NO_EFFECT = { ...SENT, outcome: 'no-effect' as const };
const OTHER_SCREEN = { ...SENT, currentPrompt: false };

function autoYes(lastEnterFallback: unknown) {
  return { autoYes: { enabled: true, expiresAt: null, lastSuppression: null, lastEnterFallback } };
}

function pushWith(version: number, data: ReturnType<typeof promptData> | null, record?: unknown) {
  const base = snapshot(version, data, false);
  return record === undefined ? base : { ...base, autoYesEnterFallback: record };
}

describe('[#3397] useTerminalPanePolling carries the Enter record', () => {
  beforeEach(() => {
    realtimeMock.listeners.length = 0;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('the poll', () => {
    it('sent to this screen: true', async () => {
      const { result } = await renderPolled({ promptData: MODEL, promptAnswerable: false, ...autoYes(SENT) });
      expect(result.current.prompt.autoYesEnterSent).toBe(true);
    });

    it.each([
      ['no-effect', NO_EFFECT],
      ['another screen', OTHER_SCREEN],
      ['no record', null],
    ])('%s: false', async (_label, record) => {
      const { result } = await renderPolled({ promptData: MODEL, promptAnswerable: false, ...autoYes(record) });
      expect(result.current.prompt.autoYesEnterSent).toBe(false);
    });

    it('a server older than the field (no autoYes): false', async () => {
      const { result } = await renderPolled({ promptData: MODEL, promptAnswerable: false });
      expect(result.current.prompt.autoYesEnterSent).toBe(false);
    });
  });

  describe('the push', () => {
    it('applies a sent record immediately', async () => {
      const { result } = await renderPolled({ promptData: MODEL, promptAnswerable: false, ...autoYes(null) });
      expect(result.current.prompt.autoYesEnterSent).toBe(false);

      act(() => realtimeMock.emit(pushWith(1, MODEL, SENT)));

      await waitFor(() => expect(result.current.terminal.output).toBe('frame-1'));
      expect(result.current.prompt.autoYesEnterSent).toBe(true);
    });

    it('applies no-effect over an earlier sent', async () => {
      const { result } = await renderPolled({ promptData: MODEL, promptAnswerable: false, ...autoYes(SENT) });

      act(() => realtimeMock.emit(pushWith(1, MODEL, NO_EFFECT)));

      await waitFor(() => expect(result.current.terminal.output).toBe('frame-1'));
      expect(result.current.prompt.autoYesEnterSent).toBe(false);
    });

    it('without the key keeps the reading for the same window', async () => {
      const { result } = await renderPolled({ promptData: MODEL, promptAnswerable: false, ...autoYes(SENT) });

      act(() => realtimeMock.emit(pushWith(1, MODEL)));

      await waitFor(() => expect(result.current.terminal.output).toBe('frame-1'));
      expect(result.current.prompt.autoYesEnterSent).toBe(true);
    });

    it('without the key drops the reading for another window', async () => {
      const { result } = await renderPolled({ promptData: MODEL, promptAnswerable: false, ...autoYes(SENT) });

      act(() => realtimeMock.emit(pushWith(1, promptData(['a', 'b']))));

      await waitFor(() => expect(result.current.terminal.output).toBe('frame-1'));
      expect(result.current.prompt.autoYesEnterSent).toBe(false);
    });

    it('a prompt that goes away takes the value with it', async () => {
      const { result } = await renderPolled({ promptData: MODEL, promptAnswerable: false, ...autoYes(SENT) });

      act(() => realtimeMock.emit(pushWith(1, null, SENT)));

      await waitFor(() => expect(result.current.prompt.visible).toBe(false));
      expect(result.current.prompt.autoYesEnterSent).toBeFalsy();
    });
  });
});
