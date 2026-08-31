/**
 * The agent pane's "make this the default" panel (Issue #2067).
 *
 * Three things this covers that the hook's own suite cannot: that the panel
 * costs NOTHING until it is opened (#2054's zero-request criterion for this
 * pane, which a count fetched on mount would break for every worktree in the
 * install), that the bulk apply is gated behind the shared ConfirmDialog, and
 * that the number the user is shown is the number the server reports writing.
 *
 * Counts are asserted through `data-count` rather than through rendered text:
 * the global next-intl mock echoes the key back and drops interpolated params,
 * so `getByText('3 branches')` would be a test of the mock.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentInstancesPane } from '@/components/worktree/AgentInstancesPane';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';
import { APPLY_DEFAULT_AGENTS_ENDPOINT } from '@/hooks/useAgentDefaults';
import {
  DEFAULT_AGENTS_ENDPOINT,
  resetClientDefaultSelectedAgents,
} from '@/config/default-agents';
import { getCliToolDisplayName, type AgentInstance, type CLIToolType } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

beforeAll(() => installRadixJsdomPolyfills());

function primary(cliTool: CLIToolType, order: number): AgentInstance {
  return { id: cliTool, cliTool, alias: getCliToolDisplayName(cliTool), order };
}

const baseProps = {
  worktreeId: 'w-2067',
  onInstancesChange: vi.fn(),
  vibeLocalModel: null as string | null,
  onVibeLocalModelChange: vi.fn(),
  vibeLocalContextWindow: null as number | null,
  onVibeLocalContextWindowChange: vi.fn(),
};

function jsonOk(body: unknown) {
  return { ok: true, json: () => Promise.resolve(body) };
}

function renderPane(instances: AgentInstance[]) {
  return render(
    <ConfirmProvider>
      <AgentInstancesPane {...baseProps} instances={instances} />
    </ConfirmProvider>,
  );
}

/** Open the disclosure and wait for the count it reads on the way open. */
async function openDefaults(): Promise<void> {
  fireEvent.click(screen.getByTestId('agent-defaults-toggle'));
  await screen.findByTestId('agent-defaults-section');
  await waitFor(() =>
    expect(screen.getByTestId('agent-defaults-eligible')).toHaveAttribute('data-count'),
  );
}

/** The request bodies, by URL, in call order. */
function callsTo(url: string): RequestInit[] {
  return mockFetch.mock.calls
    .filter((call) => call[0] === url)
    .map((call) => (call[1] ?? {}) as RequestInit);
}

