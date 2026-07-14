/**
 * Tests for AgentInstancesPane (Issue #869)
 *
 * The PC instance-management UI: add / rename / delete / reorder agent
 * instances (including multiple instances of the SAME CLI tool), bounded to
 * MIN_AGENT_INSTANCES..MAX_AGENT_INSTANCES, persisted via PATCH
 * /api/worktrees/[id] with `{ agentInstances }` (order normalized to index).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentInstancesPane } from '@/components/worktree/AgentInstancesPane';
import {
  MAX_AGENT_INSTANCES,
  getCliToolDisplayName,
  type AgentInstance,
  type CLIToolType,
} from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// Issue #1130: reorder/delete now live in a Radix DropdownMenu kebab. Open a
// row's menu (keyboard-open is the reliable path in jsdom) so its items mount.
function openRowMenu(id: string): void {
  fireEvent.keyDown(screen.getByTestId(`agent-instance-menu-${id}`), { key: 'Enter' });
}

beforeAll(() => installRadixJsdomPolyfills());

/** Build a primary AgentInstance (id === cliTool). */
function primary(cliTool: CLIToolType, order: number, alias?: string): AgentInstance {
  return { id: cliTool, cliTool, alias: alias ?? getCliToolDisplayName(cliTool), order };
}

const baseProps = {
  worktreeId: 'w-1',
  onInstancesChange: vi.fn(),
  vibeLocalModel: null as string | null,
  onVibeLocalModelChange: vi.fn(),
  vibeLocalContextWindow: null as number | null,
  onVibeLocalContextWindowChange: vi.fn(),
};

/** Parse the JSON body sent on the Nth PATCH call. */
function patchBody(callIndex = 0): { agentInstances: AgentInstance[] } {
  const init = mockFetch.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(init.body as string);
}

