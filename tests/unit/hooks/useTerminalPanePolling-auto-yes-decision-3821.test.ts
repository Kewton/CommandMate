/**
 * `prompt.autoYesDecision` on the pane hook (Issue #3821, Codex review T4):
 * the server's decision about the prompt reaches the PC answer panel by both
 * delivery paths, and the panel's gate (`showsPromptUnderAutoYes`) opens for
 * every decision but `answering`.
 *
 *  - the poll: `autoYesDecision` (absent from a server older than the field);
 *  - the push: `autoYesDecision`, applied when the key is present; when it is
 *    absent, kept for the same window and dropped for another (#2887's rule);
 *  - the two paths out of order: a decision observed before the one applied
 *    to the same window is not applied over it;
 *  - another instance: nothing of the previous one's decision is carried.
 *
 * Harness from `useTerminalPanePolling-enter-fallback-3397.test.ts`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';
import { showsPromptUnderAutoYes } from '@/components/worktree/prompt-answer';
import type { TerminalSnapshotEvent } from '@/lib/realtime/types';
import type { AutoYesDecisionPublished } from '@/types/auto-yes-decision';

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

const WORKTREE_ID = 'w-3821';

function promptData(labels: readonly string[]) {
  return {
    type: 'multiple_choice' as const,
    question: 'Do you want to proceed?',
    status: 'pending' as const,
    options: labels.map((label, i) => ({ number: i + 1, label, isDefault: i === 0 })),
  };
}

const PERMISSION = promptData(['Yes', 'No']);

const answering = (observedAt: number): AutoYesDecisionPublished => ({ state: 'answering', reason: null, observedAt });
const withheld = (observedAt: number, reason = 'unclassified-frame'): AutoYesDecisionPublished => ({
  state: 'withheld',
  reason,
  observedAt,
});

/** The body every poll answers with from now on. */
let pollBody: Record<string, unknown> = {};
function servePolls(): void {
  global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: async () => pollBody })) as unknown as typeof fetch;
}
/** From now on a poll never comes back: only the pushes move the pane. */
function hangPolls(): void {
  global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
}

function polled(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    isRunning: true,
    cliToolId: 'claude',
    sessionStatus: 'waiting',
    fullOutput: 'same frame',
    isPromptWaiting: true,
    promptData: PERMISSION,
    promptAnswerable: true,
    ...extra,
  };
}

function push(
  version: number,
  data: ReturnType<typeof promptData> | null,
  decision?: AutoYesDecisionPublished,
  instanceId = 'claude',
): TerminalSnapshotEvent {
  const base: TerminalSnapshotEvent = {
    type: 'terminal_snapshot',
    worktreeId: WORKTREE_ID,
    cliToolId: 'claude',
    instanceId,
    // The body does not change: only the decision does (T4).
    output: 'same frame',
    isRunning: true,
    sessionStatus: 'waiting',
    thinking: false,
    isPromptWaiting: data !== null,
    promptData: data,
    promptAnswerable: true,
    isSelectionListActive: false,
    isPagerActive: false,
    isUnclassifiedActive: false,
    version,
  };
  return decision === undefined ? base : { ...base, autoYesDecision: decision };
}

async function renderPolled(body: Record<string, unknown>, instanceId?: string) {
  pollBody = body;
  servePolls();
  const hook = renderHook(
    ({ instance }: { instance?: string }) =>
      useTerminalPanePolling({ worktreeId: WORKTREE_ID, cliToolId: 'claude', instanceId: instance }),
    { initialProps: { instance: instanceId } },
  );
  await waitFor(() => expect(hook.result.current.prompt.visible).toBe(true));
  return hook;
}

/** Whether the PC panel is drawn under Auto-Yes for what the hook holds. */
function panelUnderAutoYes(prompt: { data: unknown; answerable?: boolean; autoYesDecision?: AutoYesDecisionPublished }) {
  return showsPromptUnderAutoYes(
    prompt.data as Parameters<typeof showsPromptUnderAutoYes>[0],
    prompt.answerable,
    prompt.autoYesDecision,
  );
}

