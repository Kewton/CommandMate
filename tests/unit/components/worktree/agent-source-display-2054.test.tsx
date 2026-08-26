/**
 * Telling the operator what is reading the pane (Issue #2054).
 *
 * The state this Issue exists for is invisible by construction: when opencode's
 * event stream dies the terminal frame looks exactly the same, the agent keeps
 * drawing, and CommandMate silently falls back to reading the screen. Two
 * surfaces have to say so — the header pill's tooltip and the roster row — and
 * both must say **nothing at all** for a tool whose source cannot be degraded,
 * which is every tool but opencode today.
 *
 * next-intl is mocked with the REAL `locales/en/*.json` rather than the echo
 * mock in `tests/setup.ts`: the echo mock drops interpolation parameters, so an
 * assertion that the reason reached the string would pass with the reason never
 * substituted.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AgentInstancesPane } from '@/components/worktree/AgentInstancesPane';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';
import {
  DesktopHeader,
  formatAgentSourceLabel,
  isAgentSourceDegraded,
} from '@/components/worktree/WorktreeDetailSubComponents';
import { getCliToolDisplayName, type AgentInstance, type CLIToolType } from '@/lib/cli-tools/types';
import type { AgentEventSourceView, Worktree } from '@/types/models';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

beforeAll(() => installRadixJsdomPolyfills());

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function primary(cliTool: CLIToolType, order: number, alias?: string): AgentInstance {
  return { id: cliTool, cliTool, alias: alias ?? getCliToolDisplayName(cliTool), order };
}

/** The measured degradation: another process took opencode's port. */
const STOLEN: AgentEventSourceView = {
  kind: 'scraper',
  liveness: 'stale',
  degradedReason: 'port_identity_changed',
};
const LIVE_SSE: AgentEventSourceView = { kind: 'sse', liveness: 'live' };

