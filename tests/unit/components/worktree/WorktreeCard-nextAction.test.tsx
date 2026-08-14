/**
 * Unit tests for WorktreeCard next action display
 * Issue #600: UX refresh - WorktreeCard with getNextAction() integration
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// Issue #1277: WorktreeCard's wording (Main / Description / Link / status
// badge / "Updated …") is dictionary-driven, so resolve keys through the REAL
// locales/en/*.json. The previous local echo mock returned the key itself, so a
// nonexistent key would have gone unnoticed — and it also accepted the
// un-namespaced `useTranslations()` this component no longer uses.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}));

// Mock date-fns
vi.mock('date-fns', () => ({
  formatDistanceToNow: () => '5 minutes ago',
}));

// Mock date-locale
vi.mock('@/lib/date-locale', () => ({
  getDateFnsLocale: () => undefined,
}));

// Mock api-client
vi.mock('@/lib/api-client', () => ({
  worktreeApi: {
    killSession: vi.fn(),
    toggleFavorite: vi.fn(),
    updateStatus: vi.fn(),
  },
  handleApiError: vi.fn(() => 'error'),
}));

import { WorktreeCard } from '@/components/worktree/WorktreeCard';
import type { Worktree } from '@/types/models';

function createWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'test-1',
    name: 'feature/test',
    path: '/path/to/worktree',
    repositoryName: 'my-repo',
    updatedAt: '2026-01-01T00:00:00Z',
    isSessionRunning: false,
    isWaitingForResponse: false,
    favorite: false,
    status: null,
    ...overrides,
  } as Worktree;
}

describe('WorktreeCard next action display', () => {
  it('should display nextAction when provided', () => {
    const wt = createWorktree({ nextAction: 'Running...' } as Partial<Worktree>);
    render(<WorktreeCard worktree={wt} />);
    expect(screen.getByTestId('worktree-card-next-action')).toBeDefined();
    expect(screen.getByTestId('worktree-card-next-action').textContent).toBe('Running...');
  });

  it('should display "Approve / Reject" for approval prompt', () => {
    const wt = createWorktree({ nextAction: 'Approve / Reject' } as Partial<Worktree>);
    render(<WorktreeCard worktree={wt} />);
    expect(screen.getByTestId('worktree-card-next-action').textContent).toBe('Approve / Reject');
  });

  it('should not render next action element when nextAction is not provided', () => {
    const wt = createWorktree();
    render(<WorktreeCard worktree={wt} />);
    expect(screen.queryByTestId('worktree-card-next-action')).toBeNull();
  });

  it('should display repository name', () => {
    const wt = createWorktree({ repositoryName: 'test-repo' });
    render(<WorktreeCard worktree={wt} />);
    expect(screen.getByTestId('worktree-card-repo-name')).toBeDefined();
    expect(screen.getByTestId('worktree-card-repo-name').textContent).toBe('test-repo');
  });
});

// ============================================================================
// Issue #1787: nextAction is a dictionary key, and awaiting-instruction is its
// own (green) badge
// ============================================================================

describe('WorktreeCard next action i18n (Issue #1787)', () => {
  it('resolves a dictionary key through the real en dictionary', () => {
    const wt = createWorktree({ nextAction: 'nextAction.approveReject' } as Partial<Worktree>);
    render(<WorktreeCard worktree={wt} />);
    expect(screen.getByTestId('worktree-card-next-action').textContent).toBe(
      'Approve / Reject'
    );
  });

  it.each([
    ['nextAction.start', 'Start'],
    ['nextAction.sendMessage', 'Send message'],
    ['nextAction.replyToPrompt', 'Reply to prompt'],
    ['nextAction.checkStalled', 'Check stalled'],
    ['nextAction.running', 'Running...'],
  ])('renders %s as %j', (key, expected) => {
    render(<WorktreeCard worktree={createWorktree({ nextAction: key } as Partial<Worktree>)} />);
    expect(screen.getByTestId('worktree-card-next-action').textContent).toBe(expected);
  });

  // Back-compat: a server that predates this Issue still sends the English
  // literal. Handing that to `t()` would print `worktree.Approve / Reject`, so
  // unknown values must be rendered verbatim instead.
  it.each(['Approve / Reject', 'Running...', 'Something new'])(
    'renders the legacy literal %j verbatim',
    (literal) => {
      render(
        <WorktreeCard worktree={createWorktree({ nextAction: literal } as Partial<Worktree>)} />
      );
      const label = screen.getByTestId('worktree-card-next-action').textContent ?? '';
      expect(label).toBe(literal);
      expect(label).not.toContain('worktree.');
    }
  );
});

describe('WorktreeCard awaiting-instruction badge (Issue #1787)', () => {
  it('shows a green badge when an agent reports it is awaiting instructions', () => {
    const wt = createWorktree({
      isSessionRunning: true,
      sessionStatusByInstance: {
        claude: {
          isRunning: true,
          isWaitingForResponse: false,
          isProcessing: false,
          awaitingInstruction: true,
        },
      },
    } as Partial<Worktree>);
    render(<WorktreeCard worktree={wt} />);

    const badge = screen.getByTestId('worktree-card-awaiting-instruction');
    expect(badge.textContent).toBe('Ready for work');
    // Green, never amber: "done, give me work" must not read as "answer me".
    expect(badge.className).toMatch(/success/);
    expect(badge.className).not.toMatch(/warning/);
  });

  it('does not show the badge for a plain running session', () => {
    const wt = createWorktree({
      isSessionRunning: true,
      sessionStatusByInstance: {
        claude: { isRunning: true, isWaitingForResponse: false, isProcessing: true },
      },
    } as Partial<Worktree>);
    render(<WorktreeCard worktree={wt} />);
    expect(screen.queryByTestId('worktree-card-awaiting-instruction')).toBeNull();
  });

  it('does not show the badge for a payload with no #1786 fields at all', () => {
    render(<WorktreeCard worktree={createWorktree({ isSessionRunning: true })} />);
    expect(screen.queryByTestId('worktree-card-awaiting-instruction')).toBeNull();
  });
});
