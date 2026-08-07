/**
 * The degraded `promptData` value, all the way through (Issue #1738).
 *
 * Since Issue #1725 `/current-output` can publish a `StructuredPromptWaitingData`
 * — `type: 'unclassified'`, no options, nothing that may be answered by option
 * number — but only `PromptPanel`, at the very end of the chain, had widened its
 * type for it. Every layer in between (the WebSocket snapshot, the polling hooks,
 * the UI reducer, the Auto-Yes hook) went on declaring `PromptData`, so each of
 * them held a value its own type said could not exist. Nothing was broken by it;
 * what was broken was the next person to trust the type and reach for `options`.
 *
 * These tests pin both halves of the fix:
 *
 * - the TYPES, by assigning a real degraded value into each layer's declared
 *   type. A layer that narrows back to `PromptData` fails `tsc --noEmit`, which
 *   is the only place a type regression can be caught — no runtime assertion
 *   can see it.
 * - the DESIGN INVARIANT, with a `@ts-expect-error` that fires if anyone
 *   "closes the gap" the forbidden way, by adding the degraded form to the
 *   `PromptData` union itself (see the `UNCLASSIFIED_PROMPT_TYPE` note in
 *   `types/models.ts`). An unused `@ts-expect-error` is itself a tsc error, so
 *   that line goes red the moment the union is widened.
 * - the BEHAVIOUR, by carrying one degraded payload from a `/current-output`
 *   response through the polling hook and the reducer into a rendered panel.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderHook, waitFor } from '@testing-library/react';

import {
  UNCLASSIFIED_PROMPT_TYPE,
  isAnswerablePromptData,
  type LivePromptData,
  type PromptData,
  type StoredPromptData,
  type UnclassifiedFrameRecord,
} from '@/types/models';
import {
  buildStructuredPromptData,
  buildStructuredPromptHistoryRecord,
  type StructuredPromptWaitingData,
} from '@/lib/session/structured-prompt';
import type { CurrentOutputPayload } from '@/lib/session/current-output-builder';
import type { TerminalSnapshotEvent } from '@/lib/realtime/types';
import type { PanePromptState } from '@/hooks/useTerminalPanePolling';
import type { PromptState } from '@/types/ui-state';
import type { WorktreeUIAction } from '@/types/ui-actions';
import type { UseAutoYesParams } from '@/hooks/useAutoYes';
import type { PanelPromptData, PromptPanelProps } from '@/components/worktree/PromptPanel';
import type { MobilePromptSheetProps } from '@/components/mobile/MobilePromptSheet';
import { worktreeUIReducer } from '@/hooks/useWorktreeUIState';
import { createInitialUIState } from '@/types/ui-state';
import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';
import { useAutoYes } from '@/hooks/useAutoYes';
import { PromptPanel } from '@/components/worktree/PromptPanel';

vi.mock('@/hooks/useRealtimeConnection', () => ({
  useRealtime: () => ({
    status: 'disconnected' as const,
    connected: false,
    subscribe: () => {},
    unsubscribe: () => {},
    addListener: () => () => {},
  }),
}));

/** Exactly what the server publishes for a dialog only the structured layer saw. */
const degraded: StructuredPromptWaitingData = buildStructuredPromptData('wt-1738', {
  source: 'notification',
  message: 'Claude needs your permission to use Bash',
  toolName: 'Bash',
});

const yesNo: PromptData = {
  type: 'yes_no',
  question: 'Continue?',
  options: ['yes', 'no'],
  status: 'pending',
};

describe('Issue #1738: the degraded promptData is representable at every layer', () => {
  it('is the shape #1725 publishes, so these pins are about the real value', () => {
    expect(degraded.type).toBe(UNCLASSIFIED_PROMPT_TYPE);
    expect(degraded.options).toEqual([]);
    expect(degraded.status).toBe('pending');
  });

  it('fits the type of every layer between the builder and the panel', () => {
    // Each annotation is the assertion. Narrow any one of them back to
    // `PromptData` and this file stops compiling.
    const fromBuilder: CurrentOutputPayload['promptData'] = degraded;
    const overTheWebSocket: TerminalSnapshotEvent['promptData'] = degraded;
    const inThePollingHook: PanePromptState['data'] = degraded;
    const inTheReducerSlice: PromptState['data'] = degraded;
    const inTheReducerAction: WorktreeUIAction = {
      type: 'SHOW_PROMPT',
      data: degraded,
      messageId: 'm-1',
    };
    const intoAutoYes: UseAutoYesParams['promptData'] = degraded;
    const intoThePanel: PromptPanelProps['promptData'] = degraded;
    const intoTheMobileSheet: MobilePromptSheetProps['promptData'] = degraded;

    expect(fromBuilder).toBe(degraded);
    expect(overTheWebSocket).toBe(degraded);
    expect(inThePollingHook).toBe(degraded);
    expect(inTheReducerSlice).toBe(degraded);
    expect(inTheReducerAction.type).toBe('SHOW_PROMPT');
    expect(intoAutoYes).toBe(degraded);
    expect(intoThePanel).toBe(degraded);
    expect(intoTheMobileSheet).toBe(degraded);
  });

  it("keeps the panel's local name a reference to the shared union, not a second copy", () => {
    // `PanelPromptData` is now an alias of `LivePromptData`; assigning in both
    // directions is only legal while that stays true.
    const asPanel: PanelPromptData = degraded;
    const asShared: LivePromptData = asPanel;
    expect(asShared).toBe(degraded);
  });

  it('stays OUT of the PromptData union — the gap is closed on the path, not the union', () => {
    // If someone "fixes" #1738 by adding StructuredPromptWaitingData to
    // PromptData, this @ts-expect-error becomes unused and `tsc --noEmit`
    // reports it. That is the alarm: UNCLASSIFIED_PROMPT_TYPE documents why the
    // union must stay closed to a value no prompt-answering path may accept.
    // @ts-expect-error the degraded form is deliberately not a PromptData
    const forbidden: PromptData = degraded;
    expect(forbidden.type).toBe(UNCLASSIFIED_PROMPT_TYPE);
  });
});

