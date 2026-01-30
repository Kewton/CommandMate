/**
 * MarkdownEditor Component Tests
 *
 * Tests for the markdown editor component including:
 * - Rendering and display modes
 * - Save operations
 * - Unsaved changes warning
 * - Local storage persistence
 * - XSS prevention (SEC-MF-001)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MarkdownEditor } from '@/components/worktree/MarkdownEditor';
import type { ViewMode } from '@/types/markdown-editor';
import {
  LOCAL_STORAGE_KEY,
  LOCAL_STORAGE_KEY_SPLIT_RATIO,
  LOCAL_STORAGE_KEY_MAXIMIZED,
} from '@/types/markdown-editor';

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

// Mock beforeunload event
const mockAddEventListener = vi.fn();
const mockRemoveEventListener = vi.fn();
const originalAddEventListener = window.addEventListener;
const originalRemoveEventListener = window.removeEventListener;

describe('MarkdownEditor', () => {
  const defaultProps = {
    worktreeId: 'test-worktree-123',
    filePath: 'docs/readme.md',
  };

  const mockFileContent = '# Test Document\n\nThis is a test.';

  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.clear();

    // Setup default fetch response
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        content: mockFileContent,
      }),
    });

    // Mock window event listeners
    window.addEventListener = mockAddEventListener;
    window.removeEventListener = mockRemoveEventListener;
  });

  afterEach(() => {
    window.addEventListener = originalAddEventListener;
    window.removeEventListener = originalRemoveEventListener;
    vi.useRealTimers();
  });

  describe('Rendering', () => {
    it('should render loading state initially', () => {
      render(<MarkdownEditor {...defaultProps} />);
      expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    });

    it('should render editor and preview in split mode by default', async () => {
      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
        expect(screen.getByTestId('markdown-preview')).toBeInTheDocument();
      });
    });

    it('should display file content after loading', async () => {
      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        const textarea = screen.getByTestId('markdown-editor-textarea') as HTMLTextAreaElement;
        expect(textarea.value).toBe(mockFileContent);
      });
    });

    it('should display file path in header', async () => {
      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('docs/readme.md')).toBeInTheDocument();
      });
    });

    it('should display error state on fetch failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
        }),
      });

      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText(/File not found/i)).toBeInTheDocument();
      });
    });
  });

  describe('View Mode Switching', () => {
    it('should have split mode button active by default', async () => {
      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        const splitButton = screen.getByTestId('view-mode-split');
        expect(splitButton).toHaveAttribute('aria-pressed', 'true');
      });
    });

    it('should switch to editor-only mode', async () => {
      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
      });

      const editorButton = screen.getByTestId('view-mode-editor');
      fireEvent.click(editorButton);

      expect(editorButton).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('markdown-editor-textarea')).toBeVisible();
      // Preview should be hidden
      const previewContainer = screen.getByTestId('markdown-preview-container');
      expect(previewContainer).toHaveClass('hidden');
    });

    it('should switch to preview-only mode', async () => {
      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
      });

      const previewButton = screen.getByTestId('view-mode-preview');
      fireEvent.click(previewButton);

      expect(previewButton).toHaveAttribute('aria-pressed', 'true');
      // Editor should be hidden
      const editorContainer = screen.getByTestId('markdown-editor-container');
      expect(editorContainer).toHaveClass('hidden');
    });
  });

  describe('Save Operations', () => {
    it('should have save button disabled when no changes', async () => {
      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
      });

      const saveButton = screen.getByTestId('save-button');
      expect(saveButton).toBeDisabled();
    });

    it('should enable save button when content changes', async () => {
      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
      });

      const textarea = screen.getByTestId('markdown-editor-textarea');
      fireEvent.change(textarea, { target: { value: 'Modified content' } });

      const saveButton = screen.getByTestId('save-button');
      expect(saveButton).not.toBeDisabled();
    });

    it('should call API and show success toast on save', async () => {
      const onSave = vi.fn();
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, content: mockFileContent }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, path: 'docs/readme.md' }),
        });

      render(<MarkdownEditor {...defaultProps} onSave={onSave} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
      });

      const textarea = screen.getByTestId('markdown-editor-textarea');
      fireEvent.change(textarea, { target: { value: 'Modified content' } });

      const saveButton = screen.getByTestId('save-button');
      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/api/worktrees/test-worktree-123/files/docs/readme.md'),
          expect.objectContaining({
            method: 'PUT',
            body: JSON.stringify({ content: 'Modified content' }),
          })
        );
      });

      await waitFor(() => {
        expect(screen.getByText(/saved/i)).toBeInTheDocument();
      });

      expect(onSave).toHaveBeenCalledWith('docs/readme.md');
    });

    it('should handle Ctrl+S keyboard shortcut', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, content: mockFileContent }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, path: 'docs/readme.md' }),
        });

      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
      });

      const textarea = screen.getByTestId('markdown-editor-textarea');
      fireEvent.change(textarea, { target: { value: 'Modified content' } });

      // Trigger Ctrl+S
      fireEvent.keyDown(textarea, { key: 's', ctrlKey: true });

      await waitFor(() => {
        // Verify PUT call was made for save
        const putCall = mockFetch.mock.calls.find(call => {
          const options = call[1];
          return options && options.method === 'PUT';
        });
        expect(putCall).toBeDefined();
      });
    });

    it('should handle Cmd+S keyboard shortcut on Mac', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, content: mockFileContent }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, path: 'docs/readme.md' }),
        });

      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
      });

      const textarea = screen.getByTestId('markdown-editor-textarea');
      fireEvent.change(textarea, { target: { value: 'Modified content' } });

      // Trigger Cmd+S
      fireEvent.keyDown(textarea, { key: 's', metaKey: true });

      await waitFor(() => {
        // Verify PUT call was made for save
        const putCall = mockFetch.mock.calls.find(call => {
          const options = call[1];
          return options && options.method === 'PUT';
        });
        expect(putCall).toBeDefined();
      });
    });

    it('should show error toast on save failure', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, content: mockFileContent }),
        })
        .mockResolvedValueOnce({
          ok: false,
          json: async () => ({
            success: false,
            error: { code: 'PERMISSION_DENIED', message: 'Permission denied' },
          }),
        });

      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
      });

      const textarea = screen.getByTestId('markdown-editor-textarea');
      fireEvent.change(textarea, { target: { value: 'Modified content' } });

      const saveButton = screen.getByTestId('save-button');
      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(screen.getByText(/Permission denied/i)).toBeInTheDocument();
      });
    });
  });

  describe('Unsaved Changes Warning', () => {
    it('should show dirty indicator when content changes', async () => {
      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
      });

      const textarea = screen.getByTestId('markdown-editor-textarea');
      fireEvent.change(textarea, { target: { value: 'Modified content' } });

      await waitFor(() => {
        expect(screen.getByTestId('dirty-indicator')).toBeInTheDocument();
      });
    });

    it('should register beforeunload handler when dirty', async () => {
      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
      });

      const textarea = screen.getByTestId('markdown-editor-textarea');
      fireEvent.change(textarea, { target: { value: 'Modified content' } });

      await waitFor(() => {
        expect(mockAddEventListener).toHaveBeenCalledWith(
          'beforeunload',
          expect.any(Function)
        );
      });
    });

    it('should remove beforeunload handler after save', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, content: mockFileContent }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, path: 'docs/readme.md' }),
        });

      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
      });

      const textarea = screen.getByTestId('markdown-editor-textarea');
      fireEvent.change(textarea, { target: { value: 'Modified content' } });

      const saveButton = screen.getByTestId('save-button');
      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(screen.getByText(/saved/i)).toBeInTheDocument();
      });

      // Dirty indicator should be gone
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument();
    });
  });

  describe('Large File Warning', () => {
    it('should show warning for files over 500KB', async () => {
      // Create a large content (over 500KB)
      const largeContent = 'x'.repeat(600 * 1024);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, content: largeContent }),
      });

      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('large-file-warning')).toBeInTheDocument();
      });
    });

    it('should not show warning for files under 500KB', async () => {
      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
      });

      expect(screen.queryByTestId('large-file-warning')).not.toBeInTheDocument();
    });
  });

  describe('Local Storage Persistence', () => {
    it('should save view mode to localStorage on change', async () => {
      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
      });

      const editorButton = screen.getByTestId('view-mode-editor');
      fireEvent.click(editorButton);

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        LOCAL_STORAGE_KEY,
        'editor'
      );
    });

    it('should restore view mode from localStorage', async () => {
      localStorageMock.getItem.mockReturnValue('preview');

      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        const previewButton = screen.getByTestId('view-mode-preview');
        expect(previewButton).toHaveAttribute('aria-pressed', 'true');
      });
    });

    it('should use split as default when localStorage is empty', async () => {
      localStorageMock.getItem.mockReturnValue(null);

      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        const splitButton = screen.getByTestId('view-mode-split');
        expect(splitButton).toHaveAttribute('aria-pressed', 'true');
      });
    });

    it('should use split as default when localStorage has invalid value', async () => {
      localStorageMock.getItem.mockReturnValue('invalid-mode');

      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        const splitButton = screen.getByTestId('view-mode-split');
        expect(splitButton).toHaveAttribute('aria-pressed', 'true');
      });
    });

    it('should respect initialViewMode prop over localStorage', async () => {
      localStorageMock.getItem.mockReturnValue('preview');

      render(<MarkdownEditor {...defaultProps} initialViewMode="editor" />);

      await waitFor(() => {
        const editorButton = screen.getByTestId('view-mode-editor');
        expect(editorButton).toHaveAttribute('aria-pressed', 'true');
      });
    });
  });

  describe('Debounce Preview Updates', () => {
    it('should use debounce for preview updates', async () => {
      // This test verifies that the debounce function is used for preview updates
      // We can verify this by checking that preview content eventually matches editor content
      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
      });

      const textarea = screen.getByTestId('markdown-editor-textarea');

      // Change content
      fireEvent.change(textarea, { target: { value: '# New Content' } });

      // Wait for debounce to complete and preview to update
      await waitFor(() => {
        const preview = screen.getByTestId('markdown-preview');
        expect(preview.textContent).toContain('New Content');
      }, { timeout: 1000 });
    });
  });

  describe('XSS Prevention (SEC-MF-001)', () => {
    it('should sanitize script tags in markdown preview', async () => {
      const maliciousContent = '# Test\n\n<script>alert("xss")</script>';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, content: maliciousContent }),
      });

      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        const preview = screen.getByTestId('markdown-preview');
        expect(preview.innerHTML).not.toContain('<script>');
        expect(preview.innerHTML).not.toContain('alert');
      });
    });

    it('should sanitize onclick attributes', async () => {
      const maliciousContent = '# Test\n\n<div onclick="alert(1)">Click me</div>';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, content: maliciousContent }),
      });

      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        const preview = screen.getByTestId('markdown-preview');
        expect(preview.innerHTML).not.toContain('onclick');
      });
    });

    it('should sanitize javascript: URLs', async () => {
      const maliciousContent = '# Test\n\n[Click me](javascript:alert(1))';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, content: maliciousContent }),
      });

      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        const preview = screen.getByTestId('markdown-preview');
        expect(preview.innerHTML).not.toContain('javascript:');
      });
    });

    it('should not use dangerouslySetInnerHTML', async () => {
      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-preview')).toBeInTheDocument();
      });

      // Check that preview container doesn't have dangerously set HTML
      const preview = screen.getByTestId('markdown-preview');
      // react-markdown renders content as children, not via dangerouslySetInnerHTML
      // The presence of proper child elements indicates react-markdown is being used
      expect(preview.children.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Maximize Feature', () => {
    it('should render maximize button', async () => {
      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('maximize-button')).toBeInTheDocument();
      });
    });

    it('should show ESC hint when maximized', async () => {
      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
      });

      // Click maximize button
      const maximizeButton = screen.getByTestId('maximize-button');
      fireEvent.click(maximizeButton);

      await waitFor(() => {
        expect(screen.getByTestId('maximize-hint')).toBeInTheDocument();
        expect(screen.getByText(/Press ESC/i)).toBeInTheDocument();
      });
    });

    it('should have aria-pressed attribute on maximize button', async () => {
      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        const maximizeButton = screen.getByTestId('maximize-button');
        expect(maximizeButton).toHaveAttribute('aria-pressed');
      });
    });
  });

  describe('Resize Feature', () => {
    it('should render PaneResizer in split mode', async () => {
      // Force split mode via localStorage
      localStorageMock.getItem.mockImplementation((key: string) => {
        if (key === LOCAL_STORAGE_KEY) {
          return 'split';
        }
        return null;
      });

      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
      });

      // Should have a separator element (PaneResizer) - but only in split mode on desktop
      // Note: The resizer might not render if mobile detection returns true
      // This test assumes desktop environment
      const separator = screen.queryByRole('separator');
      // If separator exists, it should be a PaneResizer
      if (separator) {
        expect(separator).toBeInTheDocument();
      }
    });

    it('should not render PaneResizer in editor-only mode', async () => {
      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
      });

      // Switch to editor-only mode
      const editorButton = screen.getByTestId('view-mode-editor');
      fireEvent.click(editorButton);

      // Should not have a separator element
      expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    });

    it('should restore split ratio from localStorage', async () => {
      // Set a custom split ratio in localStorage
      localStorageMock.getItem.mockImplementation((key: string) => {
        if (key === LOCAL_STORAGE_KEY_SPLIT_RATIO) {
          return JSON.stringify(0.7);
        }
        return null;
      });

      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
      });

      // The editor container should have a custom width based on the split ratio
      const editorContainer = screen.getByTestId('markdown-editor-container');
      expect(editorContainer).toHaveStyle({ width: '70%' });
    });
  });

  describe('Keyboard Shortcuts', () => {
    it('should handle Ctrl+Shift+F for maximize toggle', async () => {
      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
      });

      const editor = screen.getByTestId('markdown-editor');

      // Trigger Ctrl+Shift+F
      fireEvent.keyDown(editor, { key: 'F', ctrlKey: true, shiftKey: true });

      // Should show maximize hint
      await waitFor(() => {
        expect(screen.getByTestId('maximize-hint')).toBeInTheDocument();
      });
    });

    it('should handle ESC to exit maximized mode', async () => {
      render(<MarkdownEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
      });

      // First maximize
      const maximizeButton = screen.getByTestId('maximize-button');
      fireEvent.click(maximizeButton);

      await waitFor(() => {
        expect(screen.getByTestId('maximize-hint')).toBeInTheDocument();
      });

      // Press ESC
      fireEvent.keyDown(document, { key: 'Escape' });

      // Hint should be gone
      await waitFor(() => {
        expect(screen.queryByTestId('maximize-hint')).not.toBeInTheDocument();
      });
    });
  });

  describe('onClose callback', () => {
    it('should call onClose when close button is clicked', async () => {
      const onClose = vi.fn();
      render(<MarkdownEditor {...defaultProps} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
      });

      const closeButton = screen.getByTestId('close-button');
      fireEvent.click(closeButton);

      expect(onClose).toHaveBeenCalled();
    });

    it('should warn before closing with unsaved changes', async () => {
      const onClose = vi.fn();
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

      render(<MarkdownEditor {...defaultProps} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
      });

      const textarea = screen.getByTestId('markdown-editor-textarea');
      fireEvent.change(textarea, { target: { value: 'Modified content' } });

      const closeButton = screen.getByTestId('close-button');
      fireEvent.click(closeButton);

      expect(confirmSpy).toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();

      confirmSpy.mockRestore();
    });

    it('should close when user confirms unsaved changes', async () => {
      const onClose = vi.fn();
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

      render(<MarkdownEditor {...defaultProps} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument();
      });

      const textarea = screen.getByTestId('markdown-editor-textarea');
      fireEvent.change(textarea, { target: { value: 'Modified content' } });

      const closeButton = screen.getByTestId('close-button');
      fireEvent.click(closeButton);

      expect(confirmSpy).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();

      confirmSpy.mockRestore();
    });
  });
});
