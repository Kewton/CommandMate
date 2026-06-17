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
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';

/**
 * Issue #869: build a primary AgentInstance (id === cliTool) for tests. The
 * split selector is now instance-keyed; primaries keep instanceId === cliToolId
 * so this content wrapper's polling/fetch behavior stays byte-for-byte the same.
 */
function inst(cliTool: CLIToolType): AgentInstance {
  return { id: cliTool, cliTool, alias: cliTool, order: 0 };
}

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
  MessageInput: ({
    cliToolId,
    splitIndex,
    pendingInsertText,
  }: {
    cliToolId: string;
    splitIndex: number;
    pendingInsertText?: string | null;
  }) => (
    <div
      data-testid={`message-input-${splitIndex}`}
      data-cli-tool-id={cliToolId}
      data-pending-insert={pendingInsertText ?? ''}
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

// Issue #740: lightweight AutoYesToggle mock that exposes enabled / cliToolName
// and a clickable element invoking onToggle so we can assert the per-split
// footer wiring without pulling in the real toggle (countdown timers, dialog).
vi.mock('@/components/worktree/AutoYesToggle', () => ({
  AutoYesToggle: ({
    enabled,
    cliToolName,
    onToggle,
  }: {
    enabled: boolean;
    cliToolName?: string;
    onToggle: (params: { enabled: boolean }) => Promise<void>;
  }) => (
    <button
      type="button"
      data-testid="auto-yes-toggle"
      data-enabled={String(enabled)}
      data-cli-tool-name={cliToolName}
      onClick={() => {
        void onToggle({ enabled: !enabled });
      }}
    >
      auto-yes
    </button>
  ),
}));

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false,
    error: null, filter: '', setFilter: vi.fn(), refresh: vi.fn(),
  }),
}));

// Issue #744: lightweight HistoryPane mock that exposes the per-split props
// (splitIndex / cliToolId / messages / onInsertToMessage) so we can assert the
// wiring without rendering the full conversation-pair tree.
vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: ({
    splitIndex,
    cliToolId,
    messages,
    onInsertToMessage,
  }: {
    splitIndex?: number;
    cliToolId?: string;
    messages: Array<{ id: string; content: string }>;
    onInsertToMessage?: (text: string) => void;
  }) => (
    <div
      data-testid="history-pane"
      data-split-index={String(splitIndex)}
      data-cli-tool-id={cliToolId}
      data-message-count={String(messages.length)}
    >
      <button
        type="button"
        data-testid="history-insert"
        onClick={() => onInsertToMessage?.('inserted-from-history')}
      >
        insert
      </button>
    </div>
  ),
  // Issue #744: real export consumed by TerminalSplitPaneContent for the slot id.
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
}));

// Issue #744: control the per-split message fetch.
const splitMessagesByCli: Record<string, Array<{ id: string; content: string }>> = {};
const splitMessagesRefresh = vi.fn(() => Promise.resolve());
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: ({ cliToolId }: { cliToolId: string }) => ({
    messages: splitMessagesByCli[cliToolId] ?? [],
    isLoading: false,
    refresh: splitMessagesRefresh,
  }),
}));