describe('AgentInstancesPane defaults panel (Issue #2067)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetClientDefaultSelectedAgents();
    mockFetch.mockResolvedValue(jsonOk({ success: true, eligible: 0 }));
  });

  afterEach(() => {
    resetClientDefaultSelectedAgents();
    resetClientDefaultSelectedAgents();
  });

  describe('cost of being on screen', () => {
    it('issues no request at all while the panel is closed', () => {
      renderPane([primary('claude', 0), primary('codex', 1)]);
      expect(screen.queryByTestId('agent-defaults-section')).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('reads the eligible count once, when the panel is opened', async () => {
      mockFetch.mockResolvedValue(jsonOk({ success: true, eligible: 7 }));
      renderPane([primary('claude', 0), primary('codex', 1)]);
      await openDefaults();

      expect(callsTo(APPLY_DEFAULT_AGENTS_ENDPOINT)).toHaveLength(1);
      expect(screen.getByTestId('agent-defaults-eligible')).toHaveAttribute('data-count', '7');
    });
  });

  describe('"make this the default"', () => {
    it('PUTs the roster TOOL order to the settings endpoint the More screen reads', async () => {
      mockFetch.mockResolvedValue(jsonOk({ success: true, eligible: 0 }));
      renderPane([primary('codex', 0), primary('claude', 1)]);
      await openDefaults();

      mockFetch.mockResolvedValue(
        jsonOk({ success: true, defaultSelectedAgents: ['codex', 'claude'], configured: true }),
      );
      fireEvent.click(screen.getByTestId('agent-defaults-set-default'));

      await waitFor(() => expect(callsTo(DEFAULT_AGENTS_ENDPOINT)).toHaveLength(1));
      const [init] = callsTo(DEFAULT_AGENTS_ENDPOINT);
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body as string)).toEqual({ agents: ['codex', 'claude'] });
      expect(await screen.findByTestId('agent-defaults-saved')).toBeInTheDocument();
    });

    it('collapses several instances of one tool into a single default entry', async () => {
      mockFetch.mockResolvedValue(jsonOk({ success: true, eligible: 0 }));
      renderPane([
        { id: 'claude', cliTool: 'claude', alias: 'Primary', order: 0 },
        { id: 'claude-2', cliTool: 'claude', alias: 'Review', order: 1 },
        primary('codex', 2),
      ]);
      await openDefaults();

      mockFetch.mockResolvedValue(
        jsonOk({ success: true, defaultSelectedAgents: ['claude', 'codex'] }),
      );
      fireEvent.click(screen.getByTestId('agent-defaults-set-default'));

      await waitFor(() => expect(callsTo(DEFAULT_AGENTS_ENDPOINT)).toHaveLength(1));
      expect(JSON.parse(callsTo(DEFAULT_AGENTS_ENDPOINT)[0].body as string)).toEqual({
        agents: ['claude', 'codex'],
      });
    });

    it('disables both actions when the roster has fewer than two distinct tools', async () => {
      mockFetch.mockResolvedValue(jsonOk({ success: true, eligible: 3 }));
      renderPane([
        { id: 'claude', cliTool: 'claude', alias: 'Primary', order: 0 },
        { id: 'claude-2', cliTool: 'claude', alias: 'Review', order: 1 },
      ]);
      await openDefaults();

      expect(screen.getByTestId('agent-defaults-invalid')).toBeInTheDocument();
      expect(screen.getByTestId('agent-defaults-set-default')).toBeDisabled();
      expect(screen.getByTestId('agent-defaults-apply')).toBeDisabled();
    });
  });

  describe('"apply to unchanged branches"', () => {
    it('confirms first, then POSTs, and the applied count matches what was shown', async () => {
      mockFetch.mockResolvedValue(jsonOk({ success: true, eligible: 3 }));
      renderPane([primary('codex', 0), primary('claude', 1)]);
      await openDefaults();

      const previewed = screen.getByTestId('agent-defaults-eligible').getAttribute('data-count');
      expect(previewed).toBe('3');

      fireEvent.click(screen.getByTestId('agent-defaults-apply'));

      // The dialog is the gate: nothing has been written yet.
      const confirmButton = await screen.findByTestId('confirm-dialog-confirm');
      expect(
        callsTo(APPLY_DEFAULT_AGENTS_ENDPOINT).filter((init) => init.method === 'POST'),
      ).toHaveLength(0);

      mockFetch.mockResolvedValue(
        jsonOk({ success: true, updated: 3, updatedIds: ['a', 'b', 'c'], eligible: 0 }),
      );
      fireEvent.click(confirmButton);

      const applied = await screen.findByTestId('agent-defaults-applied');
      expect(applied).toHaveAttribute('data-count', previewed!);

      const posts = callsTo(APPLY_DEFAULT_AGENTS_ENDPOINT).filter(
        (init) => init.method === 'POST',
      );
      expect(posts).toHaveLength(1);
      expect(JSON.parse(posts[0].body as string)).toEqual({ agents: ['codex', 'claude'] });
    });

    it('re-reads the count at the moment of the click, so the dialog is never stale', async () => {
      mockFetch.mockResolvedValue(jsonOk({ success: true, eligible: 3 }));
      renderPane([primary('codex', 0), primary('claude', 1)]);
      await openDefaults();

      // A sync discovered two more branches while the panel sat open.
      mockFetch.mockResolvedValue(jsonOk({ success: true, eligible: 5 }));
      fireEvent.click(screen.getByTestId('agent-defaults-apply'));
      await screen.findByTestId('confirm-dialog-confirm');

      expect(screen.getByTestId('agent-defaults-eligible')).toHaveAttribute('data-count', '5');
    });

    it('writes nothing when the confirmation is cancelled', async () => {
      mockFetch.mockResolvedValue(jsonOk({ success: true, eligible: 3 }));
      renderPane([primary('codex', 0), primary('claude', 1)]);
      await openDefaults();

      fireEvent.click(screen.getByTestId('agent-defaults-apply'));
      fireEvent.click(await screen.findByTestId('confirm-dialog-cancel'));

      await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
      expect(
        callsTo(APPLY_DEFAULT_AGENTS_ENDPOINT).filter((init) => init.method === 'POST'),
      ).toHaveLength(0);
      expect(screen.queryByTestId('agent-defaults-applied')).toBeNull();
    });

    it('offers nothing to apply, and asks nothing, when no branch is eligible', async () => {
      mockFetch.mockResolvedValue(jsonOk({ success: true, eligible: 0 }));
      renderPane([primary('codex', 0), primary('claude', 1)]);
      await openDefaults();

      expect(screen.getByTestId('agent-defaults-eligible')).toHaveAttribute('data-count', '0');
      expect(screen.getByTestId('agent-defaults-apply')).toBeDisabled();
    });

    it('shows an error and stays silent about a count when the read fails', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
      renderPane([primary('codex', 0), primary('claude', 1)]);
      fireEvent.click(screen.getByTestId('agent-defaults-toggle'));

      expect(await screen.findByTestId('agent-defaults-error')).toBeInTheDocument();
      expect(screen.getByTestId('agent-defaults-eligible')).not.toHaveAttribute('data-count');
    });
  });
});
