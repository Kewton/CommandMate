/**
 * Unit tests for useWorktreeTabState hook
 * Issue #600: UX refresh - deep link tab state management
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock next/navigation
const mockSearchParams = new URLSearchParams();
const mockReplace = vi.fn();
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => '/worktrees/test-id',
}));

import { useWorktreeTabState } from '@/hooks/useWorktreeTabState';

describe('useWorktreeTabState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset searchParams
    mockSearchParams.delete('pane');
  });

  it('should default to terminal when no pane param exists', () => {
    const { result } = renderHook(() => useWorktreeTabState());
    expect(result.current.activePane).toBe('terminal');
  });

  it('should return valid pane value from searchParams', () => {
    mockSearchParams.set('pane', 'history');
    const { result } = renderHook(() => useWorktreeTabState());
    expect(result.current.activePane).toBe('history');
  });

  it('should fall back to terminal for invalid pane value', () => {
    mockSearchParams.set('pane', 'invalid-value');
    const { result } = renderHook(() => useWorktreeTabState());
    expect(result.current.activePane).toBe('terminal');
  });

  it('should fall back to terminal for XSS attempt', () => {
    mockSearchParams.set('pane', '<script>alert(1)</script>');
    const { result } = renderHook(() => useWorktreeTabState());
    expect(result.current.activePane).toBe('terminal');
  });

  describe('setPane()', () => {
    it('should call router.replace with scroll:false', () => {
      const { result } = renderHook(() => useWorktreeTabState());
      act(() => {
        result.current.setPane('files');
      });
      expect(mockReplace).toHaveBeenCalledWith(
        expect.stringContaining('pane=files'),
        { scroll: false }
      );
    });

    it('should not call router.replace if same pane', () => {
      // Default is terminal
      const { result } = renderHook(() => useWorktreeTabState());
      act(() => {
        result.current.setPane('terminal');
      });
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });

  describe('toLeftPaneTab()', () => {
    it('should map history to history', () => {
      mockSearchParams.set('pane', 'history');
      const { result } = renderHook(() => useWorktreeTabState());
      expect(result.current.leftPaneTab).toBe('history');
    });

    it('should map git to history (git is a sub-tab of history)', () => {
      mockSearchParams.set('pane', 'git');
      const { result } = renderHook(() => useWorktreeTabState());
      expect(result.current.leftPaneTab).toBe('history');
    });

    it('should map files to files', () => {
      mockSearchParams.set('pane', 'files');
      const { result } = renderHook(() => useWorktreeTabState());
      expect(result.current.leftPaneTab).toBe('files');
    });

    it('should map notes to memo', () => {
      mockSearchParams.set('pane', 'notes');
      const { result } = renderHook(() => useWorktreeTabState());
      expect(result.current.leftPaneTab).toBe('memo');
    });

    it('should map logs to memo', () => {
      mockSearchParams.set('pane', 'logs');
      const { result } = renderHook(() => useWorktreeTabState());
      expect(result.current.leftPaneTab).toBe('memo');
    });

    it('should map agent to memo', () => {
      mockSearchParams.set('pane', 'agent');
      const { result } = renderHook(() => useWorktreeTabState());
      expect(result.current.leftPaneTab).toBe('memo');
    });

    it('should map timer to memo', () => {
      mockSearchParams.set('pane', 'timer');
      const { result } = renderHook(() => useWorktreeTabState());
      expect(result.current.leftPaneTab).toBe('memo');
    });

    it('should map terminal to history (default desktop left pane)', () => {
      mockSearchParams.set('pane', 'terminal');
      const { result } = renderHook(() => useWorktreeTabState());
      expect(result.current.leftPaneTab).toBe('history');
    });
  });

  describe('toMobileActivePane()', () => {
    it('should map terminal to terminal', () => {
      mockSearchParams.set('pane', 'terminal');
      const { result } = renderHook(() => useWorktreeTabState());
      expect(result.current.mobileActivePane).toBe('terminal');
    });

    it('should map history to history', () => {
      mockSearchParams.set('pane', 'history');
      const { result } = renderHook(() => useWorktreeTabState());
      expect(result.current.mobileActivePane).toBe('history');
    });

    it('should map git to history', () => {
      mockSearchParams.set('pane', 'git');
      const { result } = renderHook(() => useWorktreeTabState());
      expect(result.current.mobileActivePane).toBe('history');
    });

    it('should map files to files', () => {
      mockSearchParams.set('pane', 'files');
      const { result } = renderHook(() => useWorktreeTabState());
      expect(result.current.mobileActivePane).toBe('files');
    });

    it('should map notes to memo', () => {
      mockSearchParams.set('pane', 'notes');
      const { result } = renderHook(() => useWorktreeTabState());
      expect(result.current.mobileActivePane).toBe('memo');
    });

    it('should map info to info', () => {
      mockSearchParams.set('pane', 'info');
      const { result } = renderHook(() => useWorktreeTabState());
      expect(result.current.mobileActivePane).toBe('info');
    });
  });

  describe('historySubTab', () => {
    it('should return message for history pane', () => {
      mockSearchParams.set('pane', 'history');
      const { result } = renderHook(() => useWorktreeTabState());
      expect(result.current.historySubTab).toBe('message');
    });

    it('should return git for git pane', () => {
      mockSearchParams.set('pane', 'git');
      const { result } = renderHook(() => useWorktreeTabState());
      expect(result.current.historySubTab).toBe('git');
    });

    it('should return message for non-history panes', () => {
      mockSearchParams.set('pane', 'files');
      const { result } = renderHook(() => useWorktreeTabState());
      expect(result.current.historySubTab).toBe('message');
    });
  });
});