// Issue #744: keep history visible so the embedded HistoryPane renders.
vi.mock('@/hooks/useHistoryPaneState', () => ({
  useHistoryPaneState: () => ({
    visible: true,
    width: 40,
    toggle: vi.fn(),
    setWidth: vi.fn(),
  }),
  DEFAULT_HISTORY_WIDTH: 40,
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
          availableInstances={[inst('claude'), inst('codex')]}
          onInstanceChange={vi.fn()}
          onFocus={vi.fn()}
          autoYes={{ onToggle: vi.fn() }}
        />
        <TerminalSplitPaneContent
          worktreeId="w-1"
          splitIndex={1}
          cliToolId="codex"
          availableInstances={[inst('claude'), inst('codex')]}
          onInstanceChange={vi.fn()}
          onFocus={vi.fn()}
          autoYes={{ onToggle: vi.fn() }}
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
        availableInstances={[inst('codex')]}
        onInstanceChange={vi.fn()}
        onFocus={vi.fn()}
        autoYes={{ onToggle: vi.fn() }}
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
        availableInstances={[inst('codex')]}
        onInstanceChange={vi.fn()}
        onFocus={vi.fn()}
        autoYes={{ onToggle: vi.fn() }}
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
        availableInstances={[inst('claude')]}
        onInstanceChange={vi.fn()}
        onFocus={vi.fn()}
        autoYes={{ enabled: true, onToggle: vi.fn() }}
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
        availableInstances={[inst('claude')]}
        onInstanceChange={vi.fn()}
        onFocus={vi.fn()}
        autoYes={{ onToggle: vi.fn() }}
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

  // Issue #740: AutoYesToggle is now rendered in each PC split footer.
  describe('AutoYesToggle in split footer (Issue #740)', () => {
    beforeEach(() => {
      mockFetch.mockImplementation(() =>
        okJson({ isRunning: true, fullOutput: '', thinking: false }),
      );
    });

    it('renders AutoYesToggle in the footer with cliToolName = the split cliToolId', async () => {
      render(
        <TerminalSplitPaneContent
          worktreeId="w-1"
          splitIndex={1}
          cliToolId="codex"
          availableInstances={[inst('claude'), inst('codex')]}
          onInstanceChange={vi.fn()}
          onFocus={vi.fn()}
          autoYes={{ onToggle: vi.fn() }}
        />,
      );

      const toggle = await screen.findByTestId('auto-yes-toggle');
      expect(toggle).toBeInTheDocument();
      expect(toggle.getAttribute('data-cli-tool-name')).toBe('codex');
    });

    it('invokes onAutoYesToggle (the prop passed in) when the toggle is clicked', async () => {
      const onToggle = vi.fn(() => Promise.resolve());
      render(
        <TerminalSplitPaneContent
          worktreeId="w-1"
          splitIndex={0}
          cliToolId="claude"
          availableInstances={[inst('claude')]}
          onInstanceChange={vi.fn()}
          onFocus={vi.fn()}
          autoYes={{ onToggle }}
        />,
      );

      const toggle = await screen.findByTestId('auto-yes-toggle');
      await act(async () => {
        toggle.click();
        await Promise.resolve();
      });

      expect(onToggle).toHaveBeenCalledTimes(1);
      expect(onToggle).toHaveBeenCalledWith({ enabled: true });
    });

    it('reflects autoYesEnabled on the toggle and suppresses PromptPanel when enabled', async () => {
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
          availableInstances={[inst('claude')]}
          onInstanceChange={vi.fn()}
          onFocus={vi.fn()}
          autoYes={{ enabled: true, onToggle: vi.fn() }}
        />,
      );

      const toggle = await screen.findByTestId('auto-yes-toggle');
      expect(toggle.getAttribute('data-enabled')).toBe('true');
      // Regression guard: showPrompt = prompt.visible && !autoYesEnabled.
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.queryByTestId('prompt-panel')).not.toBeInTheDocument();
    });

    it('routes each split toggle to its OWN onAutoYesToggle handler (per-split independence)', async () => {
      const onToggleClaude = vi.fn(() => Promise.resolve());
      const onToggleCodex = vi.fn(() => Promise.resolve());
      render(
        <>
          <TerminalSplitPaneContent
            worktreeId="w-1"
            splitIndex={0}
            cliToolId="claude"
            availableInstances={[inst('claude'), inst('codex')]}
            onInstanceChange={vi.fn()}
            onFocus={vi.fn()}
            autoYes={{ onToggle: onToggleClaude }}
          />
          <TerminalSplitPaneContent
            worktreeId="w-1"
            splitIndex={1}
            cliToolId="codex"
            availableInstances={[inst('claude'), inst('codex')]}
            onInstanceChange={vi.fn()}
            onFocus={vi.fn()}
            autoYes={{ onToggle: onToggleCodex }}
          />
        </>,
      );

      const toggles = await screen.findAllByTestId('auto-yes-toggle');
      expect(toggles).toHaveLength(2);
      const claudeToggle = toggles.find(t => t.getAttribute('data-cli-tool-name') === 'claude');
      const codexToggle = toggles.find(t => t.getAttribute('data-cli-tool-name') === 'codex');
      expect(claudeToggle).toBeDefined();
      expect(codexToggle).toBeDefined();

      await act(async () => {
        codexToggle?.click();
        await Promise.resolve();
      });

      // Only the codex split's handler fires; claude's stays untouched.
      expect(onToggleCodex).toHaveBeenCalledTimes(1);
      expect(onToggleClaude).not.toHaveBeenCalled();
    });
  });

  // Issue #743: AI agent status indicator (dot/spinner) restored in PC
  // per-split header. Data flows in as a derived `cliStatus: BranchStatus`
  // prop and renders via headerExtras (same shape as the Mobile canonical
  // span at WorktreeDetailRefactored.tsx:1947-1974).
  describe('status indicator in split header (Issue #743)', () => {
    beforeEach(() => {
      mockFetch.mockImplementation(() =>
        okJson({ isRunning: true, fullOutput: '', thinking: false }),
      );
    });

    // 1. State-specific rendering: idle/ready/waiting -> dot, running/generating -> spinner.
    it.each([
      ['idle', 'dot', 'bg-gray-500'],
      ['ready', 'dot', 'bg-green-500'],
      ['waiting', 'dot', 'bg-yellow-500'],
      ['running', 'spinner', 'border-blue-500'],
      ['generating', 'spinner', 'border-blue-500'],
    ] as const)(
      'renders %s as a %s with class %s',
      async (status, kind, colorClass) => {
        render(
          <TerminalSplitPaneContent
            worktreeId="w-1"
            splitIndex={0}
            cliToolId="claude"
            availableInstances={[inst('claude')]}
            onInstanceChange={vi.fn()}
            onFocus={vi.fn()}
            autoYes={{ onToggle: vi.fn() }}
            cliStatus={status}
          />,
        );

        const indicator = await screen.findByTestId('split-status-indicator-0');
        expect(indicator).toBeInTheDocument();
        expect(indicator.className).toContain(colorClass);
        // a11y: title only (no aria-label) to avoid duplicate readout (S3-006).
        expect(indicator.getAttribute('title')).toBeTruthy();
        expect(indicator.getAttribute('aria-label')).toBeNull();

        if (kind === 'spinner') {
          expect(indicator.className).toContain('animate-spin');
        } else {
          expect(indicator.className).not.toContain('animate-spin');
        }
      },
    );

    // 2. Fallback when cliStatus prop is omitted -> idle (gray dot). The existing
    //    call sites that never pass cliStatus must keep working unchanged (S3-002).
    it('falls back to idle (gray dot) when cliStatus is omitted', async () => {
      render(
        <TerminalSplitPaneContent
          worktreeId="w-1"
          splitIndex={0}
          cliToolId="claude"
          availableInstances={[inst('claude')]}
          onInstanceChange={vi.fn()}
          onFocus={vi.fn()}
          autoYes={{ onToggle: vi.fn() }}
        />,
      );

      const indicator = await screen.findByTestId('split-status-indicator-0');
      expect(indicator).toBeInTheDocument();
      expect(indicator.className).toContain('bg-gray-500');
      expect(indicator.className).not.toContain('animate-spin');
    });

    // 3. Per-split independence: split 0 running (blue spinner), split 1 idle
    //    (gray dot) render independently with distinct data-testids.
    it('renders each split status independently (A=running spinner, B=idle dot)', async () => {
      render(
        <>
          <TerminalSplitPaneContent
            worktreeId="w-1"
            splitIndex={0}
            cliToolId="claude"
            availableInstances={[inst('claude'), inst('codex')]}
            onInstanceChange={vi.fn()}
            onFocus={vi.fn()}
            autoYes={{ onToggle: vi.fn() }}
            cliStatus="running"
          />
          <TerminalSplitPaneContent
            worktreeId="w-1"
            splitIndex={1}
            cliToolId="codex"
            availableInstances={[inst('claude'), inst('codex')]}
            onInstanceChange={vi.fn()}
            onFocus={vi.fn()}
            autoYes={{ onToggle: vi.fn() }}
            cliStatus="idle"
          />
        </>,
      );

      const indicator0 = await screen.findByTestId('split-status-indicator-0');
      const indicator1 = await screen.findByTestId('split-status-indicator-1');

      expect(indicator0.className).toContain('border-blue-500');
      expect(indicator0.className).toContain('animate-spin');

      expect(indicator1.className).toContain('bg-gray-500');
      expect(indicator1.className).not.toContain('animate-spin');
    });
  });

  // Issue #744: HistoryPane is now embedded inside each PC split and shows only
  // this split's cliToolId's messages, fetched via useSplitMessages.
  describe('embedded per-split HistoryPane (Issue #744)', () => {
    beforeEach(() => {
      mockFetch.mockImplementation(() =>
        okJson({ isRunning: true, fullOutput: '', thinking: false }),
      );
      for (const k of Object.keys(splitMessagesByCli)) delete splitMessagesByCli[k];
      splitMessagesRefresh.mockClear();
    });

    it('renders a HistoryPane inside the split', async () => {
      render(
        <TerminalSplitPaneContent
          worktreeId="w-1"
          splitIndex={0}
          cliToolId="claude"
          availableInstances={[inst('claude')]}
          onInstanceChange={vi.fn()}
          onFocus={vi.fn()}
          autoYes={{ onToggle: vi.fn() }}
        />,
      );
      const pane = await screen.findByTestId('history-pane');
      expect(pane).toBeInTheDocument();
      // splitIndex flows through for per-split highlight namespace.
      expect(pane.getAttribute('data-split-index')).toBe('0');
      // cliToolId flows through (metadata).
      expect(pane.getAttribute('data-cli-tool-id')).toBe('claude');
    });

    it('passes this split cliToolId messages (from useSplitMessages) to HistoryPane', async () => {
      splitMessagesByCli['codex'] = [
        { id: 'm1', content: 'codex one' },
        { id: 'm2', content: 'codex two' },
      ];
      render(
        <TerminalSplitPaneContent
          worktreeId="w-1"
          splitIndex={1}
          cliToolId="codex"
          availableInstances={[inst('claude'), inst('codex')]}
          onInstanceChange={vi.fn()}
          onFocus={vi.fn()}
          autoYes={{ onToggle: vi.fn() }}
        />,
      );
      const pane = await screen.findByTestId('history-pane');
      expect(pane.getAttribute('data-cli-tool-id')).toBe('codex');
      expect(pane.getAttribute('data-message-count')).toBe('2');
    });

    it('shows each split its OWN cliToolId messages simultaneously (A=claude, B=codex)', async () => {
      splitMessagesByCli['claude'] = [{ id: 'c1', content: 'claude msg' }];
      splitMessagesByCli['codex'] = [
        { id: 'x1', content: 'codex msg a' },
        { id: 'x2', content: 'codex msg b' },
      ];
      render(
        <>
          <TerminalSplitPaneContent
            worktreeId="w-1"
            splitIndex={0}
            cliToolId="claude"
            availableInstances={[inst('claude'), inst('codex')]}
            onInstanceChange={vi.fn()}
            onFocus={vi.fn()}
            autoYes={{ onToggle: vi.fn() }}
          />
          <TerminalSplitPaneContent
            worktreeId="w-1"
            splitIndex={1}
            cliToolId="codex"
            availableInstances={[inst('claude'), inst('codex')]}
            onInstanceChange={vi.fn()}
            onFocus={vi.fn()}
            autoYes={{ onToggle: vi.fn() }}
          />
        </>,
      );
      const panes = await screen.findAllByTestId('history-pane');
      expect(panes).toHaveLength(2);
      const claudePane = panes.find(p => p.getAttribute('data-cli-tool-id') === 'claude');
      const codexPane = panes.find(p => p.getAttribute('data-cli-tool-id') === 'codex');
      expect(claudePane?.getAttribute('data-message-count')).toBe('1');
      expect(codexPane?.getAttribute('data-message-count')).toBe('2');
      // Distinct namespaces per split index.
      expect(claudePane?.getAttribute('data-split-index')).toBe('0');
      expect(codexPane?.getAttribute('data-split-index')).toBe('1');
    });

    it('routes HistoryPane onInsertToMessage through this split onHistoryInsertToMessage handler', async () => {
      const onHistoryInsertToMessage = vi.fn();
      render(
        <TerminalSplitPaneContent
          worktreeId="w-1"
          splitIndex={2}
          cliToolId="claude"
          availableInstances={[inst('claude')]}
          onInstanceChange={vi.fn()}
          onFocus={vi.fn()}
          autoYes={{ onToggle: vi.fn() }}
          history={{ onInsertToMessage: onHistoryInsertToMessage }}
        />,
      );
      const insertBtn = await screen.findByTestId('history-insert');
      await act(async () => {
        insertBtn.click();
        await Promise.resolve();
      });
      // The split forwards the insert to its own (splitIndex-bound) handler.
      // The parent closes the loop by setting pendingInsertTextMap.set(2, text).
      expect(onHistoryInsertToMessage).toHaveBeenCalledTimes(1);
      expect(onHistoryInsertToMessage).toHaveBeenCalledWith('inserted-from-history');
    });

    it('forwards pendingInsertText to this split MessageInput (parent-closed loop)', async () => {
      render(
        <TerminalSplitPaneContent
          worktreeId="w-1"
          splitIndex={2}
          cliToolId="claude"
          availableInstances={[inst('claude')]}
          onInstanceChange={vi.fn()}
          onFocus={vi.fn()}
          autoYes={{ onToggle: vi.fn() }}
          pendingInsertText="from-parent"
        />,
      );
      const input = await screen.findByTestId('message-input-2');
      expect(input.getAttribute('data-pending-insert')).toBe('from-parent');
    });
  });
});
