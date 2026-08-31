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

/**
 * The request inits sent to `url`, in call order. Matched by PREFIX because the
 * count read carries the calling worktree as a query parameter.
 */
function callsTo(url: string): RequestInit[] {
  return mockFetch.mock.calls
    .filter((call) => typeof call[0] === 'string' && (call[0] as string).startsWith(url))
    .map((call) => (call[1] ?? {}) as RequestInit);
}

/** The POSTs to the apply route — the requests that actually write. */
function applyPosts(): RequestInit[] {
  return callsTo(APPLY_DEFAULT_AGENTS_ENDPOINT).filter((init) => init.method === 'POST');
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
      // Bounded to the worktree the pane is rendered for, not to the install.
      expect(mockFetch.mock.calls[0][0]).toBe(
        `${APPLY_DEFAULT_AGENTS_ENDPOINT}?worktreeId=w-2067`,
      );
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
    it('confirms first, then POSTs the roster for this worktree', async () => {
      mockFetch.mockResolvedValue(jsonOk({ success: true, eligible: 3 }));
      renderPane([primary('codex', 0), primary('claude', 1)]);
      await openDefaults();

      expect(screen.getByTestId('agent-defaults-eligible')).toHaveAttribute('data-count', '3');

      fireEvent.click(screen.getByTestId('agent-defaults-apply'));

      // The dialog is the gate: nothing has been written yet.
      const confirmButton = await screen.findByTestId('confirm-dialog-confirm');
      expect(applyPosts()).toHaveLength(0);

      mockFetch.mockResolvedValue(
        jsonOk({ success: true, updated: 3, updatedIds: ['a', 'b', 'c'], eligible: 0 }),
      );
      fireEvent.click(confirmButton);

      await screen.findByTestId('agent-defaults-applied');
      expect(applyPosts()).toHaveLength(1);
      expect(JSON.parse(applyPosts()[0].body as string)).toEqual({
        worktreeId: 'w-2067',
        agents: ['codex', 'claude'],
      });
    });

    it('reports the rows the SERVER says it wrote, not the count it previewed', async () => {
      // The badge has to survive a divergence: the preview is a separate HTTP
      // request, so a sync landing between it and the confirmation makes the two
      // numbers differ, and only the server's `updated` describes reality. An
      // earlier version of this test mocked 3 and 3 and could not tell the two
      // apart — nor could it tell either from the post-apply `eligible`.
      mockFetch.mockResolvedValue(jsonOk({ success: true, eligible: 3 }));
      renderPane([primary('codex', 0), primary('claude', 1)]);
      await openDefaults();
      expect(screen.getByTestId('agent-defaults-eligible')).toHaveAttribute('data-count', '3');

      fireEvent.click(screen.getByTestId('agent-defaults-apply'));
      const confirmButton = await screen.findByTestId('confirm-dialog-confirm');

      mockFetch.mockResolvedValue(
        jsonOk({ success: true, updated: 5, updatedIds: ['a', 'b', 'c', 'd', 'e'], eligible: 1 }),
      );
      fireEvent.click(confirmButton);

      const applied = await screen.findByTestId('agent-defaults-applied');
      expect(applied).toHaveAttribute('data-count', '5');
      // …and the remaining count is the server's, not the applied number.
      expect(screen.getByTestId('agent-defaults-eligible')).toHaveAttribute('data-count', '1');
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
      expect(applyPosts()).toHaveLength(0);
      expect(screen.queryByTestId('agent-defaults-applied')).toBeNull();
    });

    it('offers nothing to apply, and asks nothing, when no branch is eligible', async () => {
      mockFetch.mockResolvedValue(jsonOk({ success: true, eligible: 0 }));
      renderPane([primary('codex', 0), primary('claude', 1)]);
      await openDefaults();

      expect(screen.getByTestId('agent-defaults-eligible')).toHaveAttribute('data-count', '0');
      expect(screen.getByTestId('agent-defaults-apply')).toBeDisabled();
    });

    it('shows an error, disables the apply, and offers a retry when the read fails', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
      renderPane([primary('codex', 0), primary('claude', 1)]);
      fireEvent.click(screen.getByTestId('agent-defaults-toggle'));

      expect(await screen.findByTestId('agent-defaults-error')).toBeInTheDocument();
      expect(screen.getByTestId('agent-defaults-eligible')).not.toHaveAttribute('data-count');
      // An unknown count is not a number to act on: the button used to stay
      // enabled and then return with no dialog and no new message.
      expect(screen.getByTestId('agent-defaults-apply')).toBeDisabled();
    });

    it('recovers from a failed read through the retry control', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
      renderPane([primary('codex', 0), primary('claude', 1)]);
      fireEvent.click(screen.getByTestId('agent-defaults-toggle'));
      await screen.findByTestId('agent-defaults-retry');

      mockFetch.mockResolvedValue(jsonOk({ success: true, eligible: 2 }));
      fireEvent.click(screen.getByTestId('agent-defaults-retry'));

      await waitFor(() =>
        expect(screen.getByTestId('agent-defaults-eligible')).toHaveAttribute('data-count', '2'),
      );
      expect(screen.queryByTestId('agent-defaults-error')).toBeNull();
      expect(screen.getByTestId('agent-defaults-apply')).toBeEnabled();
    });
  });

  describe('a repository that declares its agents (#2066)', () => {
    it('explains why the apply is off instead of showing an unaccountable zero', async () => {
      mockFetch.mockResolvedValue(
        jsonOk({
          success: true,
          eligible: 0,
          repositoryName: 'CommandMate',
          repoDeclaresAgents: true,
        }),
      );
      renderPane([primary('codex', 0), primary('claude', 1)]);
      fireEvent.click(screen.getByTestId('agent-defaults-toggle'));

      expect(await screen.findByTestId('agent-defaults-repo-declared')).toBeInTheDocument();
      expect(screen.getByTestId('agent-defaults-apply')).toBeDisabled();
      // The count line would say "0 branches" and mean something else entirely.
      expect(screen.queryByTestId('agent-defaults-eligible')).toBeNull();
    });

    it('still allows saving the order as the server-wide default', async () => {
      mockFetch.mockResolvedValue(
        jsonOk({ success: true, eligible: 0, repoDeclaresAgents: true }),
      );
      renderPane([primary('codex', 0), primary('claude', 1)]);
      fireEvent.click(screen.getByTestId('agent-defaults-toggle'));
      await screen.findByTestId('agent-defaults-repo-declared');

      // #2066 governs which agents this repository's branches OPEN with; the
      // #2065 setting is about branches discovered anywhere later. Disabling the
      // second because of the first would be a different, wrong rule.
      expect(screen.getByTestId('agent-defaults-set-default')).toBeEnabled();
    });

    it('names the repository the action is bounded to', async () => {
      mockFetch.mockResolvedValue(
        jsonOk({
          success: true,
          eligible: 4,
          repositoryName: 'CommandMate',
          repoDeclaresAgents: false,
        }),
      );
      renderPane([primary('codex', 0), primary('claude', 1)]);
      await openDefaults();

      // `data-repository`, not the rendered sentence: the global next-intl mock
      // echoes the key and drops interpolated params, so a text assertion here
      // would pass with the name missing.
      expect(screen.getByTestId('agent-defaults-repository')).toHaveAttribute(
        'data-repository',
        'CommandMate',
      );
    });
  });
});
