// DesktopHeader per-agent status row tests — Issue #749. WorktreeInfoFields covered separately in WorktreeInfoFields-copy.test.tsx
/**
 * @vitest-environment jsdom
 *
 * Issue #749: PC DesktopHeader per-agent session status indicators.
 *
 * Verifies the additive per-agent status row rendered to the LEFT of the
 * worktree status dropdown in DesktopHeader: per-agent rendering, status →
 * dot/spinner class mapping (via the real SIDEBAR_STATUS_CONFIG), active
 * highlight (aria-pressed + cyan background), click → onActiveCliTabChange,
 * aria-label text, and backward compatibility (no row when props omitted).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DesktopHeader } from '@/components/worktree/WorktreeDetailSubComponents';
import { SIDEBAR_STATUS_CONFIG } from '@/config/status-colors';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';

type SessionStatusMap = NonNullable<Worktree['sessionStatusByCli']>;

/** Minimal valid props for DesktopHeader (per-agent props omitted by default). */
const baseProps = {
  worktreeName: 'feature/749-worktree',
  repositoryName: 'CommandMate',
  status: 'idle' as const,
  onBackClick: vi.fn(),
  onInfoClick: vi.fn(),
};

describe('DesktopHeader per-agent status row (Issue #749)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('renders a desktop-agent-status-${cliId} button for each selectedAgent', () => {
      const selectedAgents: CLIToolType[] = ['claude', 'codex'];
      render(<DesktopHeader {...baseProps} selectedAgents={selectedAgents} />);

      expect(screen.getByTestId('desktop-agent-status-row')).toBeDefined();
      expect(screen.getByTestId('desktop-agent-status-claude')).toBeDefined();
      expect(screen.getByTestId('desktop-agent-status-codex')).toBeDefined();
    });

    it('does NOT render the status row when selectedAgents is omitted (backward compat)', () => {
      render(<DesktopHeader {...baseProps} />);
      expect(screen.queryByTestId('desktop-agent-status-row')).toBeNull();
    });

    it('does NOT render the status row when selectedAgents is an empty array', () => {
      render(<DesktopHeader {...baseProps} selectedAgents={[]} />);
      expect(screen.queryByTestId('desktop-agent-status-row')).toBeNull();
    });
  });

  describe('status → dot/spinner class mapping', () => {
    it('idle → gray dot (no session status entry)', () => {
      render(<DesktopHeader {...baseProps} selectedAgents={['claude']} />);
      const span = screen.getByTestId('desktop-agent-status-claude').querySelector('span');
      expect(span?.className).toContain(SIDEBAR_STATUS_CONFIG.idle.className); // bg-gray-500
      expect(span?.className).not.toContain('animate-spin');
    });

    it('ready → green dot (isRunning only)', () => {
      const sessionStatusByCli: SessionStatusMap = {
        claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
      };
      render(
        <DesktopHeader
          {...baseProps}
          selectedAgents={['claude']}
          sessionStatusByCli={sessionStatusByCli}
        />
      );
      const span = screen.getByTestId('desktop-agent-status-claude').querySelector('span');
      expect(span?.className).toContain(SIDEBAR_STATUS_CONFIG.ready.className); // bg-green-500
      expect(span?.className).not.toContain('animate-spin');
    });

    it('waiting → yellow dot (isWaitingForResponse)', () => {
      const sessionStatusByCli: SessionStatusMap = {
        claude: { isRunning: true, isWaitingForResponse: true, isProcessing: false },
      };
      render(
        <DesktopHeader
          {...baseProps}
          selectedAgents={['claude']}
          sessionStatusByCli={sessionStatusByCli}
        />
      );
      const span = screen.getByTestId('desktop-agent-status-claude').querySelector('span');
      expect(span?.className).toContain(SIDEBAR_STATUS_CONFIG.waiting.className); // bg-yellow-500
      expect(span?.className).not.toContain('animate-spin');
    });

    it('running → blue spinner (isProcessing)', () => {
      const sessionStatusByCli: SessionStatusMap = {
        claude: { isRunning: true, isWaitingForResponse: false, isProcessing: true },
      };
      render(
        <DesktopHeader
          {...baseProps}
          selectedAgents={['claude']}
          sessionStatusByCli={sessionStatusByCli}
        />
      );
      const span = screen.getByTestId('desktop-agent-status-claude').querySelector('span');
      expect(span?.className).toContain(SIDEBAR_STATUS_CONFIG.running.className); // border-blue-500
      expect(span?.className).toContain('animate-spin');
    });
  });

  describe('active highlight', () => {
    it('active agent has aria-pressed=true + cyan active class; others aria-pressed=false', () => {
      render(
        <DesktopHeader
          {...baseProps}
          selectedAgents={['claude', 'codex']}
          activeCliTab="codex"
        />
      );
      const active = screen.getByTestId('desktop-agent-status-codex');
      const inactive = screen.getByTestId('desktop-agent-status-claude');

      expect(active.getAttribute('aria-pressed')).toBe('true');
      expect(active.className).toContain('bg-cyan-100');
      expect(active.className).toContain('dark:bg-cyan-900/30');

      expect(inactive.getAttribute('aria-pressed')).toBe('false');
      expect(inactive.className).not.toContain('bg-cyan-100');
    });
  });

  describe('click → onActiveCliTabChange', () => {
    it('calls onActiveCliTabChange with the clicked cliId', () => {
      const onActiveCliTabChange = vi.fn();
      render(
        <DesktopHeader
          {...baseProps}
          selectedAgents={['claude', 'codex']}
          activeCliTab="claude"
          onActiveCliTabChange={onActiveCliTabChange}
        />
      );
      fireEvent.click(screen.getByTestId('desktop-agent-status-codex'));
      expect(onActiveCliTabChange).toHaveBeenCalledTimes(1);
      expect(onActiveCliTabChange).toHaveBeenCalledWith('codex');
    });

    it('does not throw when onActiveCliTabChange is omitted', () => {
      render(<DesktopHeader {...baseProps} selectedAgents={['claude']} />);
      expect(() =>
        fireEvent.click(screen.getByTestId('desktop-agent-status-claude'))
      ).not.toThrow();
    });
  });

  describe('aria-label text (real SIDEBAR_STATUS_CONFIG labels)', () => {
    it('uses "${displayName}: ${label}" — e.g. "Claude: Running" and "Codex: Idle"', () => {
      const sessionStatusByCli: SessionStatusMap = {
        claude: { isRunning: true, isWaitingForResponse: false, isProcessing: true },
      };
      render(
        <DesktopHeader
          {...baseProps}
          selectedAgents={['claude', 'codex']}
          sessionStatusByCli={sessionStatusByCli}
        />
      );
      expect(screen.getByTestId('desktop-agent-status-claude').getAttribute('aria-label')).toBe(
        'Claude: Running'
      );
      expect(screen.getByTestId('desktop-agent-status-codex').getAttribute('aria-label')).toBe(
        'Codex: Idle'
      );
    });

    it('icon span (first child) has the status class, no title, and no role (Issue #751)', () => {
      const sessionStatusByCli: SessionStatusMap = {
        claude: { isRunning: true, isWaitingForResponse: true, isProcessing: false },
      };
      render(
        <DesktopHeader
          {...baseProps}
          selectedAgents={['claude']}
          sessionStatusByCli={sessionStatusByCli}
        />
      );
      const button = screen.getByTestId('desktop-agent-status-claude');
      const iconSpan = button.querySelector('span');
      // Icon span keeps the status color class (waiting → yellow dot).
      expect(iconSpan?.className).toContain(SIDEBAR_STATUS_CONFIG.waiting.className);
      // Issue #751: text is now visible inline, so title is redundant and removed.
      expect(iconSpan?.getAttribute('title')).toBeNull();
      expect(iconSpan?.getAttribute('role')).toBeNull();
      // The button shows the visible inline text.
      expect(button.textContent).toContain('Claude: Waiting for response');
    });
  });

  describe('Issue #751: inline always-visible agent name + status text', () => {
    it('renders visible text "Claude: Running" when claude is processing', () => {
      const sessionStatusByCli: SessionStatusMap = {
        claude: { isRunning: true, isWaitingForResponse: false, isProcessing: true },
      };
      render(
        <DesktopHeader
          {...baseProps}
          selectedAgents={['claude', 'codex']}
          sessionStatusByCli={sessionStatusByCli}
        />
      );
      expect(screen.getByText('Claude: Running')).toBeDefined();
    });

    it('renders visible text "Codex: Idle" when codex has no session', () => {
      const sessionStatusByCli: SessionStatusMap = {
        claude: { isRunning: true, isWaitingForResponse: false, isProcessing: true },
      };
      render(
        <DesktopHeader
          {...baseProps}
          selectedAgents={['claude', 'codex']}
          sessionStatusByCli={sessionStatusByCli}
        />
      );
      expect(screen.getByText('Codex: Idle')).toBeDefined();
    });

    it('does NOT render a Tooltip wrapper (no role="tooltip" on render)', () => {
      render(
        <DesktopHeader
          {...baseProps}
          selectedAgents={['claude', 'codex']}
        />
      );
      // Tooltip wrapper removed: no tooltip element should be present without hover.
      expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('row container uses gap-2 (Issue #751)', () => {
      render(<DesktopHeader {...baseProps} selectedAgents={['claude']} />);
      const row = screen.getByTestId('desktop-agent-status-row');
      expect(row.className).toContain('gap-2');
    });
  });

  describe('polling auto-update (memo re-render on sessionStatusByCli change)', () => {
    it('updates the indicator when a new sessionStatusByCli reference arrives (idle → running)', () => {
      // Simulate the parent poll producing a fresh worktree.sessionStatusByCli object.
      const { rerender } = render(
        <DesktopHeader {...baseProps} selectedAgents={['claude']} sessionStatusByCli={{}} />
      );
      let span = screen.getByTestId('desktop-agent-status-claude').querySelector('span');
      // idle: gray dot, not a spinner
      expect(span?.className).toContain(SIDEBAR_STATUS_CONFIG.idle.className);
      expect(span?.className).not.toContain('animate-spin');

      // Next poll: claude is now processing → new object identity (memo must re-render).
      const updated: SessionStatusMap = {
        claude: { isRunning: true, isWaitingForResponse: false, isProcessing: true },
      };
      rerender(
        <DesktopHeader {...baseProps} selectedAgents={['claude']} sessionStatusByCli={updated} />
      );
      span = screen.getByTestId('desktop-agent-status-claude').querySelector('span');
      // running: blue spinner
      expect(span?.className).toContain(SIDEBAR_STATUS_CONFIG.running.className);
      expect(span?.className).toContain('animate-spin');
      expect(screen.getByTestId('desktop-agent-status-claude').getAttribute('aria-label')).toBe(
        'Claude: Running'
      );
    });
  });
});

