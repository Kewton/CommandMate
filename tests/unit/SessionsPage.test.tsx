/**
 * Tests for Sessions page
 *
 * Issue #606: Sessions enhancement - sort options and message preview.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
}));

// Mock AppShell
vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'app-shell' }, children),
}));

// Mock status-colors
vi.mock('@/config/status-colors', () => ({
  SIDEBAR_STATUS_CONFIG: {
    idle: { type: 'dot', className: 'bg-gray-400', label: 'Idle' },
    ready: { type: 'dot', className: 'bg-accent-500', label: 'Ready' },
    running: { type: 'spinner', className: 'border-green-500', label: 'Running' },
    waiting: { type: 'dot', className: 'bg-yellow-500', label: 'Waiting' },
    generating: { type: 'spinner', className: 'border-info', label: 'Generating' },
  },
}));

// Mock date-utils
vi.mock('@/lib/date-utils', () => ({
  formatRelativeTime: (isoString: string) => {
    if (!isoString) return '';
    return '2 hours ago';
  },
  // Issue #1078: Sessions now uses the short form ("2h ago") with tabular-nums.
  formatRelativeTimeShort: (isoString: string) => {
    if (!isoString) return '';
    return '2h ago';
  },
}));

// --- WorktreesCacheProvider context mock (Issue #709) ---
// Sessions page now reads cached worktrees via useWorktreesCacheContext()
// instead of calling useWorktreesCache() directly, so we mock the Context
// hook here. The underlying useWorktreesCache hook is exercised by its
// own unit tests.
const mockRefresh = vi.fn();
let mockWorktrees: Array<Record<string, unknown>> = [];
let mockRepositories: Array<Record<string, unknown>> = [];
let mockIsLoading = false;
let mockError: Error | null = null;

vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useWorktreesCacheContext: () => ({
    worktrees: mockWorktrees,
    repositories: mockRepositories,
    isLoading: mockIsLoading,
    error: mockError,
    refresh: mockRefresh,
  }),
}));

// Import after mocks
import SessionsPage from '@/app/sessions/page';

// ============================================================================
// Test Data
// ============================================================================

function createWorktree(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wt-1',
    name: 'feature/test',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    selectedAgents: ['claude'],
    ...overrides,
  };
}

describe('SessionsPage', () => {
  beforeEach(() => {
    mockWorktrees = [];
    mockRepositories = [];
    mockIsLoading = false;
    mockError = null;
    vi.clearAllMocks();
  });

  describe('message preview display', () => {
    it('should display last sent message preview', () => {
      mockWorktrees = [
        createWorktree({
          id: 'wt-msg',
          lastUserMessage: 'Hello World, this is a test message',
          lastUserMessageAt: '2026-04-01T10:00:00Z',
        }),
      ];

      render(<SessionsPage />);

      const messageEl = screen.getByTestId('session-message-wt-msg');
      expect(messageEl).toBeDefined();
      expect(messageEl.textContent).toContain('Hello World');
    });

    it('should display relative time for last sent message', () => {
      mockWorktrees = [
        createWorktree({
          id: 'wt-time',
          lastUserMessage: 'Test message',
          lastUserMessageAt: '2026-04-01T10:00:00Z',
        }),
      ];

      render(<SessionsPage />);

      const timeEl = screen.getByTestId('session-time-wt-time');
      expect(timeEl.textContent).toBe('2h ago');
      // Issue #1078: relative time uses tabular-nums for stable column width.
      expect(timeEl.className).toContain('tabular-nums');
    });

    it('should not display message row when lastUserMessage is absent', () => {
      mockWorktrees = [
        createWorktree({
          id: 'wt-no-msg',
          lastUserMessage: undefined,
        }),
      ];

      render(<SessionsPage />);

      expect(screen.queryByTestId('session-message-wt-no-msg')).toBeNull();
    });

    it('renders the full message and truncates via CSS (no char-slice) [Issue #1078]', () => {
      const longMessage = 'A'.repeat(150);
      mockWorktrees = [
        createWorktree({
          id: 'wt-long',
          lastUserMessage: longMessage,
          lastUserMessageAt: '2026-04-01T10:00:00Z',
        }),
      ];

      render(<SessionsPage />);

      const textEl = screen.getByTestId('session-message-text-wt-long');
      // Full text is present (CSS `truncate` clips visually, not by character count).
      expect(textEl.textContent).toBe('A'.repeat(150));
      expect(textEl.className).toContain('truncate');
      // Full text also exposed via title for hover/accessibility.
      expect(textEl.getAttribute('title')).toBe('A'.repeat(150));
    });

    it('renders short messages verbatim with no ellipsis', () => {
      mockWorktrees = [
        createWorktree({
          id: 'wt-short',
          lastUserMessage: 'Short',
          lastUserMessageAt: '2026-04-01T10:00:00Z',
        }),
      ];

      render(<SessionsPage />);

      const textEl = screen.getByTestId('session-message-text-wt-short');
      expect(textEl.textContent).toBe('Short');
    });
  });

  describe('message sanitization / security', () => {
    it('should render script tags as plain text (no XSS)', () => {
      mockWorktrees = [
        createWorktree({
          id: 'wt-xss',
          lastUserMessage: '<script>alert(1)</script>',
          lastUserMessageAt: '2026-04-01T10:00:00Z',
        }),
      ];

      render(<SessionsPage />);

      const messageEl = screen.getByTestId('session-message-wt-xss');
      // Should be rendered as text, not executed
      expect(messageEl.textContent).toContain('<script>alert(1)</script>');
      // No actual script elements should be created
      expect(messageEl.querySelector('script')).toBeNull();
    });

    it('should render onerror payloads as plain text', () => {
      mockWorktrees = [
        createWorktree({
          id: 'wt-onerror',
          lastUserMessage: '<img src=x onerror=alert(1)>',
          lastUserMessageAt: '2026-04-01T10:00:00Z',
        }),
      ];

      render(<SessionsPage />);

      const messageEl = screen.getByTestId('session-message-wt-onerror');
      expect(messageEl.textContent).toContain('<img src=x onerror=alert(1)>');
      expect(messageEl.querySelector('img')).toBeNull();
    });

    it('should remove control characters from message', () => {
      // Include C0 control chars, zero-width chars, bidi marks
      mockWorktrees = [
        createWorktree({
          id: 'wt-ctrl',
          lastUserMessage: 'Hello\x00\x01\x02World\u200B\u200Ftest',
          lastUserMessageAt: '2026-04-01T10:00:00Z',
        }),
      ];

      render(<SessionsPage />);

      const pcEl = screen.getByTestId('session-message-text-wt-ctrl');
      // Control chars and zero-width chars should be removed
      expect(pcEl.textContent).toBe('HelloWorldtest');
    });

    it('should normalize newlines to spaces', () => {
      mockWorktrees = [
        createWorktree({
          id: 'wt-newline',
          lastUserMessage: 'Line1\nLine2\r\nLine3',
          lastUserMessageAt: '2026-04-01T10:00:00Z',
        }),
      ];

      render(<SessionsPage />);

      const pcEl = screen.getByTestId('session-message-text-wt-newline');
      expect(pcEl.textContent).toBe('Line1 Line2 Line3');
    });

    it('should collapse multiple spaces', () => {
      mockWorktrees = [
        createWorktree({
          id: 'wt-spaces',
          lastUserMessage: 'Hello    World   Test',
          lastUserMessageAt: '2026-04-01T10:00:00Z',
        }),
      ];

      render(<SessionsPage />);

      const pcEl = screen.getByTestId('session-message-text-wt-spaces');
      expect(pcEl.textContent).toBe('Hello World Test');
    });
  });

  describe('sort functionality', () => {
    it('should have default sort key as lastSent desc', () => {
      mockWorktrees = [
        createWorktree({
          id: 'wt-old',
          name: 'old',
          lastUserMessage: 'old msg',
          lastUserMessageAt: '2026-01-01T10:00:00Z',
        }),
        createWorktree({
          id: 'wt-new',
          name: 'new',
          lastUserMessage: 'new msg',
          lastUserMessageAt: '2026-04-01T10:00:00Z',
        }),
      ];

      render(<SessionsPage />);

      const list = screen.getByTestId('sessions-list');
      const items = within(list).getAllByTestId(/^session-item-/);
      // Default sort: lastSent desc = newest first
      expect(items[0].getAttribute('data-testid')).toBe('session-item-wt-new');
      expect(items[1].getAttribute('data-testid')).toBe('session-item-wt-old');
    });

    it('should place null lastUserMessageAt at end regardless of sort direction', () => {
      mockWorktrees = [
        createWorktree({
          id: 'wt-null',
          name: 'no-time',
          lastUserMessage: undefined,
          lastUserMessageAt: undefined,
        }),
        createWorktree({
          id: 'wt-has-time',
          name: 'has-time',
          lastUserMessage: 'msg',
          lastUserMessageAt: '2026-04-01T10:00:00Z',
        }),
      ];

      render(<SessionsPage />);

      const list = screen.getByTestId('sessions-list');
      const items = within(list).getAllByTestId(/^session-item-/);
      // Item with time should come first, null at end
      expect(items[0].getAttribute('data-testid')).toBe('session-item-wt-has-time');
      expect(items[1].getAttribute('data-testid')).toBe('session-item-wt-null');
    });

    it('should show sort selector with Sessions sort options', () => {
      mockWorktrees = [];

      render(<SessionsPage />);

      // Sort primitive (Radix Select trigger) and direction toggle are rendered
      expect(screen.getByTestId('sessions-sort-select')).toBeDefined();
      expect(screen.getByTestId('sessions-sort-direction')).toBeDefined();
    });
  });

  describe('entrance stagger (Issue #1050)', () => {
    it('applies stagger entrance classes with an incremental delay per item', () => {
      mockWorktrees = [
        createWorktree({ id: 'wt-1', lastUserMessageAt: '2026-04-03T10:00:00Z' }),
        createWorktree({ id: 'wt-2', lastUserMessageAt: '2026-04-02T10:00:00Z' }),
        createWorktree({ id: 'wt-3', lastUserMessageAt: '2026-04-01T10:00:00Z' }),
      ];

      render(<SessionsPage />);

      const first = screen.getByTestId('session-item-wt-1');
      const second = screen.getByTestId('session-item-wt-2');
      const third = screen.getByTestId('session-item-wt-3');

      // Entrance animation classes present on every item
      expect(first.className).toContain('animate-in');
      expect(first.className).toContain('fill-mode-backwards');

      // First item: no delay; subsequent items: 40ms increments
      expect(first.style.animationDelay).toBe('');
      expect(second.style.animationDelay).toBe('40ms');
      expect(third.style.animationDelay).toBe('80ms');
    });

    it('does NOT re-fire the entrance animation on a polling re-render (stable keys)', () => {
      mockWorktrees = [
        createWorktree({ id: 'wt-1', lastUserMessage: 'first', lastUserMessageAt: '2026-04-03T10:00:00Z' }),
        createWorktree({ id: 'wt-2', lastUserMessage: 'second', lastUserMessageAt: '2026-04-02T10:00:00Z' }),
      ];

      const { rerender } = render(<SessionsPage />);
      const before = screen.getByTestId('session-item-wt-1');

      // Simulate a polling update: same worktree ids, changed payload.
      mockWorktrees = [
        createWorktree({ id: 'wt-1', lastUserMessage: 'first (updated)', lastUserMessageAt: '2026-04-03T10:05:00Z' }),
        createWorktree({ id: 'wt-2', lastUserMessage: 'second', lastUserMessageAt: '2026-04-02T10:00:00Z' }),
      ];
      rerender(<SessionsPage />);
      const after = screen.getByTestId('session-item-wt-1');

      // Same DOM node is reused (not remounted) → CSS entrance animation cannot
      // restart. This is the guard against animations re-firing on each poll.
      expect(after).toBe(before);
      expect(after.className).toContain('animate-in');
    });

    it('keeps the list mounted (no re-fire) through a transient polling error', () => {
      mockWorktrees = [
        createWorktree({ id: 'wt-1', lastUserMessageAt: '2026-04-03T10:00:00Z' }),
      ];
      const { rerender } = render(<SessionsPage />);
      const before = screen.getByTestId('session-item-wt-1');
      expect(screen.getByTestId('sessions-list')).toBeDefined();

      // Transient poll failure (e.g. server rebuild): data still present, error set.
      mockError = new Error('fetch failed');
      rerender(<SessionsPage />);

      // The list stays mounted with the SAME DOM node (animation cannot re-fire),
      // and the error surfaces as a non-blocking banner rather than replacing it.
      const during = screen.getByTestId('session-item-wt-1');
      expect(during).toBe(before);
      expect(screen.getByTestId('sessions-error-banner')).toBeDefined();
      expect(screen.queryByTestId('sessions-error')).toBeNull();

      // Recovery poll: error clears, list node still identical.
      mockError = null;
      rerender(<SessionsPage />);
      expect(screen.getByTestId('session-item-wt-1')).toBe(before);
    });
  });

  describe('existing functionality preserved', () => {
    it('should filter by name or repository', () => {
      mockWorktrees = [
        createWorktree({ id: 'wt-a', name: 'feature/alpha', repositoryName: 'RepoA' }),
        createWorktree({ id: 'wt-b', name: 'feature/beta', repositoryName: 'RepoB' }),
      ];

      render(<SessionsPage />);

      const filter = screen.getByTestId('sessions-filter');
      fireEvent.change(filter, { target: { value: 'alpha' } });

      const list = screen.getByTestId('sessions-list');
      const items = within(list).queryAllByTestId(/^session-item-/);
      expect(items).toHaveLength(1);
      expect(items[0].getAttribute('data-testid')).toBe('session-item-wt-a');
    });

    it('should show loading state', () => {
      mockIsLoading = true;

      render(<SessionsPage />);

      expect(screen.getByTestId('sessions-loading')).toBeDefined();
    });

    it('should render skeleton session cards without naked loading text (Issue #1118)', () => {
      mockIsLoading = true;

      render(<SessionsPage />);

      const loading = screen.getByTestId('sessions-loading');
      expect(loading.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
      expect(loading.textContent).not.toContain('Loading sessions');
    });

    it('should show error state', () => {
      mockError = new Error('Network error');

      render(<SessionsPage />);

      expect(screen.getByTestId('sessions-error')).toBeDefined();
    });

    it('should show empty state', () => {
      mockWorktrees = [];

      render(<SessionsPage />);

      expect(screen.getByTestId('sessions-empty')).toBeDefined();
    });
  });

  // Issue #1078: only actively-working agents get a labelled chip; the idle
  // group collapses to a "+N" counter so a working session is not buried.
  describe('agent status display (Issue #1078)', () => {
    const SIX_AGENTS = ['claude', 'codex', 'gemini', 'cursor', 'aider', 'qwen'];

    it('running 1 + idle 5: only the running agent is a labelled chip + a "+5" idle counter', () => {
      mockWorktrees = [
        createWorktree({
          id: 'wt-mix',
          selectedAgents: SIX_AGENTS,
          sessionStatusByCli: {
            claude: { isRunning: true, isWaitingForResponse: false, isProcessing: true },
          },
        }),
      ];

      render(<SessionsPage />);

      // Working agent → labelled chip.
      expect(screen.getByTestId('session-agent-claude')).toBeDefined();
      // Idle agents are NOT rendered as labelled chips.
      expect(screen.queryByTestId('session-agent-codex')).toBeNull();
      expect(screen.queryByTestId('session-agent-gemini')).toBeNull();
      // Idle group collapses into a "+5" counter.
      const cluster = screen.getByTestId('session-idle-cluster-wt-mix');
      expect(cluster.textContent).toContain('+5');
    });

    it('all idle: no labelled chips, a single "+6" idle counter', () => {
      mockWorktrees = [
        createWorktree({ id: 'wt-idle', selectedAgents: SIX_AGENTS }),
      ];

      render(<SessionsPage />);

      expect(screen.queryByTestId('session-agent-claude')).toBeNull();
      const cluster = screen.getByTestId('session-idle-cluster-wt-idle');
      expect(cluster.textContent).toContain('+6');
    });

    it('waiting agents also count as working (labelled chip)', () => {
      mockWorktrees = [
        createWorktree({
          id: 'wt-wait',
          selectedAgents: SIX_AGENTS,
          sessionStatusByCli: {
            codex: { isRunning: true, isWaitingForResponse: true, isProcessing: false },
          },
        }),
      ];

      render(<SessionsPage />);

      expect(screen.getByTestId('session-agent-codex')).toBeDefined();
      const cluster = screen.getByTestId('session-idle-cluster-wt-wait');
      expect(cluster.textContent).toContain('+5');
    });

    it('all working: labelled chips for each, no idle counter', () => {
      const running = { isRunning: true, isWaitingForResponse: false, isProcessing: true };
      mockWorktrees = [
        createWorktree({
          id: 'wt-all',
          selectedAgents: ['claude', 'codex'],
          sessionStatusByCli: { claude: running, codex: running },
        }),
      ];

      render(<SessionsPage />);

      expect(screen.getByTestId('session-agent-claude')).toBeDefined();
      expect(screen.getByTestId('session-agent-codex')).toBeDefined();
      expect(screen.queryByTestId('session-idle-cluster-wt-all')).toBeNull();
    });
  });
});
