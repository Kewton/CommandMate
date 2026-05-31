/**
 * Tests for TerminalSplitPaneContent (Issue #728, R3-005)
 *
 * Verifies that each split owns its own polling effect that calls
 * /current-output for its OWN cliToolId, and that NavigationButtons and
 * PromptPanel render inside every split (not just splitIndex=0).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';

// Mock the heavy descendants so we can assert the wiring without pulling in
// the full TerminalDisplay / MessageInput / PromptPanel / NavigationButtons
// trees.
vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: ({ output, isActive, isThinking }: {
    output: string;
    isActive: boolean;
    isThinking: boolean;
  }) => (
    <div data-testid="terminal-display">
      <span data-testid="terminal-output">{output}</span>
      <span data-testid="terminal-active">{String(isActive)}</span>
      {isThinking ? <span data-testid="terminal-thinking" /> : null}
    </div>
  ),
}));

vi.mock('@/components/worktree/MessageInput', () => ({
  MessageInput: ({ cliToolId, splitIndex }: { cliToolId: string; splitIndex: number }) => (
    <div
      data-testid={`message-input-${splitIndex}`}
      data-cli-tool-id={cliToolId}
    />
  ),
}));

vi.mock('@/components/worktree/NavigationButtons', () => ({
  NavigationButtons: ({ cliToolId }: { cliToolId: string }) => (
    <div data-testid="navigation-buttons" data-cli-tool-id={cliToolId} />
  ),
}));

vi.mock('@/components/worktree/PromptPanel', () => ({
  PromptPanel: ({ visible, cliToolName }: { visible: boolean; cliToolName?: string }) =>
    visible ? (
      <div data-testid="prompt-panel" data-cli-tool-name={cliToolName} />
    ) : null,
}));

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false,
    error: null, filter: '', setFilter: vi.fn(), refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_BREAKPOINT: 768,
}));

type MockFetchResponse = {
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
};

const okJson = (data: unknown): Promise<MockFetchResponse> =>
  Promise.resolve({ ok: true, json: async () => data });

function getUrlString(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe('TerminalSplitPaneContent', () => {
  let mockFetch: ReturnType<typeof vi.fn<(input: string | URL | Request) => Promise<MockFetchResponse>>>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches /current-output with its own cliToolId in each split', async () => {
    const calls: Array<{ cli: string }> = [];
    mockFetch.mockImplementation((input) => {
      const url = new URL(getUrlString(input), 'http://localhost');
      const cli = url.searchParams.get('cliTool') ?? '';
      calls.push({ cli });
      const out = `${cli} terminal`;
      return okJson({ isRunning: true, fullOutput: out, thinking: false });
    });

    render(
      <>
        <TerminalSplitPaneContent
          worktreeId="w-1"
          splitIndex={0}
          cliToolId="claude"
          availableCliTools={['claude', 'codex']}
          onCliToolChange={vi.fn()}
          onFocus={vi.fn()}
        />
        <TerminalSplitPaneContent
          worktreeId="w-1"
          splitIndex={1}
          cliToolId="codex"
          availableCliTools={['claude', 'codex']}
          onCliToolChange={vi.fn()}
          onFocus={vi.fn()}
        />
      </>,
    );

    await waitFor(() => {
      const outputs = screen.getAllByTestId('terminal-output').map(e => e.textContent);
      expect(outputs).toEqual(expect.arrayContaining(['claude terminal', 'codex terminal']));
    });

    // Both CLIs got fetched at least once.
    expect(calls.some(c => c.cli === 'claude')).toBe(true);
    expect(calls.some(c => c.cli === 'codex')).toBe(true);
  });

  it('renders NavigationButtons and MessageInput for splitIndex >= 1', async () => {
    mockFetch.mockImplementation((input) => {
      const url = new URL(getUrlString(input), 'http://localhost');
      const cli = url.searchParams.get('cliTool') ?? '';
      return okJson({
        isRunning: true,
        fullOutput: `${cli} body`,
        thinking: false,
        isSelectionListActive: true,
      });
    });

    render(
      <TerminalSplitPaneContent
        worktreeId="w-1"
        splitIndex={1}
        cliToolId="codex"
        availableCliTools={['codex']}
        onCliToolChange={vi.fn()}
        onFocus={vi.fn()}
      />,
    );

    // MessageInput is unconditional per split.
    expect(screen.getByTestId('message-input-1')).toBeInTheDocument();
    expect(screen.getByTestId('message-input-1').getAttribute('data-cli-tool-id')).toBe('codex');

    // NavigationButtons appears after the first poll lands with
    // isSelectionListActive=true.
    await waitFor(() => {
      expect(screen.getByTestId('navigation-buttons')).toBeInTheDocument();
    });
    expect(screen.getByTestId('navigation-buttons').getAttribute('data-cli-tool-id')).toBe('codex');
  });

  it('renders PromptPanel for splitIndex >= 1 when /current-output reports isPromptWaiting', async () => {
    mockFetch.mockImplementation((input) => {
      const url = new URL(getUrlString(input), 'http://localhost');
      const cli = url.searchParams.get('cliTool') ?? '';
      return okJson({
        isRunning: true,
        fullOutput: '',
        thinking: false,
        isPromptWaiting: true,
        promptData: { type: 'yes_no', question: `${cli}?` },
      });
    });

    render(
      <TerminalSplitPaneContent
        worktreeId="w-1"
        splitIndex={1}
        cliToolId="codex"
        availableCliTools={['codex']}
        onCliToolChange={vi.fn()}
        onFocus={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
    });
    expect(screen.getByTestId('prompt-panel').getAttribute('data-cli-tool-name')).toContain('Codex');
  });

  it('hides PromptPanel when autoYesEnabled=true', async () => {
    mockFetch.mockImplementation(() =>
      okJson({
        isRunning: true,
        fullOutput: '',
        thinking: false,
        isPromptWaiting: true,
        promptData: { type: 'yes_no', question: 'Continue?' },
      }),
    );
    render(
      <TerminalSplitPaneContent
        worktreeId="w-1"
        splitIndex={0}
        cliToolId="claude"
        availableCliTools={['claude']}
        onCliToolChange={vi.fn()}
        onFocus={vi.fn()}
        autoYesEnabled
      />,
    );
    // Let polling settle.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('prompt-panel')).not.toBeInTheDocument();
  });

  it('shows attach skeleton until the first /current-output resolves', async () => {
    let resolve: ((res: MockFetchResponse) => void) | undefined;
    const pending = new Promise<MockFetchResponse>((r) => { resolve = r; });
    mockFetch.mockImplementation(() => pending);

    render(
      <TerminalSplitPaneContent
        worktreeId="w-1"
        splitIndex={0}
        cliToolId="claude"
        availableCliTools={['claude']}
        onCliToolChange={vi.fn()}
        onFocus={vi.fn()}
      />,
    );

    expect(screen.getByTestId('terminal-attach-skeleton-0')).toBeInTheDocument();

    await act(async () => {
      resolve?.({ ok: true, json: async () => ({ isRunning: true, fullOutput: 'x', thinking: false }) });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByTestId('terminal-attach-skeleton-0')).not.toBeInTheDocument();
    });
  });
});
