/**
 * MarkdownEditor Mobile Default Preview Tab Tests
 *
 * Issue #549: Mobile markdown viewer should default to preview tab.
 * Separated from main test file because useIsMobile mock must be at module level.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MarkdownEditor } from '@/components/worktree/MarkdownEditor';

// Mock useIsMobile hook at module level (required by vitest)
const mockIsMobileReturn = vi.fn(() => true);
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: (...args: unknown[]) => mockIsMobileReturn(),
  MOBILE_BREAKPOINT: 768,
}));

// Mock fetch API
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((i: number) => Object.keys(store)[i] || null),
  };
})();

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

// Mock window event listeners
const mockAddEventListener = vi.fn();
const mockRemoveEventListener = vi.fn();
const originalAddEventListener = window.addEventListener;
const originalRemoveEventListener = window.removeEventListener;

describe('MarkdownEditor - Issue #549: Mobile Default Preview Tab', () => {
  const defaultProps = {
    worktreeId: 'test-worktree-549',
    filePath: 'docs/readme.md',
  };

  const mockFileContent = '# Test Document\n\nThis is a test.';

  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.clear();

    // Default: mobile
    mockIsMobileReturn.mockReturnValue(true);

    // Setup default fetch response
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        content: mockFileContent,
      }),
    });

    // Mock window dimensions for mobile portrait
    Object.defineProperty(window, 'innerWidth', { value: 375, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 812, writable: true });

    window.addEventListener = mockAddEventListener;
    window.removeEventListener = mockRemoveEventListener;
  });

  afterEach(() => {
    window.addEventListener = originalAddEventListener;
    window.removeEventListener = originalRemoveEventListener;
    vi.useRealTimers();
  });

  it('should default to preview tab on mobile (useIsMobile=true)', async () => {
    mockIsMobileReturn.mockReturnValue(true);

    render(<MarkdownEditor {...defaultProps} />);

    // Wait for file content to load, then check that preview tab is active
    await waitFor(() => {
      const previewTab = screen.getByTestId('mobile-tab-preview');
      // Active tab has cyan color class
      expect(previewTab.className).toContain('text-cyan-600');
    });
  });

  it('should keep editor as default tab on PC (useIsMobile=false)', async () => {
    mockIsMobileReturn.mockReturnValue(false);

    // PC: wider viewport
    Object.defineProperty(window, 'innerWidth', { value: 1440, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 900, writable: true });

    render(<MarkdownEditor {...defaultProps} />);

    // On PC, mobile tabs should not be shown at all (split view shows both panes)
    await waitFor(() => {
      expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
    });

    // Mobile tab bar should not be present
    expect(screen.queryByTestId('mobile-tab-editor')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mobile-tab-preview')).not.toBeInTheDocument();
  });

  it('should default to preview tab on mobile even when localStorage viewMode is editor', async () => {
    mockIsMobileReturn.mockReturnValue(true);
    localStorageMock.getItem.mockImplementation((key: string) => {
      if (key === 'markdown-editor-view-mode') return 'editor';
      return null;
    });

    render(<MarkdownEditor {...defaultProps} />);

    await waitFor(() => {
      const previewTab = screen.getByTestId('mobile-tab-preview');
      expect(previewTab.className).toContain('text-cyan-600');
    });
  });

  it('should not reset mobileTab when filePath changes', async () => {
    mockIsMobileReturn.mockReturnValue(true);

    const { rerender } = render(<MarkdownEditor {...defaultProps} />);

    // Wait for initial load with preview tab
    await waitFor(() => {
      const previewTab = screen.getByTestId('mobile-tab-preview');
      expect(previewTab.className).toContain('text-cyan-600');
    });

    // Switch to editor tab manually
    const editorTab = screen.getByTestId('mobile-tab-editor');
    await act(async () => {
      editorTab.click();
    });

    // Verify editor tab is now active
    await waitFor(() => {
      const editorTabAfterClick = screen.getByTestId('mobile-tab-editor');
      expect(editorTabAfterClick.className).toContain('text-cyan-600');
    });

    // Change filePath - should NOT reset mobileTab
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        content: '# Different File',
      }),
    });

    rerender(<MarkdownEditor {...defaultProps} filePath="docs/other.md" />);

    // Editor tab should still be active (not reset to preview)
    await waitFor(() => {
      const editorTabAfterRerender = screen.getByTestId('mobile-tab-editor');
      expect(editorTabAfterRerender.className).toContain('text-cyan-600');
    });
  });
});
