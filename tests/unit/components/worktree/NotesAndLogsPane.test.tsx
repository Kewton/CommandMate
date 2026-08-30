/**
 * Tests for NotesAndLogsPane extension
 * Issue #368: Adds 'agent' sub-tab for Agent settings
 * Issue #874: Adds instance-management mode (mobile) for the 'agent' sub-tab
 * Issue #1442: Adds 'skills' sub-tab (mobile) + horizontal-scroll tab row
 * Issue #1816: Adds the 'verification' sub-tab, reachable from outside via
 * requestedSubTab
 * Issue #2064: the sub-tab is unconditional — `verification` is a required prop,
 * so mobile can no longer hide an entry point the PC Activity Bar always shows
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NotesAndLogsPane } from '@/components/worktree/NotesAndLogsPane';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import type { WorktreeVerificationState } from '@/hooks/useWorktreeVerification';

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

vi.mock('@/components/worktree/VerificationPane', () => ({
  VerificationPane: () => <div data-testid="verification-pane-stub">VerificationPane</div>,
}));

vi.mock('@/components/skills/WorktreeSkillsPane', () => ({
  WorktreeSkillsPane: ({ worktreeId }: { worktreeId: string }) => (
    <div data-testid="worktree-skills-pane">WorktreeSkillsPane: {worktreeId}</div>
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
  // Only the identity of the object matters here — VerificationPane is stubbed,
  // and the pane itself is covered by its own test.
  const verification = {} as never;

  const defaultProps = {
    worktreeId: 'test-worktree',
    selectedAgents: ['claude', 'codex'] as CLIToolType[],
    onSelectedAgentsChange: vi.fn(),
    vibeLocalModel: null as string | null,
    onVibeLocalModelChange: vi.fn(),
    vibeLocalContextWindow: null as number | null,
    onVibeLocalContextWindowChange: vi.fn(),
    // Issue #2064: required, so every render in this file supplies it.
    verification,
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

    // Issue #1442
    it('should render Skills tab', () => {
      render(<NotesAndLogsPane {...defaultProps} />);
      expect(screen.getByText('schedule.skillsTab')).toBeDefined();
    });
  });

  // Issue #1442: six sub-tabs must remain fully reachable on ~320px mobile
  // widths. The row scrolls horizontally instead of squeezing/wrapping tabs, so
  // the container carries the scroll classes and every tab keeps its natural
  // width (never `flex-1`, never wrapping).
  describe('Narrow-width tab layout (Issue #1442)', () => {
    const TAB_LABELS = [
      'schedule.notes',
      'schedule.logs',
      'schedule.agentTab',
      'schedule.timerTab',
      'schedule.todoTab',
      'schedule.skillsTab',
    ];

    it('renders all six sub-tabs', () => {
      render(<NotesAndLogsPane {...defaultProps} />);
      for (const label of TAB_LABELS) {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
    });

    it('lays the tab row out as a horizontal scroller (no equal-split squeeze)', () => {
      render(<NotesAndLogsPane {...defaultProps} />);
      // The row is the shared parent of every tab button.
      const row = screen.getByText('schedule.notes').parentElement as HTMLElement;
      expect(row.className).toContain('overflow-x-auto');
      expect(row.className).toContain('scrollbar-hide');
      expect(row.className).not.toContain('flex-1');
    });

    it('keeps every tab at its natural width so labels never wrap or truncate', () => {
      render(<NotesAndLogsPane {...defaultProps} />);
      for (const label of TAB_LABELS) {
        const button = screen.getByText(label).closest('button') as HTMLElement;
        expect(button.className).toContain('flex-shrink-0');
        expect(button.className).toContain('whitespace-nowrap');
        // The old equal-split layout would starve tabs on narrow screens.
        expect(button.className).not.toContain('flex-1');
      }
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

    // Issue #1442: the skills tab mounts the shared worktree-scoped Skills pane
    // (#1441) with this screen's worktree fixed.
    it('should show WorktreeSkillsPane (with this worktreeId) when skills tab is clicked', () => {
      render(<NotesAndLogsPane {...defaultProps} />);
      expect(screen.queryByTestId('worktree-skills-pane')).not.toBeInTheDocument();
      fireEvent.click(screen.getByText('schedule.skillsTab'));
      const pane = screen.getByTestId('worktree-skills-pane');
      expect(pane).toBeInTheDocument();
      expect(pane.textContent).toContain('test-worktree');
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

  describe('Verification sub-tab (Issue #1816 / #2064)', () => {
    it('is always offered, like the PC Activity Bar entry (Issue #2064)', () => {
      render(<NotesAndLogsPane {...defaultProps} />);
      expect(screen.getByText('schedule.verificationTab')).toBeInTheDocument();
    });

    it('is offered even with NO verification state supplied (Issue #2064)', () => {
      // The assertion above cannot see the fix: `defaultProps.verification` is
      // `{}`, which is TRUTHY, so the deleted guard
      // (`verification ? SUB_TABS : SUB_TABS.filter(t => t.id !== 'verification')`)
      // returns the full row for it and the test passes on develop too. Only an
      // absent state exercises the branch that used to hide the tab, so this is
      // the render that pins #2064. The cast is what makes the now-required prop
      // absent; restoring the guard must turn this red.
      render(
        <NotesAndLogsPane
          {...defaultProps}
          verification={undefined as unknown as WorktreeVerificationState}
        />
      );
      expect(screen.getByText('schedule.verificationTab')).toBeInTheDocument();
    });

    it('renders VerificationPane when the tab is selected', () => {
      render(<NotesAndLogsPane {...defaultProps} verification={verification} />);
      fireEvent.click(screen.getByText('schedule.verificationTab'));
      expect(screen.getByTestId('verification-pane-stub')).toBeInTheDocument();
    });

    it('opens on Verification when the request is already present at mount', () => {
      // The mobile shell unmounts this pane whenever the Tools tab is left, so
      // the header chip's jump arrives together with the remount.
      render(
        <NotesAndLogsPane
          {...defaultProps}
          verification={verification}
          requestedSubTab={{ tab: 'verification', token: 1 }}
        />
      );
      expect(screen.getByTestId('verification-pane-stub')).toBeInTheDocument();
    });

    it('switches on a NEW request while already mounted, and not on a repeat of the old one', () => {
      const { rerender } = render(
        <NotesAndLogsPane
          {...defaultProps}
          verification={verification}
          requestedSubTab={{ tab: 'verification', token: 1 }}
        />
      );
      fireEvent.click(screen.getByText('schedule.notes'));
      expect(screen.queryByTestId('verification-pane-stub')).not.toBeInTheDocument();

      // Same token, new object identity: the user's own tab choice stands.
      rerender(
        <NotesAndLogsPane
          {...defaultProps}
          verification={verification}
          requestedSubTab={{ tab: 'verification', token: 1 }}
        />
      );
      expect(screen.queryByTestId('verification-pane-stub')).not.toBeInTheDocument();

      // A fresh tap of the chip bumps the token and does switch.
      rerender(
        <NotesAndLogsPane
          {...defaultProps}
          verification={verification}
          requestedSubTab={{ tab: 'verification', token: 2 }}
        />
      );
      expect(screen.getByTestId('verification-pane-stub')).toBeInTheDocument();
    });
  });
});
