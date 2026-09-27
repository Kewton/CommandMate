/**
 * `prompt.answerable` — the status API's `promptAnswerable` on the pane
 * (Issue #2870).
 *
 * Only the HTTP poll carries the field; the WebSocket push does not. So the
 * poll's verdict is applied as-is, and a push keeps it for the SAME window
 * (same fingerprint) and drops it for a different one: a push must neither
 * re-enable a Send the poll said the route would refuse, nor carry that refusal
 * over to a window nobody judged.
 *
 * The poll answers once and then freezes, so after it only the push can move
 * the state.
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

const WORKTREE_ID = 'w-2870';

function promptData(labels: readonly string[]) {
  return {
    type: 'multiple_choice' as const,
    question: 'Select Model',
    status: 'pending' as const,
    options: labels.map((label, i) => ({ number: i + 1, label, isDefault: i === 0 })),
  };
}

const MODEL = promptData(['gpt-5.5', 'gpt-5.5-mini']);
const OTHER = promptData(['Yes', 'No']);

function snapshot(version: number, data: ReturnType<typeof promptData>): TerminalSnapshotEvent {
  return {
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

describe('[#2870] useTerminalPanePolling publishes prompt.answerable', () => {
  beforeEach(() => {
    realtimeMock.listeners.length = 0;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('takes the poll\'s verdict', async () => {
    const { result } = await renderPolled({ promptData: MODEL, promptAnswerable: false });
    expect(result.current.prompt.answerable).toBe(false);
  });

  it('is undefined when the poll carries none', async () => {
    const { result } = await renderPolled({ promptData: MODEL });
    expect(result.current.prompt.answerable).toBeUndefined();
  });

  it('keeps the verdict across a push of the same window', async () => {
    const { result } = await renderPolled({ promptData: MODEL, promptAnswerable: false });

    act(() => realtimeMock.emit(snapshot(1, promptData(['gpt-5.5', 'gpt-5.5-mini']))));

    await waitFor(() => expect(result.current.terminal.output).toBe('frame-1'));
    expect(result.current.prompt.answerable).toBe(false);
  });

  it('drops the verdict on a push of a different window', async () => {
    const { result } = await renderPolled({ promptData: MODEL, promptAnswerable: false });

    act(() => realtimeMock.emit(snapshot(1, OTHER)));

    await waitFor(() => expect(result.current.terminal.output).toBe('frame-1'));
    expect(result.current.prompt.data).toMatchObject({ question: 'Select Model' });
    expect(result.current.prompt.answerable).toBeUndefined();
  });
});