describe('Issue #1738: isAnswerablePromptData is the single branch', () => {
  const unclassifiedFrame: UnclassifiedFrameRecord = {
    type: UNCLASSIFIED_PROMPT_TYPE,
    status: 'unclassified',
    question: 'Unclassified interactive frame (running/default) held for 900s.',
    options: [],
    dwellSeconds: 900,
    sessionStatusReason: 'running/default',
  };

  it('accepts the prompts that carry options', () => {
    expect(isAnswerablePromptData(yesNo)).toBe(true);
    expect(
      isAnswerablePromptData({
        type: 'multiple_choice',
        question: 'Choose:',
        status: 'pending',
        options: [{ number: 1, label: 'First' }],
      }),
    ).toBe(true);
  });

  it('refuses every degraded shape, live and stored', () => {
    expect(isAnswerablePromptData(degraded)).toBe(false);
    expect(isAnswerablePromptData(unclassifiedFrame)).toBe(false);
    expect(
      isAnswerablePromptData(
        buildStructuredPromptHistoryRecord('wt-1738', { source: 'notification', message: null }),
      ),
    ).toBe(false);
  });

  it('refuses absent payloads', () => {
    expect(isAnswerablePromptData(null)).toBe(false);
    expect(isAnswerablePromptData(undefined)).toBe(false);
  });

  it('narrows in both directions, which is what saves the call sites', () => {
    // Declared as the full union so neither branch is narrowed away by the
    // initializer: `answer` has to typecheck inside the true branch and must NOT
    // be reachable outside it.
    const describeStored = (stored: StoredPromptData): string =>
      isAnswerablePromptData(stored)
        ? `answerable:${stored.answer ?? 'unanswered'}`
        : `degraded:${stored.status}`;

    expect(describeStored(unclassifiedFrame)).toBe('degraded:unclassified');
    expect(describeStored(yesNo)).toBe('answerable:unanswered');
    expect(describeStored({ ...yesNo, status: 'answered', answer: 'yes' })).toBe('answerable:yes');
  });
});

describe('Issue #1738: the degraded value survives the hook chain', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reaches useTerminalPanePolling.prompt.data intact and renders as the degraded notice', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          isRunning: true,
          fullOutput: '',
          thinking: false,
          isPromptWaiting: true,
          // Byte-for-byte what `/current-output` serializes for this case.
          promptData: JSON.parse(JSON.stringify(degraded)),
        }),
      }),
    );

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'wt-1738', cliToolId: 'claude' }),
    );

    await waitFor(() => expect(result.current.prompt.visible).toBe(true));
    expect(result.current.prompt.data).toMatchObject({
      type: UNCLASSIFIED_PROMPT_TYPE,
      source: 'notification',
      toolName: 'Bash',
    });

    // Straight out of the hook and into the panel — no cast in between, which
    // is the whole of what #1738 changed.
    render(
      <PromptPanel
        promptData={result.current.prompt.data}
        messageId={result.current.prompt.messageId}
        visible
        answering={false}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.getByTestId('unclassified-prompt-notice')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('survives the UI reducer without being downgraded', () => {
    const next = worktreeUIReducer(createInitialUIState(), {
      type: 'SHOW_PROMPT',
      data: degraded,
      messageId: 'prompt-1738',
    });

    expect(next.phase).toBe('prompt');
    expect(next.prompt.visible).toBe(true);
    expect(next.prompt.data).toBe(degraded);
  });
});

describe('Issue #1738: Auto-Yes never answers the degraded form', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends nothing for a dialog nobody parsed, even with Auto-Yes on', () => {
    // The refusal predates this Issue — `resolveAutoAnswer` fell through to null
    // for an unrecognised `type`. What #1738 adds is that the hook now STATES
    // it, on a value its own parameter type admits. Pinned here so a future
    // rewrite of the resolver cannot quietly make an unanswerable dialog
    // answerable: on a numbered dialog a bare 'y' takes whatever entry is
    // highlighted, not the one anyone chose (Issue #1681).
    renderHook(() =>
      useAutoYes({
        worktreeId: 'wt-1738',
        cliTool: 'claude',
        isPromptWaiting: true,
        promptData: degraded,
        autoYesEnabled: true,
      }),
    );

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('still answers a real prompt, so the guard is not simply refusing everything', () => {
    renderHook(() =>
      useAutoYes({
        worktreeId: 'wt-1738',
        cliTool: 'claude',
        isPromptWaiting: true,
        promptData: yesNo,
        autoYesEnabled: true,
      }),
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, { body: string }];
    expect(url).toContain('/prompt-response');
    expect(JSON.parse(options.body)).toMatchObject({ answer: 'y', promptType: 'yes_no' });
  });
});