describe('AgentInstancesPane (Issue #869)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('renders one row per instance with its alias and base-tool name', () => {
      render(
        <AgentInstancesPane
          {...baseProps}
          instances={[primary('claude', 0), primary('codex', 1)]}
        />,
      );
      expect(screen.getByTestId('agent-instances-pane')).toBeInTheDocument();
      expect(screen.getByTestId('agent-instance-row-claude')).toBeInTheDocument();
      expect(screen.getByTestId('agent-instance-row-codex')).toBeInTheDocument();
      expect((screen.getByTestId('agent-instance-alias-claude') as HTMLInputElement).value).toBe(
        'Claude',
      );
    });

    it('renders two instances of the SAME CLI tool with distinct ids/aliases', () => {
      render(
        <AgentInstancesPane
          {...baseProps}
          instances={[
            { id: 'claude', cliTool: 'claude', alias: 'Primary', order: 0 },
            { id: 'claude-2', cliTool: 'claude', alias: 'Review', order: 1 },
          ]}
        />,
      );
      expect((screen.getByTestId('agent-instance-alias-claude') as HTMLInputElement).value).toBe(
        'Primary',
      );
      expect((screen.getByTestId('agent-instance-alias-claude-2') as HTMLInputElement).value).toBe(
        'Review',
      );
    });
  });

  describe('add instance', () => {
    it('PATCHes the roster with the new instance and reports it via onInstancesChange', async () => {
      const onInstancesChange = vi.fn();
      render(
        <AgentInstancesPane
          {...baseProps}
          onInstancesChange={onInstancesChange}
          instances={[primary('claude', 0)]}
        />,
      );
      // addToolId defaults to CLI_TOOL_IDS[0] = 'claude'. Pick a different tool.
      fireEvent.change(screen.getByTestId('agent-instance-add-tool'), {
        target: { value: 'codex' },
      });
      fireEvent.click(screen.getByTestId('agent-instance-add'));

      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/worktrees/w-1');
      expect((init as RequestInit).method).toBe('PATCH');
      const body = patchBody();
      expect(body.agentInstances.map((i) => i.id)).toEqual(['claude', 'codex']);
      expect(body.agentInstances.map((i) => i.order)).toEqual([0, 1]);
      await waitFor(() =>
        expect(onInstancesChange).toHaveBeenCalledWith(body.agentInstances),
      );
    });

    it('adding the SAME tool again allocates a {tool}-2 id (Claude × 2 registerable)', async () => {
      render(
        <AgentInstancesPane {...baseProps} instances={[primary('claude', 0)]} />,
      );
      // Select defaults to 'claude'; adding again must not collide with the primary id.
      fireEvent.click(screen.getByTestId('agent-instance-add'));
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      const body = patchBody();
      expect(body.agentInstances.map((i) => i.id)).toEqual(['claude', 'claude-2']);
      expect(body.agentInstances[1].cliTool).toBe('claude');
    });
  });

  describe('rename instance', () => {
    it('commits an alias edit on blur and PATCHes the updated alias', async () => {
      render(
        <AgentInstancesPane
          {...baseProps}
          instances={[primary('claude', 0, 'Claude'), primary('codex', 1)]}
        />,
      );
      const input = screen.getByTestId('agent-instance-alias-claude');
      fireEvent.change(input, { target: { value: 'Claude (review)' } });
      fireEvent.blur(input);

      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      const body = patchBody();
      expect(body.agentInstances.find((i) => i.id === 'claude')?.alias).toBe('Claude (review)');
    });

    it('does NOT PATCH when the alias is unchanged on blur', async () => {
      render(
        <AgentInstancesPane
          {...baseProps}
          instances={[primary('claude', 0, 'Claude'), primary('codex', 1)]}
        />,
      );
      const input = screen.getByTestId('agent-instance-alias-claude');
      fireEvent.change(input, { target: { value: 'Claude' } }); // same value
      fireEvent.blur(input);
      // Give any pending microtask a chance, then assert no call.
      await Promise.resolve();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('delete instance', () => {
    it('PATCHes the roster without the deleted instance (order re-normalized)', async () => {
      render(
        <AgentInstancesPane
          {...baseProps}
          instances={[primary('claude', 0), primary('codex', 1), primary('gemini', 2)]}
        />,
      );
      openRowMenu('claude');
      fireEvent.click(screen.getByTestId('agent-instance-delete-claude'));
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      const body = patchBody();
      expect(body.agentInstances.map((i) => i.id)).toEqual(['codex', 'gemini']);
      expect(body.agentInstances.map((i) => i.order)).toEqual([0, 1]);
    });

    it('disables delete at MIN (single instance) and shows the min hint', () => {
      render(<AgentInstancesPane {...baseProps} instances={[primary('claude', 0)]} />);
      openRowMenu('claude');
      expect(screen.getByTestId('agent-instance-delete-claude')).toHaveAttribute('data-disabled');
      expect(screen.getByText('schedule.agentInstanceMin')).toBeInTheDocument();
    });
  });

  describe('reorder instances', () => {
    it('move-down swaps with the next instance and PATCHes the new order', async () => {
      render(
        <AgentInstancesPane
          {...baseProps}
          instances={[primary('claude', 0), primary('codex', 1), primary('gemini', 2)]}
        />,
      );
      openRowMenu('claude');
      fireEvent.click(screen.getByTestId('agent-instance-move-down-claude'));
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      const body = patchBody();
      expect(body.agentInstances.map((i) => i.id)).toEqual(['codex', 'claude', 'gemini']);
      expect(body.agentInstances.map((i) => i.order)).toEqual([0, 1, 2]);
    });

    it('move-up is disabled on the first row, move-down on the last row', () => {
      render(
        <AgentInstancesPane
          {...baseProps}
          instances={[primary('claude', 0), primary('codex', 1)]}
        />,
      );
      // First row (claude): move-up disabled, move-down enabled.
      openRowMenu('claude');
      expect(screen.getByTestId('agent-instance-move-up-claude')).toHaveAttribute('data-disabled');
      expect(screen.getByTestId('agent-instance-move-down-claude')).not.toHaveAttribute(
        'data-disabled',
      );
      fireEvent.keyDown(document.body, { key: 'Escape' });

      // Last row (codex): move-down disabled, move-up enabled.
      openRowMenu('codex');
      expect(screen.getByTestId('agent-instance-move-down-codex')).toHaveAttribute('data-disabled');
      expect(screen.getByTestId('agent-instance-move-up-codex')).not.toHaveAttribute(
        'data-disabled',
      );
    });
  });

  describe('bounds (max / min)', () => {
    it('disables Add + base-tool select at MAX and shows the max hint', () => {
      const full: AgentInstance[] = Array.from({ length: MAX_AGENT_INSTANCES }, (_, i) =>
        i === 0
          ? primary('claude', 0, 'Primary')
          : { id: `claude-${i + 1}`, cliTool: 'claude' as CLIToolType, alias: `Claude ${i + 1}`, order: i },
      );
      render(<AgentInstancesPane {...baseProps} instances={full} />);
      expect(screen.getByTestId('agent-instance-add')).toBeDisabled();
      expect(screen.getByTestId('agent-instance-add-tool')).toBeDisabled();
      expect(screen.getByText('schedule.agentInstanceMax')).toBeInTheDocument();
    });

    it('no-ops Add when already at MAX (no PATCH fired)', async () => {
      const full: AgentInstance[] = Array.from({ length: MAX_AGENT_INSTANCES }, (_, i) =>
        i === 0
          ? primary('claude', 0)
          : { id: `claude-${i + 1}`, cliTool: 'claude' as CLIToolType, alias: `Claude ${i + 1}`, order: i },
      );
      render(<AgentInstancesPane {...baseProps} instances={full} />);
      fireEvent.click(screen.getByTestId('agent-instance-add'));
      await Promise.resolve();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('persistence failure', () => {
    it('shows an error message when the PATCH responds !ok', async () => {
      mockFetch.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
      const onInstancesChange = vi.fn();
      render(
        <AgentInstancesPane
          {...baseProps}
          onInstancesChange={onInstancesChange}
          instances={[primary('claude', 0), primary('codex', 1)]}
        />,
      );
      openRowMenu('claude');
      fireEvent.click(screen.getByTestId('agent-instance-delete-claude'));
      await waitFor(() =>
        expect(screen.getByTestId('agent-instances-error')).toBeInTheDocument(),
      );
      expect(onInstancesChange).not.toHaveBeenCalled();
    });
  });
});