const paneProps = {
  worktreeId: 'w-2054',
  onInstancesChange: vi.fn(),
  vibeLocalModel: null as string | null,
  onVibeLocalModelChange: vi.fn(),
  vibeLocalContextWindow: null as number | null,
  onVibeLocalContextWindowChange: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// The formatter both surfaces share
// =============================================================================

describe('[#2054] formatAgentSourceLabel', () => {
  const t = ((key: string, values?: Record<string, string>) =>
    values ? `${key}(${JSON.stringify(values)})` : key) as never;

  it('says nothing when the server published nothing degradable', () => {
    expect(formatAgentSourceLabel(undefined, t)).toBeNull();
    expect(formatAgentSourceLabel(null, t)).toBeNull();
    // A push tool's block: a kind and neither of the two fields only a
    // subscription can fill in. Rendering it would put a line on every pane.
    expect(formatAgentSourceLabel({ kind: 'hooks' }, t)).toBeNull();
    expect(formatAgentSourceLabel({ kind: 'scraper' }, t)).toBeNull();
  });

  it('renders a reason it has never heard of rather than a key path', () => {
    // A future transport can record a token this build has no message for. A
    // dynamic `t(\`agentSource.reason.${x}\`)` would print the path at the user.
    const line = formatAgentSourceLabel(
      { kind: 'scraper', liveness: 'stale', degradedReason: 'some_future_token' },
      t
    );
    expect(line).toContain('reasonOther');
    expect(line).toContain('some_future_token');
  });

  it('calls everything but a live SSE stream degraded', () => {
    expect(isAgentSourceDegraded(LIVE_SSE)).toBe(false);
    expect(isAgentSourceDegraded(STOLEN)).toBe(true);
    expect(isAgentSourceDegraded({ kind: 'sse', liveness: 'stale' })).toBe(true);
    expect(isAgentSourceDegraded({ kind: 'scraper', degradedReason: 'not_subscribed' })).toBe(true);
    // Nothing published is not a problem — it is a tool that was never asked.
    expect(isAgentSourceDegraded(undefined)).toBe(false);
  });
});

// =============================================================================
// The header pill's tooltip
// =============================================================================

describe('[#2054] DesktopHeader instance status pill', () => {
  const baseProps = {
    worktreeName: 'feature/2054',
    repositoryName: 'CommandMate',
    status: 'idle' as const,
    onBackClick: vi.fn(),
    onInfoClick: vi.fn(),
  };

  function statusMap(
    instanceId: string,
    eventSource?: AgentEventSourceView
  ): NonNullable<Worktree['sessionStatusByInstance']> {
    return {
      [instanceId]: {
        isRunning: true,
        isWaitingForResponse: false,
        isProcessing: true,
        ...(eventSource ? { eventSource } : {}),
      },
    };
  }

  it('names the degradation and the reason in the tooltip', () => {
    render(
      <DesktopHeader
        {...baseProps}
        instances={[primary('opencode', 0, 'opencode')]}
        sessionStatusByInstance={statusMap('opencode', STOLEN)}
      />
    );

    const pill = screen.getByTestId('desktop-agent-status-opencode');
    const title = pill.getAttribute('title') ?? '';
    expect(title).toContain('another process took the port');
    expect(title).toContain('screen scrape');
    // Real sentences from the dictionary, not keys echoed back.
    expect(title).not.toContain('agentSource.');
    expect(pill.getAttribute('aria-label')).toBe(title);
  });

  it('spends no row width on it — the visible pill text is unchanged', () => {
    const { rerender } = render(
      <DesktopHeader
        {...baseProps}
        instances={[primary('opencode', 0, 'opencode')]}
        sessionStatusByInstance={statusMap('opencode')}
      />
    );
    const before = screen.getByTestId('desktop-agent-status-opencode').textContent;

    rerender(
      <DesktopHeader
        {...baseProps}
        instances={[primary('opencode', 0, 'opencode')]}
        sessionStatusByInstance={statusMap('opencode', STOLEN)}
      />
    );

    expect(screen.getByTestId('desktop-agent-status-opencode').textContent).toBe(before);
  });

  it('leaves claude and codex byte-identical to pre-#2054', () => {
    // Acceptance criterion 2, at the pixel. A hook tool publishes no
    // `eventSource` at all, and the label must be the string #1783 left.
    for (const tool of ['claude', 'codex'] as const) {
      const { unmount } = render(
        <DesktopHeader
          {...baseProps}
          instances={[primary(tool, 0, getCliToolDisplayName(tool))]}
          sessionStatusByInstance={statusMap(tool)}
        />
      );
      const pill = screen.getByTestId(`desktop-agent-status-${tool}`);
      expect(pill.getAttribute('aria-label')).toBe(
        `${getCliToolDisplayName(tool)}: Running`
      );
      unmount();
    }
  });

  it('reports a healthy stream too, so "no line" never means "not checked"', () => {
    render(
      <DesktopHeader
        {...baseProps}
        instances={[primary('opencode', 0, 'opencode')]}
        sessionStatusByInstance={statusMap('opencode', LIVE_SSE)}
      />
    );

    const title = screen.getByTestId('desktop-agent-status-opencode').getAttribute('title') ?? '';
    expect(title).toContain('SSE');
    expect(title).toContain('connected');
  });
});

// =============================================================================
// The roster row
// =============================================================================

describe('[#2054] AgentInstancesPane warning row', () => {
  function renderPane(
    instances: AgentInstance[],
    sourceByInstance?: Readonly<Partial<Record<string, AgentEventSourceView>>>
  ) {
    return render(
      <ConfirmProvider>
        <AgentInstancesPane {...paneProps} instances={instances} sourceByInstance={sourceByInstance} />
      </ConfirmProvider>
    );
  }

  it('warns on the row whose stream was taken away', () => {
    renderPane([primary('claude', 0), primary('opencode', 1)], { opencode: STOLEN });

    const row = screen.getByTestId('agent-instance-source-opencode');
    expect(row.textContent).toContain('another process took the port');
    expect(row.className).toContain('text-warning');
    expect(row.getAttribute('title')).toBe('Structured events are not arriving');
  });

  it('renders no such row for a tool that publishes no eventSource', () => {
    renderPane([primary('claude', 0), primary('codex', 1)], {});

    expect(screen.queryByTestId('agent-instance-source-claude')).toBeNull();
    expect(screen.queryByTestId('agent-instance-source-codex')).toBeNull();
  });

  it('reports a healthy stream without the warning styling', () => {
    renderPane([primary('opencode', 0)], { opencode: LIVE_SSE });

    const row = screen.getByTestId('agent-instance-source-opencode');
    expect(row.className).toContain('text-muted-foreground');
    expect(row.className).not.toContain('text-warning');
    expect(row.getAttribute('title')).toBe('Receiving structured events');
  });

  it('issues no request at all for a roster with no subscription source', async () => {
    // The cost half of "claude / codex は不変": a worktree of hook tools must not
    // start polling because this Issue landed.
    renderPane([primary('claude', 0), primary('codex', 1)]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('reads the status map itself when the caller supplies none', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          sessionStatusByInstance: {
            opencode: { isRunning: true, isWaitingForResponse: false, isProcessing: false, eventSource: STOLEN },
          },
        }),
    });

    renderPane([primary('opencode', 0)]);

    await waitFor(() =>
      expect(screen.getByTestId('agent-instance-source-opencode').textContent).toContain(
        'another process took the port'
      )
    );
    expect(mockFetch).toHaveBeenCalledWith('/api/worktrees/w-2054');
  });

  it('does not read when the caller supplies the map', async () => {
    renderPane([primary('opencode', 0)], { opencode: LIVE_SSE });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
