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

    it('inner status span has title-only (no role="status") accessibility', () => {
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
      expect(span?.getAttribute('title')).toBe(SIDEBAR_STATUS_CONFIG.waiting.label); // "Waiting for response"
      expect(span?.getAttribute('role')).toBeNull();
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
