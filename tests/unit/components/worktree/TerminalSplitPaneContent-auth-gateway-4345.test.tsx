/**
 * Issue #4345 1c: the PC split (`TerminalSplitPaneContent`) answers a prompt through the gateway
 * under the page's registration holder (`HandoffPageOwnerContext`): `/respond` when the payload
 * names a decision, `/prompt-response` otherwise. Its own current-output poll (the real
 * `useTerminalPanePolling`) is what shows the prompt here. Drawn beside the one host (see
 * `page-owner-harness`).
 *
 * Positive controls are red before 1c (nothing here reported); the negative controls are green
 * before and after, and the refusal is still told (the split's toast).
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/wt-a',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));
vi.mock('@/components/worktree/TerminalDisplay', () => ({ TerminalDisplay: () => <div data-testid="terminal-display" /> }));
vi.mock('@/components/worktree/MessageInput', () => ({ MessageInput: () => <div data-testid="message-input" /> }));
vi.mock('@/components/worktree/NavigationButtons', () => ({ NavigationButtons: () => <div /> }));
vi.mock('@/components/worktree/TerminalEscapeHatch', () => ({ TerminalEscapeHatch: () => <div /> }));
vi.mock('@/components/worktree/AutoYesToggle', () => ({ AutoYesToggle: () => <div /> }));
vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: () => <div />,
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
}));
vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({ groups: [], filteredGroups: [], allCommands: [], loading: false, error: null, filter: '', setFilter: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => ({ messages: [], isLoading: false, refresh: vi.fn(() => Promise.resolve()) }),
}));
vi.mock('@/hooks/useHistoryPaneState', () => ({
  useHistoryPaneState: () => ({ visible: false, width: 40, toggle: vi.fn(), setWidth: vi.fn() }),
  DEFAULT_HISTORY_WIDTH: 40,
}));
// The panel hands back what it was given and lets the test press the answer.
vi.mock('@/components/worktree/PromptPanel', () => ({
  PromptPanel: ({ visible, decisionId, onRespond }: { visible: boolean; decisionId?: string | null; onRespond: (answer: string, decisionId?: string | null) => Promise<void> }) =>
    visible ? <button type="button" data-testid="prompt-panel" onClick={() => void onRespond('1', decisionId)} /> : null,
}));

import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import { resetHandoffStoreForTests } from '@/lib/handoff/close-rule';
import { beginHandoffPageRequest, reportHandoffPageResponse, resetHandoffRegistryForTests } from '@/lib/handoff/page-registration';
import { describeEntryCases, json, PAGE_WORKTREE as A, PageTree, standInPage, type EntryCase } from '../../lib/handoff/page-owner-harness';

beforeAll(() => installRadixJsdomPolyfills());
beforeEach(() => {
  resetHandoffRegistryForTests();
  resetHandoffStoreForTests();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetHandoffStoreForTests();
  resetHandoffRegistryForTests();
});

const DECISION_ID = 'per_0000000000000000000000000';
let withDecision = true;

/** The `/current-output` body of a dialog only the structured layer can see. */
function promptPayload(): Record<string, unknown> {
  return {
    isRunning: true,
    fullOutput: '',
    thinking: false,
    isPromptWaiting: true,
    promptData: {
      type: 'unclassified',
      status: 'pending',
      question: 'A dialog is open',
      options: [],
      source: 'notification',
      decisionOptions: [
        { number: 1, label: 'Allow once', reply: 'once' },
        { number: 3, label: 'Reject', reply: 'reject' },
      ],
      ...(withDecision ? { decisionId: DECISION_ID } : {}),
    },
  };
}

const showToast = vi.fn();
const split = () => (
  <TerminalSplitPaneContent
    worktreeId={A}
    splitIndex={0}
    cliToolId="opencode"
    availableInstances={[{ id: 'opencode', cliTool: 'opencode', alias: 'opencode', order: 0 }]}
    onInstanceChange={vi.fn()}
    onFocus={vi.fn()}
    autoYes={{ onToggle: vi.fn() }}
    history={{ showToast }}
  />
);
const answer = async () => fireEvent.click(await screen.findByTestId('prompt-panel'));

const CASES: Record<string, EntryCase> = {
  'the decision answer (/respond)': {
    operation: true,
    matches: (url, method) => url === `/api/worktrees/${A}/respond` && method === 'POST',
    ok: () => json(200, { success: true }),
    ui: () => {
      withDecision = true;
      return split();
    },
    trigger: answer,
  },
  'the prompt answer (/prompt-response)': {
    operation: true,
    matches: (url, method) => url === `/api/worktrees/${A}/prompt-response` && method === 'POST',
    ok: () => json(200, { success: true }),
    ui: () => {
      withDecision = false;
      return split();
    },
    trigger: answer,
  },
};

function fallback(url: string): Response {
  if (url.startsWith(`/api/worktrees/${A}/current-output`)) return json(200, promptPayload());
  return json(200, {});
}

describeEntryCases('the PC split’s prompt answers', CASES, fallback);

describe('[#4345 1c] (negative controls) the split’s refusal is still told', () => {
  it('a 401 answer keeps the card and says so (toast), as a 403 does', async () => {
    withDecision = true;
    for (const status of [403, 401]) {
      cleanup();
      resetHandoffRegistryForTests();
      resetHandoffStoreForTests();
      showToast.mockClear();
      global.fetch = vi.fn(async (input: unknown, init?: RequestInit) =>
        init?.method === 'POST' ? json(status, { error: 'x' }) : fallback(String(input)),
      ) as unknown as typeof fetch;
      const page = standInPage();
      render(<PageTree owner={page.owner}>{split()}</PageTree>);
      await answer();
      await waitFor(() => expect(showToast).toHaveBeenCalled());
      expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
    }
  });
});

describe('[#4345 1c 再指示 2] (T4) the split’s answer not sent tells nothing', () => {
  it('after another entry’s 401: no request, no toast, the card stays', async () => {
    withDecision = true;
    showToast.mockClear();
    const posts: string[] = [];
    global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') posts.push(String(input));
      return fallback(String(input));
    }) as unknown as typeof fetch;
    const page = standInPage();
    render(<PageTree owner={page.owner}>{split()}</PageTree>);
    const panel = await screen.findByTestId('prompt-panel');
    reportHandoffPageResponse(beginHandoffPageRequest(page.registration), { status: 401 });
    fireEvent.click(panel);
    await new Promise((done) => setTimeout(done, 30));
    expect(posts).toEqual([]);
    expect(showToast).not.toHaveBeenCalled();
    expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
  });
});
