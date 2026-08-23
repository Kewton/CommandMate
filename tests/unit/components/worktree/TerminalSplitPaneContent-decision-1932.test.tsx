/**
 * Where a split posts an answer, once the payload names an approval
 * (Issue #1932).
 *
 * `/prompt-response` and `/respond` are not two spellings of one endpoint. The
 * first re-captures the pane, runs `detectPrompt`, and refuses with
 * `prompt_no_longer_active` when nothing parses — which for a dialog that HAS a
 * decision id is every time, because a decision id is published exactly for the
 * sources whose approval the scraper cannot read. So the pane must switch
 * routes, and it must switch on the id rather than on the tool: a scraper-read
 * prompt from the same tool still goes to `/prompt-response`.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

function inst(cliTool: CLIToolType): AgentInstance {
  return { id: cliTool, cliTool, alias: cliTool, order: 0 };
}

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));
vi.mock('@/components/worktree/MessageInput', () => ({
  MessageInput: () => <div data-testid="message-input" />,
}));
vi.mock('@/components/worktree/NavigationButtons', () => ({
  NavigationButtons: () => <div data-testid="navigation-buttons" />,
}));
vi.mock('@/components/worktree/TerminalEscapeHatch', () => ({
  TerminalEscapeHatch: () => <div data-testid="terminal-escape-hatch" />,
}));
vi.mock('@/components/worktree/AutoYesToggle', () => ({
  AutoYesToggle: () => <div data-testid="auto-yes-toggle" />,
}));
vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: () => <div data-testid="history-pane" />,
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
}));
vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false,
    error: null, filter: '', setFilter: vi.fn(), refresh: vi.fn(),
  }),
}));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => ({ messages: [], isLoading: false, refresh: vi.fn(() => Promise.resolve()) }),
}));
vi.mock('@/hooks/useHistoryPaneState', () => ({
  useHistoryPaneState: () => ({ visible: false, width: 40, toggle: vi.fn(), setWidth: vi.fn() }),
  DEFAULT_HISTORY_WIDTH: 40,
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));

// The panel hands back whatever it was given; this stand-in exposes it and
// lets the test press the answer.
vi.mock('@/components/worktree/PromptPanel', () => ({
  PromptPanel: ({
    visible,
    decisionId,
    onRespond,
  }: {
    visible: boolean;
    decisionId?: string | null;
    onRespond: (answer: string, decisionId?: string | null) => Promise<void>;
  }) =>
    visible ? (
      <button
        type="button"
        data-testid="prompt-panel"
        data-decision-id={decisionId ?? ''}
        onClick={() => { void onRespond('1', decisionId); }}
      />
    ) : null,
}));

const DECISION_ID = 'per_0000000000000000000000000';

type MockFetchResponse = { ok: boolean; status?: number; json: () => Promise<unknown> };

function getUrlString(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** The `/current-output` body for a dialog only the structured layer can see. */
function structuredPromptPayload(withDecisionId: boolean): Record<string, unknown> {
  return {
    isRunning: true,
    fullOutput: '',
    thinking: false,
    isPromptWaiting: true,
    promptData: {
      type: 'unclassified',
      status: 'pending',
      question: 'A dialog is open in w-1',
      options: [],
      source: 'notification',
      decisionOptions: [
        { number: 1, label: 'Allow once', reply: 'once' },
        { number: 2, label: 'Allow always', reply: 'always' },
        { number: 3, label: 'Reject', reply: 'reject' },
      ],
      ...(withDecisionId ? { decisionId: DECISION_ID } : {}),
    },
  };
}

describe('answering from a split', () => {
  let mockFetch: ReturnType<typeof vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<MockFetchResponse>>>;
  const posted: Array<{ url: string; body: Record<string, unknown> }> = [];

  beforeEach(() => {
    posted.length = 0;
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function arrange(withDecisionId: boolean) {
    mockFetch.mockImplementation((input, init) => {
      const url = getUrlString(input);
      if (init?.method === 'POST') {
        posted.push({ url, body: JSON.parse(String(init.body)) });
        return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
      }
      return Promise.resolve({
        ok: true,
        json: async () => structuredPromptPayload(withDecisionId),
      });
    });

    render(
      <TerminalSplitPaneContent
        worktreeId="w-1"
        splitIndex={0}
        cliToolId="opencode"
        availableInstances={[inst('opencode')]}
        onInstanceChange={vi.fn()}
        onFocus={vi.fn()}
        autoYes={{ onToggle: vi.fn() }}
      />,
    );
  }

  it('posts the decision to /respond when the payload names one', async () => {
    arrange(true);

    await waitFor(() => {
      expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
    });
    expect(screen.getByTestId('prompt-panel').getAttribute('data-decision-id')).toBe(DECISION_ID);

    fireEvent.click(screen.getByTestId('prompt-panel'));

    await waitFor(() => {
      expect(posted.length).toBeGreaterThan(0);
    });
    expect(posted[0].url).toBe('/api/worktrees/w-1/respond');
    expect(posted[0].body).toMatchObject({
      decisionId: DECISION_ID,
      answer: '1',
      cliTool: 'opencode',
    });
    // The primary instance is named by the tool id server-side, so sending it
    // would be noise — the same rule `buildPromptResponseBody` follows.
    expect(posted[0].body).not.toHaveProperty('instanceId');
  });

  it('still posts to /prompt-response when there is no decision to name', async () => {
    arrange(false);

    await waitFor(() => {
      expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
    });
    expect(screen.getByTestId('prompt-panel').getAttribute('data-decision-id')).toBe('');

    fireEvent.click(screen.getByTestId('prompt-panel'));

    await waitFor(() => {
      expect(posted.length).toBeGreaterThan(0);
    });
    expect(posted[0].url).toBe('/api/worktrees/w-1/prompt-response');
    expect(posted[0].body).not.toHaveProperty('decisionId');
  });
});