describe('[#3821] useTerminalPanePolling carries the Auto-Yes decision', () => {
  beforeEach(() => {
    realtimeMock.listeners.length = 0;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('the poll', () => {
    it('answering: carried, and the panel stays hidden under Auto-Yes', async () => {
      const { result } = await renderPolled(polled({ autoYesDecision: answering(1_000) }));
      expect(result.current.prompt.autoYesDecision).toEqual(answering(1_000));
      expect(panelUnderAutoYes(result.current.prompt)).toBe(false);
    });

    it.each([
      ['withheld', withheld(1_000)],
      ['withheld (no poller for the instance)', withheld(1_000, 'server-poller-inactive')],
      ['none', { state: 'none', reason: null, observedAt: 1_000 } as AutoYesDecisionPublished],
    ])('%s: the panel is drawn under Auto-Yes', async (_label, decision) => {
      const { result } = await renderPolled(polled({ autoYesDecision: decision }));
      expect(result.current.prompt.autoYesDecision).toEqual(decision);
      expect(panelUnderAutoYes(result.current.prompt)).toBe(true);
    });

    it('a server older than the field: no decision, and the panel is drawn (not read as answering)', async () => {
      const { result } = await renderPolled(polled({}));
      expect(result.current.prompt.autoYesDecision).toBeUndefined();
      expect(panelUnderAutoYes(result.current.prompt)).toBe(true);
    });
  });

  describe('the push', () => {
    it('the body unchanged, answering -> withheld: applied, and the panel opens', async () => {
      const { result } = await renderPolled(polled({ autoYesDecision: answering(1_000) }));
      hangPolls();
      expect(panelUnderAutoYes(result.current.prompt)).toBe(false);

      act(() => realtimeMock.emit(push(1, PERMISSION, withheld(2_000))));

      await waitFor(() => expect(result.current.prompt.autoYesDecision?.state).toBe('withheld'));
      expect(panelUnderAutoYes(result.current.prompt)).toBe(true);
    });

    it('withheld -> a newer answering: applied', async () => {
      const { result } = await renderPolled(polled({ autoYesDecision: withheld(1_000) }));
      hangPolls();
      act(() => realtimeMock.emit(push(1, PERMISSION, answering(2_000))));
      await waitFor(() => expect(result.current.prompt.autoYesDecision?.state).toBe('answering'));
    });

    it('without the key: kept for the same window', async () => {
      const { result } = await renderPolled(polled({ autoYesDecision: withheld(1_000) }));
      hangPolls();
      act(() => realtimeMock.emit(push(1, PERMISSION)));
      await waitFor(() => expect(result.current.terminal.output).toBe('same frame'));
      expect(result.current.prompt.autoYesDecision).toEqual(withheld(1_000));
    });

    it('without the key: dropped for another window', async () => {
      const { result } = await renderPolled(polled({ autoYesDecision: answering(1_000) }));
      hangPolls();
      act(() => realtimeMock.emit(push(1, promptData(['Allow', 'Deny']))));
      await waitFor(() => expect(result.current.prompt.data?.type).toBe('multiple_choice'));
      await waitFor(() => expect(result.current.prompt.autoYesDecision).toBeUndefined());
      expect(panelUnderAutoYes(result.current.prompt)).toBe(true);
    });
  });

  describe('the poll and the push out of order', () => {
    it('a poll built before the push it lands after does not bring back its decision', async () => {
      const { result } = await renderPolled(polled({ autoYesDecision: answering(1_000) }));

      act(() => realtimeMock.emit(push(1, PERMISSION, withheld(5_000))));
      await waitFor(() => expect(result.current.prompt.autoYesDecision?.state).toBe('withheld'));

      // A poll the server built at 3s, arriving now.
      pollBody = polled({ autoYesDecision: answering(3_000) });
      await act(async () => {
        await result.current.refresh();
      });
      expect(result.current.prompt.autoYesDecision).toEqual(withheld(5_000));
      expect(panelUnderAutoYes(result.current.prompt)).toBe(true);
    });

    it('control: a poll built after the push is applied', async () => {
      const { result } = await renderPolled(polled({ autoYesDecision: answering(1_000) }));

      act(() => realtimeMock.emit(push(1, PERMISSION, withheld(5_000))));
      await waitFor(() => expect(result.current.prompt.autoYesDecision?.state).toBe('withheld'));

      pollBody = polled({ autoYesDecision: answering(6_000) });
      await act(async () => {
        await result.current.refresh();
      });
      expect(result.current.prompt.autoYesDecision).toEqual(answering(6_000));
    });
  });

  describe('another instance', () => {
    it('the previous instance’s decision is not carried to the next one', async () => {
      const hook = await renderPolled(polled({ autoYesDecision: answering(1_000) }), 'claude');
      expect(hook.result.current.prompt.autoYesDecision?.state).toBe('answering');

      // The next instance shows the same question; its server is older (no field).
      pollBody = polled({});
      hook.rerender({ instance: 'claude-2' });
      await waitFor(() => expect(hook.result.current.prompt.visible).toBe(true));
      await waitFor(() => expect(hook.result.current.prompt.autoYesDecision).toBeUndefined());
      expect(panelUnderAutoYes(hook.result.current.prompt)).toBe(true);
    });

    it('a push for another instance is not applied', async () => {
      const { result } = await renderPolled(polled({ autoYesDecision: withheld(1_000) }), 'claude');
      hangPolls();
      act(() => realtimeMock.emit(push(1, PERMISSION, answering(9_000), 'claude-2')));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(result.current.prompt.autoYesDecision).toEqual(withheld(1_000));
    });
  });
});
