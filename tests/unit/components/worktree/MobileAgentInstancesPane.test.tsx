/**
 * Tests for MobileAgentInstancesPane (Issue #874)
 *
 * Mobile instance-management UI. It wraps the SHARED AgentInstancesPane (roster
 * → DB) so mobile users can add / rename / delete / reorder instances exactly
 * like PC, and adds a per-device "Show on this device" checklist backed by
 * localStorage (the visibility props are lifted to the controller via
 * useMobileSelectedInstances). The per-device selection never writes the DB.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MobileAgentInstancesPane } from '@/components/worktree/MobileAgentInstancesPane';
import {
  getCliToolDisplayName,
  type AgentInstance,
  type CLIToolType,
} from '@/lib/cli-tools/types';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function primary(cliTool: CLIToolType, order: number, alias?: string): AgentInstance {
  return { id: cliTool, cliTool, alias: alias ?? getCliToolDisplayName(cliTool), order };
}

const ROSTER: AgentInstance[] = [
  primary('claude', 0, 'Claude'),
  { id: 'claude-2', cliTool: 'claude', alias: 'Claude (review)', order: 1 },
  primary('codex', 2, 'Codex'),
];

const baseProps = {
  worktreeId: 'w-874',
  instances: ROSTER,
  onInstancesChange: vi.fn(),
  vibeLocalModel: null as string | null,
  onVibeLocalModelChange: vi.fn(),
  vibeLocalContextWindow: null as number | null,
  onVibeLocalContextWindowChange: vi.fn(),
  visibleInstanceIds: ['claude', 'codex'],
  onToggleInstanceVisible: vi.fn(),
};

describe('MobileAgentInstancesPane (Issue #874)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
  });

  it('embeds the shared roster editor (AgentInstancesPane)', () => {
    render(<MobileAgentInstancesPane {...baseProps} />);
    // The shared roster editor and its rows are present (add/rename/delete/reorder).
    expect(screen.getByTestId('agent-instances-pane')).toBeInTheDocument();
    expect(screen.getByTestId('agent-instance-row-claude')).toBeInTheDocument();
    expect(screen.getByTestId('agent-instance-row-claude-2')).toBeInTheDocument();
    expect(screen.getByTestId('agent-instance-row-codex')).toBeInTheDocument();
    expect(screen.getByTestId('agent-instance-add')).toBeInTheDocument();
  });

  it('renders a per-device visibility toggle per roster instance, using the alias label', () => {
    render(<MobileAgentInstancesPane {...baseProps} />);
    expect(screen.getByTestId('mobile-visible-instances')).toBeInTheDocument();

    const claude = screen.getByTestId('mobile-visible-instance-toggle-claude') as HTMLInputElement;
    const claude2 = screen.getByTestId(
      'mobile-visible-instance-toggle-claude-2'
    ) as HTMLInputElement;
    const codex = screen.getByTestId('mobile-visible-instance-toggle-codex') as HTMLInputElement;

    // checked state mirrors visibleInstanceIds.
    expect(claude).toBeChecked();
    expect(codex).toBeChecked();
    expect(claude2).not.toBeChecked();

    // alias is the visible label (getInstanceLabel).
    expect(screen.getByText('Claude (review)')).toBeInTheDocument();
  });

  it('clicking a visibility toggle calls onToggleInstanceVisible with the instance id', () => {
    const onToggleInstanceVisible = vi.fn();
    render(
      <MobileAgentInstancesPane
        {...baseProps}
        onToggleInstanceVisible={onToggleInstanceVisible}
      />
    );
    fireEvent.click(screen.getByTestId('mobile-visible-instance-toggle-claude-2'));
    expect(onToggleInstanceVisible).toHaveBeenCalledWith('claude-2');
  });

  it('does NOT write the DB (no PATCH) when toggling per-device visibility', () => {
    render(<MobileAgentInstancesPane {...baseProps} />);
    fireEvent.click(screen.getByTestId('mobile-visible-instance-toggle-claude-2'));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('disables the toggle for the last remaining visible instance (MIN=1)', () => {
    render(
      <MobileAgentInstancesPane
        {...baseProps}
        visibleInstanceIds={['codex']}
      />
    );
    // Only 'codex' is visible -> its toggle is disabled (cannot hide the last one).
    expect(screen.getByTestId('mobile-visible-instance-toggle-codex')).toBeDisabled();
    // Hidden instances stay enabled so they can be shown.
    expect(screen.getByTestId('mobile-visible-instance-toggle-claude')).not.toBeDisabled();
  });
});
