/**
 * Tests for NotesAndLogsPane extension
 * Issue #368: Adds 'agent' sub-tab for Agent settings
 * Issue #874: Adds instance-management mode (mobile) for the 'agent' sub-tab
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NotesAndLogsPane } from '@/components/worktree/NotesAndLogsPane';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';

// Mock child components
vi.mock('@/components/worktree/MemoPane', () => ({
  MemoPane: ({ worktreeId, onInsertToMessage }: { worktreeId: string; onInsertToMessage?: (text: string) => void }) => (
    <div data-testid="memo-pane">
      MemoPane: {worktreeId}
      {onInsertToMessage && <span data-testid="memo-pane-has-insert">has-insert</span>}
    </div>
  ),
}));

vi.mock('@/components/worktree/ExecutionLogPane', () => ({
  ExecutionLogPane: ({ worktreeId }: { worktreeId: string }) => (
    <div data-testid="execution-log-pane">ExecutionLogPane: {worktreeId}</div>
  ),
}));

vi.mock('@/components/worktree/AgentSettingsPane', () => ({
  AgentSettingsPane: ({ worktreeId }: { worktreeId: string }) => (
    <div data-testid="agent-settings-pane">AgentSettingsPane: {worktreeId}</div>
  ),
}));

vi.mock('@/components/worktree/MobileAgentInstancesPane', () => ({
  MobileAgentInstancesPane: ({
    worktreeId,
    instances,
    visibleInstanceIds,
  }: {
    worktreeId: string;
    instances: AgentInstance[];
    visibleInstanceIds: string[];
  }) => (
    <div data-testid="mobile-agent-instances-pane">
      MobileAgentInstancesPane: {worktreeId}
      <span data-testid="mai-roster-ids">{instances.map((i) => i.id).join(',')}</span>
      <span data-testid="mai-visible-ids">{visibleInstanceIds.join(',')}</span>
    </div>
  ),
}));

describe('NotesAndLogsPane', () => {
  const defaultProps = {
    worktreeId: 'test-worktree',
    selectedAgents: ['claude', 'codex'] as CLIToolType[],
    onSelectedAgentsChange: vi.fn(),
    vibeLocalModel: null as string | null,
    onVibeLocalModelChange: vi.fn(),
    vibeLocalContextWindow: null as number | null,
    onVibeLocalContextWindowChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tab rendering', () => {
    it('should render Notes tab', () => {
      render(<NotesAndLogsPane {...defaultProps} />);
      expect(screen.getByText('schedule.notes')).toBeDefined();
    });

    it('should render Schedules tab', () => {
      render(<NotesAndLogsPane {...defaultProps} />);
      expect(screen.getByText('schedule.logs')).toBeDefined();
    });

    it('should render Agent tab', () => {
      render(<NotesAndLogsPane {...defaultProps} />);
      expect(screen.getByText('schedule.agentTab')).toBeDefined();
    });
  });

  describe('Insert to message propagation (Issue #485)', () => {
    it('should pass onInsertToMessage to MemoPane when notes tab is active', () => {
      const onInsertToMessage = vi.fn();
      render(<NotesAndLogsPane {...defaultProps} onInsertToMessage={onInsertToMessage} />);

      // Notes tab is active by default
      expect(screen.getByTestId('memo-pane-has-insert')).toBeInTheDocument();
    });

    it('should not pass insert indicator when onInsertToMessage is not provided', () => {
      render(<NotesAndLogsPane {...defaultProps} />);

      expect(screen.queryByTestId('memo-pane-has-insert')).not.toBeInTheDocument();
    });
  });

  describe('Tab switching', () => {
    it('should show MemoPane by default', () => {
      render(<NotesAndLogsPane {...defaultProps} />);
      expect(screen.getByTestId('memo-pane')).toBeDefined();
    });

    it('should show ExecutionLogPane when logs tab is clicked', () => {
      render(<NotesAndLogsPane {...defaultProps} />);
      fireEvent.click(screen.getByText('schedule.logs'));
      expect(screen.getByTestId('execution-log-pane')).toBeDefined();
    });

    it('should show AgentSettingsPane when agent tab is clicked', () => {
      render(<NotesAndLogsPane {...defaultProps} />);
      fireEvent.click(screen.getByText('schedule.agentTab'));
      expect(screen.getByTestId('agent-settings-pane')).toBeDefined();
    });
  });

  describe('Instance management mode (Issue #874)', () => {
    const roster: AgentInstance[] = [
      { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
      { id: 'claude-2', cliTool: 'claude', alias: 'Claude (review)', order: 1 },
    ];
    const instanceProps = {
      ...defaultProps,
      useInstanceManagement: true,
      instances: roster,
      onInstancesChange: vi.fn(),
      visibleInstanceIds: ['claude'],
      onToggleInstanceVisible: vi.fn(),
    };

    it('renders MobileAgentInstancesPane (not AgentSettingsPane) on the agent tab', () => {
      render(<NotesAndLogsPane {...instanceProps} />);
      fireEvent.click(screen.getByText('schedule.agentTab'));
      expect(screen.getByTestId('mobile-agent-instances-pane')).toBeInTheDocument();
      expect(screen.queryByTestId('agent-settings-pane')).not.toBeInTheDocument();
    });

    it('forwards the roster and per-device visible ids to MobileAgentInstancesPane', () => {
      render(<NotesAndLogsPane {...instanceProps} />);
      fireEvent.click(screen.getByText('schedule.agentTab'));
      expect(screen.getByTestId('mai-roster-ids').textContent).toBe('claude,claude-2');
      expect(screen.getByTestId('mai-visible-ids').textContent).toBe('claude');
    });

    it('falls back to AgentSettingsPane when useInstanceManagement is false (backward compat)', () => {
      render(<NotesAndLogsPane {...instanceProps} useInstanceManagement={false} />);
      fireEvent.click(screen.getByText('schedule.agentTab'));
      expect(screen.getByTestId('agent-settings-pane')).toBeInTheDocument();
      expect(screen.queryByTestId('mobile-agent-instances-pane')).not.toBeInTheDocument();
    });
  });
});
