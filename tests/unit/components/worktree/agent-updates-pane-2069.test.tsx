/**
 * The update section inside the roster editor (Issue #2069).
 *
 * The property under test is a **cost** one, and it is the reason the section
 * is behind a disclosure at all: #2054 established that a roster of claude and
 * codex panes issues zero requests, and that criterion is about the request log
 * rather than the pixels. Mounting the update card runs a `--version` fan-out
 * plus a worktree read, so a section that rendered eagerly would break that
 * invariant on every worktree, for every user, whether or not they cared what
 * version they were on.
 *
 * next-intl resolves through the REAL `locales/en/common.json` so the toggle's
 * label is proof the key exists rather than proof a mock echoes.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AgentInstancesPane } from '@/components/worktree/AgentInstancesPane';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';
import { getCliToolDisplayName, type AgentInstance, type CLIToolType } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

beforeAll(() => installRadixJsdomPolyfills());

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function primary(cliTool: CLIToolType, order: number): AgentInstance {
  return { id: cliTool, cliTool, alias: getCliToolDisplayName(cliTool), order };
}

const VERSIONS = {
  status: 'success',
  updatable: ['codex'],
  tools: [
    {
      tool: 'codex',
      installed: '0.149.1',
      latestVersion: '0.151.0',
      dismissedVersion: null,
      updateAvailable: true,
      dismissedInCodex: false,
      updatable: true,
      source: 'version.json',
    },
  ],
};

const paneProps = {
  worktreeId: 'w-2069',
  onInstancesChange: vi.fn(),
  vibeLocalModel: null as string | null,
  onVibeLocalModelChange: vi.fn(),
  vibeLocalContextWindow: null as number | null,
  onVibeLocalContextWindowChange: vi.fn(),
};

function renderPane() {
  return render(
    <ConfirmProvider>
      <AgentInstancesPane
        {...paneProps}
        instances={[primary('claude', 0), primary('codex', 1)]}
        // Supplied so #2054's own read stays off; the only fetches this test can
        // see are the ones the update section makes.
        sourceByInstance={{}}
      />
    </ConfirmProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/agents/versions')) {
      return { ok: true, json: () => Promise.resolve(VERSIONS) };
    }
    return { ok: true, json: () => Promise.resolve({ sessionStatusByInstance: {} }) };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('[#2069] the update section in AgentInstancesPane', () => {
  it('offers the section without fetching anything (#2054 zero-request invariant)', async () => {
    renderPane();

    expect(screen.getByTestId('agent-updates-toggle')).toBeInTheDocument();
    // Give any stray effect a turn to fire before concluding it did not.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('starts collapsed, so the card is not mounted', () => {
    renderPane();
    expect(screen.getByTestId('agent-updates-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('agent-updates')).toBeNull();
  });

  it('reads the versions only once the user opens it', async () => {
    renderPane();
    fireEvent.click(screen.getByTestId('agent-updates-toggle'));

    await waitFor(() => {
      expect(screen.getByTestId('agent-updates-installed-codex')).toHaveTextContent('0.149.1');
    });
    const urls = mockFetch.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain('/api/agents/versions');
  });

  it('carries the worktree id through, so the restart is instance-scoped', async () => {
    renderPane();
    fireEvent.click(screen.getByTestId('agent-updates-toggle'));

    await waitFor(() => {
      const urls = mockFetch.mock.calls.map((call) => String(call[0]));
      expect(urls).toContain('/api/worktrees/w-2069');
    });
  });

  it('collapses again, and mounts nothing while closed', async () => {
    renderPane();
    const toggle = screen.getByTestId('agent-updates-toggle');

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId('agent-updates')).toBeInTheDocument());

    fireEvent.click(toggle);
    expect(screen.queryByTestId('agent-updates')).toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('leaves the roster editor itself untouched (#2067 shares this file)', () => {
    renderPane();
    // The controls #2067 is editing must still be exactly where they were.
    expect(screen.getByTestId('agent-instances-pane')).toBeInTheDocument();
    expect(screen.getByTestId('agent-instance-row-claude')).toBeInTheDocument();
    expect(screen.getByTestId('agent-instance-row-codex')).toBeInTheDocument();
    expect(screen.getByTestId('agent-instance-add')).toBeInTheDocument();
    expect(screen.getByTestId('agent-instance-add-tool')).toBeInTheDocument();
  });
});