/**
 * Issue #784: PC DesktopHeader session kill button.
 *
 * Regression restored after #728 (split-ification removed the terminal-header
 * kill button) + #755 (Desktop/Mobile split restored the Mobile kill button
 * but missed the Desktop one). The Mobile kill button lives in
 * WorktreeDetailRefactored.tsx:409-421. This suite verifies the additive
 * desktop-kill-session button placed between the per-agent status row and the
 * worktree status dropdown: it renders only when the active CLI session is
 * running, calls onKillSession on click, and is backward compatible (no button
 * when the handler is omitted or the session is idle).
 */
describe('DesktopHeader session kill button (Issue #784)', () => {
  const runningStatus: SessionStatusMap = {
    claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering condition', () => {
    it('renders the kill button when the active CLI session is running', () => {
      render(
        <DesktopHeader
          {...baseProps}
          activeCliTab="claude"
          sessionStatusByCli={runningStatus}
          onKillSession={vi.fn()}
        />
      );
      expect(screen.getByTestId('desktop-kill-session')).toBeDefined();
    });

    it('does NOT render the kill button when the active CLI session is not running', () => {
      const idleStatus: SessionStatusMap = {
        claude: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
      };
      render(
        <DesktopHeader
          {...baseProps}
          activeCliTab="claude"
          sessionStatusByCli={idleStatus}
          onKillSession={vi.fn()}
        />
      );
      expect(screen.queryByTestId('desktop-kill-session')).toBeNull();
    });

    it('does NOT render the kill button when there is no session status entry for the active CLI', () => {
      render(
        <DesktopHeader
          {...baseProps}
          activeCliTab="codex"
          sessionStatusByCli={runningStatus}
          onKillSession={vi.fn()}
        />
      );
      // codex has no entry → button hidden
      expect(screen.queryByTestId('desktop-kill-session')).toBeNull();
    });

    it('does NOT render the kill button when onKillSession is omitted (backward compat)', () => {
      render(
        <DesktopHeader
          {...baseProps}
          activeCliTab="claude"
          sessionStatusByCli={runningStatus}
        />
      );
      expect(screen.queryByTestId('desktop-kill-session')).toBeNull();
    });

    it('does NOT render the kill button when activeCliTab is omitted', () => {
      render(
        <DesktopHeader
          {...baseProps}
          sessionStatusByCli={runningStatus}
          onKillSession={vi.fn()}
        />
      );
      expect(screen.queryByTestId('desktop-kill-session')).toBeNull();
    });
  });

  describe('accessibility + interaction', () => {
    it('has aria-label="End session"', () => {
      render(
        <DesktopHeader
          {...baseProps}
          activeCliTab="claude"
          sessionStatusByCli={runningStatus}
          onKillSession={vi.fn()}
        />
      );
      expect(screen.getByTestId('desktop-kill-session').getAttribute('aria-label')).toBe(
        'End session'
      );
    });

    it('calls onKillSession when clicked', () => {
      const onKillSession = vi.fn();
      render(
        <DesktopHeader
          {...baseProps}
          activeCliTab="claude"
          sessionStatusByCli={runningStatus}
          onKillSession={onKillSession}
        />
      );
      fireEvent.click(screen.getByTestId('desktop-kill-session'));
      expect(onKillSession).toHaveBeenCalledTimes(1);
    });
  });
});
