/**
 * Every surface reaches the same conclusion about the same prompt
 * (Issue #3184, design §4.2 — the one table).
 *
 * Rows: the shared fixture (`tests/fixtures/prompt-view-3184`) — the Issue's
 * four categories (screen numbers / API choices / free text / unreadable) and
 * three controls. Columns: the PC panel, the phone sheet, the chat surface's
 * card, browser-side Auto-Yes and `commandmate wait`. For each cell the
 * EXPECTED value is derived from the row's `PromptView` and the OBSERVED value
 * is what the surface actually did, so a surface that re-derives the decision
 * for itself and gets it wrong fails in its own column.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, renderHook } from '@testing-library/react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => 'en');
});

import { MobilePromptSheet } from '@/components/mobile/MobilePromptSheet';
import { PromptPanel } from '@/components/worktree/PromptPanel';
import { resolveBlockedReason } from '@/components/worktree/ChatSurface';
import { readDecisionId as readPromptDecisionId } from '@/lib/session/prompt-view';
import { useAutoYes } from '@/hooks/useAutoYes';
import { derivePromptView, type PromptView } from '@/lib/session/prompt-view';
import { WaitExitCode } from '@/cli/types';
import type { LivePromptData } from '@/types/models';
import { mockFetchSequence, restoreFetch } from '../../helpers/mock-api';
import { PROMPT_VIEW_ROWS, type PromptViewRow } from '../../fixtures/prompt-view-3184';

/** What a surface concluded: answer on screen, answer over the API, or nothing to offer. */
type Conclusion = 'screen' | 'api' | 'none';

const conclusionOf = (view: PromptView): Conclusion =>
  view.kind === 'screen-choices' ? 'screen' : view.kind === 'api-choices' ? 'api' : 'none';

const UNREADABLE_HEADING = /could not read its options/;

afterEach(() => {
  cleanup();
  restoreFetch();
  vi.restoreAllMocks();
});

/** What the rendered panel / sheet offers. */
function observeRendered(prefix: '' | 'mobile-'): Conclusion {
  const api =
    screen.queryByTestId(`${prefix}structured-decision-actions`) !== null ||
    screen.queryByTestId(prefix === '' ? 'structured-question-actions' : 'mobile-structured-question') !== null;
  if (api) return 'api';
  const screenControls =
    screen.queryAllByRole('radio').length > 0 ||
    screen.queryAllByRole('checkbox').length > 0 ||
    screen.queryByRole('button', { name: /^yes$/i }) !== null;
  return screenControls ? 'screen' : 'none';
}

function observePanel(data: LivePromptData): { conclusion: Conclusion; unreadableHeading: boolean } {
  render(
    <PromptPanel
      promptData={data}
      messageId={null}
      decisionId={readPromptDecisionId(data)}
      visible
      answering={false}
      onRespond={vi.fn()}
    />,
  );
  const result = {
    conclusion: observeRendered(''),
    unreadableHeading: screen.queryByText(UNREADABLE_HEADING) !== null,
  };
  cleanup();
  return result;
}

function observeSheet(data: LivePromptData): { conclusion: Conclusion; unreadableHeading: boolean } {
  render(<MobilePromptSheet promptData={data} visible answering={false} onRespond={vi.fn()} />);
  const result = {
    conclusion: observeRendered('mobile-'),
    unreadableHeading: screen.queryByText(UNREADABLE_HEADING) !== null,
  };
  cleanup();
  return result;
}

/** The chat surface raises the "could not read" card exactly for nothing-to-offer. */
function observeChat(data: LivePromptData): 'card' | 'no-card' {
  const reason = resolveBlockedReason({ isRunning: true, isPromptWaiting: true, promptData: data });
  return reason === 'promptUnreadable' ? 'card' : 'no-card';
}

/** Whether browser-side Auto-Yes typed an answer at the pane. */
function observeAutoYes(data: LivePromptData): boolean {
  const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchSpy);
  renderHook(() =>
    useAutoYes({
      worktreeId: 'wt-3184',
      cliTool: 'claude',
      isPromptWaiting: true,
      promptData: data,
      autoYesEnabled: true,
      serverPollerActive: false,
    }),
  );
  vi.unstubAllGlobals();
  return fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/prompt-response'));
}

/** `wait`'s exit-10 `answerVia`, mapped onto the same three words. */
async function observeWait(data: LivePromptData): Promise<Conclusion> {
  vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mockFetchSequence([
    {
      data: {
        isRunning: true,
        isComplete: false,
        isPromptWaiting: true,
        isGenerating: false,
        content: '',
        fullOutput: '',
        realtimeSnippet: '',
        lineCount: 1,
        lastCapturedLine: 1,
        promptData: data,
        autoYes: { enabled: false, expiresAt: null },
        thinking: false,
        thinkingMessage: null,
        cliToolId: 'claude',
        isSelectionListActive: false,
        lastServerResponseTimestamp: null,
        serverPollerActive: false,
        sessionStatus: 'waiting',
      },
    },
  ]);
  const { createWaitCommand } = await import('@/cli/commands/wait');
  await createWaitCommand().parseAsync(['node', 'wait', 'wt-3184']);
  expect(process.exit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
  const output = JSON.parse(String(log.mock.calls[0][0]));
  return output.answerVia === 'screen' ? 'screen' : output.answerVia === 'api' ? 'api' : 'none';
}

/** Browser Auto-Yes answers only a screen prompt whose default is a plain choice. */
function autoYesShouldSend(view: PromptView): boolean {
  if (view.kind !== 'screen-choices' || view.multiSelect) return false;
  const target = view.choices.find((choice) => choice.isDefault) ?? view.choices[0];
  return target !== undefined && !target.takesText;
}

describe('one prompt, one conclusion on every surface (#3184)', () => {
  it.each(PROMPT_VIEW_ROWS.map((row) => [`${row.id} ${row.category}`, row] as const))(
    '%s',
    async (_name, row: PromptViewRow) => {
      const view = derivePromptView(row.data)!;
      const expected = conclusionOf(view);

      const panel = observePanel(row.data);
      const sheet = observeSheet(row.data);
      const observed = {
        panel: panel.conclusion,
        sheet: sheet.conclusion,
        chat: observeChat(row.data),
        autoYes: observeAutoYes(row.data),
        wait: await observeWait(row.data),
        unreadableHeading: { panel: panel.unreadableHeading, sheet: sheet.unreadableHeading },
      };

      expect(observed).toEqual({
        panel: expected,
        sheet: expected,
        chat: expected === 'none' ? 'card' : 'no-card',
        autoYes: autoYesShouldSend(view),
        wait: expected,
        // #3181: "could not read its options" only where there truly is nothing.
        unreadableHeading: { panel: expected === 'none', sheet: expected === 'none' },
      });
    },
  );
});
