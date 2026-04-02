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
    ready: { type: 'dot', className: 'bg-cyan-500', label: 'Ready' },
    running: { type: 'spinner', className: 'border-green-500', label: 'Running' },
    waiting: { type: 'dot', className: 'bg-yellow-500', label: 'Waiting' },
    generating: { type: 'spinner', className: 'border-blue-500', label: 'Generating' },
  },
}));

// Mock date-utils
vi.mock('@/lib/date-utils', () => ({
  formatRelativeTime: (isoString: string) => {
    if (!isoString) return '';
    return '2 hours ago';
  },
}));

// --- useWorktreesCache mock ---
const mockRefresh = vi.fn();
let mockWorktrees: Array<Record<string, unknown>> = [];
let mockIsLoading = false;
let mockError: Error | null = null;

vi.mock('@/hooks/useWorktreesCache', () => ({
  useWorktreesCache: () => ({
    worktrees: mockWorktrees,
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
      expect(timeEl.textContent).toBe('2 hours ago');
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

    it('should truncate PC preview to 100 characters', () => {
      const longMessage = 'A'.repeat(150);
      mockWorktrees = [
        createWorktree({
          id: 'wt-long',
          lastUserMessage: longMessage,
          lastUserMessageAt: '2026-04-01T10:00:00Z',
        }),
      ];

      render(<SessionsPage />);

      const pcEl = screen.getByTestId('session-message-pc-wt-long');
      // 100 chars + '...'
      expect(pcEl.textContent).toBe('A'.repeat(100) + '...');
    });

    it('should truncate SP preview to 20 characters', () => {
      const longMessage = 'B'.repeat(50);
      mockWorktrees = [
        createWorktree({
          id: 'wt-sp',
          lastUserMessage: longMessage,
          lastUserMessageAt: '2026-04-01T10:00:00Z',
        }),
      ];

      render(<SessionsPage />);

      const spEl = screen.getByTestId('session-message-sp-wt-sp');
      expect(spEl.textContent).toBe('B'.repeat(20) + '...');
    });

    it('should not add ellipsis when message is within limit', () => {
      mockWorktrees = [
        createWorktree({
          id: 'wt-short',
          lastUserMessage: 'Short',
          lastUserMessageAt: '2026-04-01T10:00:00Z',
        }),
      ];

      render(<SessionsPage />);

      const pcEl = screen.getByTestId('session-message-pc-wt-short');
      expect(pcEl.textContent).toBe('Short');
      const spEl = screen.getByTestId('session-message-sp-wt-short');
      expect(spEl.textContent).toBe('Short');
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

      const pcEl = screen.getByTestId('session-message-pc-wt-ctrl');
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

      const pcEl = screen.getByTestId('session-message-pc-wt-newline');
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

      const pcEl = screen.getByTestId('session-message-pc-wt-spaces');
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

      // SortSelectorBase should be rendered
      expect(screen.getByTestId('sort-selector-base')).toBeDefined();
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
});
