/**
 * Push-carried `promptAnswerable` (Issue #2887).
 *
 * #2870 gave `prompt.answerable` to the HTTP poll only; `terminal_snapshot` (the
 * WebSocket push) had no such field, so while push stayed healthy a dialog's
 * refusal reached the pane only through the throttled HTTP fallback (up to
 * 15s). #2887 makes `emitTerminalSnapshot` carry the field on the push too when
 * `buildCurrentOutput` judged it, so this file exercises the client side of
 * that: a push frame that HAS the `promptAnswerable` key is applied
 * immediately, exactly like the poll always has been; a push with no such key
 * (a server predating #2887) keeps the #2870 same-window retention behaviour —
 * unmodified and covered by
 * `useTerminalPanePolling-prompt-answerable-2870.test.ts`.
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

const WORKTREE_ID = 'w-2887';

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
  data: ReturnType<typeof promptData>,
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
    isPromptWaiting: true,
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

describe('[#2887] useTerminalPanePolling applies push-carried promptAnswerable', () => {
  beforeEach(() => {
    realtimeMock.listeners.length = 0;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies promptAnswerable: false from a push immediately, with no poll verdict yet', async () => {
    const { result } = await renderPolled({ promptData: MODEL });
    expect(result.current.prompt.answerable).toBeUndefined();

    act(() => realtimeMock.emit(snapshot(1, MODEL, false)));

    await waitFor(() => expect(result.current.terminal.output).toBe('frame-1'));
    expect(result.current.prompt.answerable).toBe(false);
  });

  it('overrides an earlier poll verdict when a later push judges differently', async () => {
    const { result } = await renderPolled({ promptData: MODEL, promptAnswerable: false });
    expect(result.current.prompt.answerable).toBe(false);

    act(() => realtimeMock.emit(snapshot(1, MODEL, true)));

    await waitFor(() => expect(result.current.terminal.output).toBe('frame-1'));
    expect(result.current.prompt.answerable).toBe(true);
  });

  it('falls back to the #2870 same-window retention when the push carries no such key', async () => {
    const { result } = await renderPolled({ promptData: MODEL, promptAnswerable: false });

    act(() => realtimeMock.emit(snapshot(1, MODEL)));

    await waitFor(() => expect(result.current.terminal.output).toBe('frame-1'));
    expect(result.current.prompt.answerable).toBe(false);
  });
});
