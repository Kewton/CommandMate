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
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';
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
    it('PATCHes the roster without the deleted instance after confirmation (Issue #1487)', async () => {
      render(
        <ConfirmProvider>
          <AgentInstancesPane
            {...baseProps}
            instances={[primary('claude', 0), primary('codex', 1), primary('gemini', 2)]}
          />
        </ConfirmProvider>,
      );
      openRowMenu('claude');
      fireEvent.click(screen.getByTestId('agent-instance-delete-claude'));
      // Deletion is gated behind the shared ConfirmDialog.
      fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      const body = patchBody();
      expect(body.agentInstances.map((i) => i.id)).toEqual(['codex', 'gemini']);
      expect(body.agentInstances.map((i) => i.order)).toEqual([0, 1]);
    });

    it('does not PATCH when the delete ConfirmDialog is cancelled (Issue #1487)', async () => {
      render(
        <ConfirmProvider>
          <AgentInstancesPane
            {...baseProps}
            instances={[primary('claude', 0), primary('codex', 1), primary('gemini', 2)]}
          />
        </ConfirmProvider>,
      );
      openRowMenu('claude');
      fireEvent.click(screen.getByTestId('agent-instance-delete-claude'));
      fireEvent.click(await screen.findByTestId('confirm-dialog-cancel'));
      await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
      expect(mockFetch).not.toHaveBeenCalled();
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
        <ConfirmProvider>
          <AgentInstancesPane
            {...baseProps}
            onInstancesChange={onInstancesChange}
            instances={[primary('claude', 0), primary('codex', 1)]}
          />
        </ConfirmProvider>,
      );
      openRowMenu('claude');
      fireEvent.click(screen.getByTestId('agent-instance-delete-claude'));
      fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
      await waitFor(() =>
        expect(screen.getByTestId('agent-instances-error')).toBeInTheDocument(),
      );
      expect(onInstancesChange).not.toHaveBeenCalled();
    });
  });
  /**
   * Issue #2120: the CLI commands that address one roster row.
   *
   * The row id and the resolved instance id are DELIBERATELY different in every
   * test here (`codex` -> `codex-2`). A panel that composed `--instance` from
   * the roster row it was opened from would print `--instance codex` and still
   * look right on screen; the difference is what makes these assertions catch
   * it. Issue #1925 is the record of what a second authority on that value cost.
   */
  describe('CLI commands panel (Issue #2120)', () => {
    const CLI_REFERENCE = {
      binary: 'commandmatedev',
      worktreeId: 'w-1',
      portPrefix: null as number | null,
    };
    const RESOLVED_TARGET = {
      cliToolId: 'codex',
      instanceId: 'codex-2',
      resolvedBy: 'roster',
      conflict: null as unknown,
    };

    /**
     * Route by URL rather than by call order: the panel reads both endpoints in
     * one `Promise.all`, so the order they are consumed in is not this test's to
     * pin.
     */
    function stubReads(
      overrides: {
        reference?: Partial<typeof CLI_REFERENCE>;
        target?: Partial<typeof RESOLVED_TARGET>;
        referenceOk?: boolean;
        targetOk?: boolean;
      } = {},
    ): void {
      mockFetch.mockImplementation((url: string) => {
        if (String(url).includes('/cli-reference')) {
          return Promise.resolve({
            ok: overrides.referenceOk ?? true,
            json: () => Promise.resolve({ ...CLI_REFERENCE, ...overrides.reference }),
          });
        }
        if (String(url).includes('/resolve-target')) {
          return Promise.resolve({
            ok: overrides.targetOk ?? true,
            json: () => Promise.resolve({ ...RESOLVED_TARGET, ...overrides.target }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });
    }

    function writeText(): ReturnType<typeof vi.fn> {
      const spy = vi.fn(async () => undefined);
      vi.stubGlobal('navigator', { clipboard: { writeText: spy } });
      return spy;
    }

    /** Render the pane and open the CLI panel of the `codex` row. */
    async function openPanel(): Promise<void> {
      render(
        <AgentInstancesPane
          {...baseProps}
          instances={[primary('claude', 0), primary('codex', 1)]}
        />,
      );
      fireEvent.click(screen.getByTestId('agent-instance-cli-codex'));
      await screen.findByTestId('cli-commands-command-send');
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('reads nothing until the panel is opened', () => {
      stubReads();
      render(
        <AgentInstancesPane
          {...baseProps}
          instances={[primary('claude', 0), primary('codex', 1)]}
        />,
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('asks resolve-target for the row it was opened from', async () => {
      stubReads();
      await openPanel();
      const urls = mockFetch.mock.calls.map((call) => String(call[0]));
      expect(urls).toContain('/api/worktrees/w-1/resolve-target?instance=codex');
      expect(urls).toContain('/api/worktrees/w-1/cli-reference');
    });

    it('builds all four commands from the SERVER-resolved instance', async () => {
      stubReads();
      await openPanel();
      expect(screen.getByTestId('cli-commands-command-send')).toHaveTextContent(
        'commandmatedev send w-1 "worktree.cliCommands.messagePlaceholder" --instance codex-2',
      );
      expect(screen.getByTestId('cli-commands-command-wait')).toHaveTextContent(
        'commandmatedev wait w-1 --instance codex-2 --on-prompt human',
      );
      expect(screen.getByTestId('cli-commands-command-capture')).toHaveTextContent(
        'commandmatedev capture w-1 --instance codex-2',
      );
      expect(screen.getByTestId('cli-commands-command-respond')).toHaveTextContent(
        'commandmatedev respond w-1 "1" --instance codex-2',
      );
    });

    it('never prints the roster row id when the server resolved another one', async () => {
      stubReads();
      await openPanel();
      for (const id of ['send', 'wait', 'capture', 'respond']) {
        expect(screen.getByTestId(`cli-commands-command-${id}`).textContent).not.toContain(
          '--instance codex ',
        );
        expect(screen.getByTestId(`cli-commands-command-${id}`).textContent).not.toMatch(
          /--instance codex$/,
        );
      }
    });

    it('spells the commands with the binary the server reports (global install)', async () => {
      stubReads({ reference: { binary: 'commandmate' } });
      await openPanel();
      expect(screen.getByTestId('cli-commands-command-send')).toHaveTextContent(
        /^commandmate send /,
      );
    });

    it('spells the commands with `commandmatedev` for a checkout', async () => {
      stubReads({ reference: { binary: 'commandmatedev' } });
      await openPanel();
      expect(screen.getByTestId('cli-commands-command-send')).toHaveTextContent(
        /^commandmatedev send /,
      );
    });

    it('carries a CM_PORT= prefix when the server is not on the default port', async () => {
      stubReads({ reference: { portPrefix: 3135 } });
      await openPanel();
      expect(screen.getByTestId('cli-commands-command-capture')).toHaveTextContent(
        'CM_PORT=3135 commandmatedev capture w-1 --instance codex-2',
      );
      expect(screen.getByTestId('cli-commands-port-hint')).toBeInTheDocument();
    });

    it('renders the three notes the operator needs before pasting', async () => {
      stubReads();
      await openPanel();
      expect(screen.getByTestId('cli-commands-noteInstanceFlag')).toBeInTheDocument();
      expect(screen.getByTestId('cli-commands-noteWaitOnPrompt')).toBeInTheDocument();
      expect(screen.getByTestId('cli-commands-noteRespondNumber')).toBeInTheDocument();
    });

    it('copies the exact command that is on screen', async () => {
      const spy = writeText();
      stubReads();
      await openPanel();
      fireEvent.click(screen.getByTestId('cli-commands-copy-wait'));
      await waitFor(() =>
        expect(spy).toHaveBeenCalledWith(
          'commandmatedev wait w-1 --instance codex-2 --on-prompt human',
        ),
      );
      expect(await screen.findByText('worktree.cliCommands.copied')).toBeInTheDocument();
    });

    it('says the command was not copied when the clipboard refuses', async () => {
      // Plain HTTP from a phone on the LAN: `navigator.clipboard` is absent and
      // the icon never changes. Silence there reads as success.
      vi.stubGlobal('navigator', {
        clipboard: {
          writeText: vi.fn(async () => {
            throw new Error('NotAllowedError');
          }),
        },
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      stubReads();
      await openPanel();
      fireEvent.click(screen.getByTestId('cli-commands-copy-send'));
      expect(await screen.findByTestId('cli-commands-copy-error')).toBeInTheDocument();
      expect(screen.queryByText('worktree.cliCommands.copied')).not.toBeInTheDocument();
    });

    it('shows the contradiction the roster reported instead of hiding it', async () => {
      stubReads({
        target: {
          conflict: { instanceId: 'codex-2', rosterCliTool: 'codex', requestedCliTool: 'claude' },
        },
      });
      await openPanel();
      expect(screen.getByTestId('cli-commands-conflict')).toBeInTheDocument();
    });

    it('shows an error and NO command when the target cannot be resolved', async () => {
      // A command built from a guess would be indistinguishable on screen from
      // one the server confirmed, and would target the wrong agent.
      stubReads({ targetOk: false });
      render(
        <AgentInstancesPane
          {...baseProps}
          instances={[primary('claude', 0), primary('codex', 1)]}
        />,
      );
      fireEvent.click(screen.getByTestId('agent-instance-cli-codex'));
      expect(await screen.findByTestId('cli-commands-error')).toBeInTheDocument();
      expect(screen.queryByTestId('cli-commands-command-send')).not.toBeInTheDocument();
    });

    it('re-reads when the retry button is pressed', async () => {
      stubReads({ targetOk: false });
      render(
        <AgentInstancesPane
          {...baseProps}
          instances={[primary('claude', 0), primary('codex', 1)]}
        />,
      );
      fireEvent.click(screen.getByTestId('agent-instance-cli-codex'));
      await screen.findByTestId('cli-commands-retry');
      stubReads();
      fireEvent.click(screen.getByTestId('cli-commands-retry'));
      expect(await screen.findByTestId('cli-commands-command-send')).toBeInTheDocument();
    });
  });
});
