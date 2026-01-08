/**
 * Tests for FileTreeView component
 *
 * Tests the file tree view with lazy loading, expand/collapse, and file selection
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileTreeView } from '@/components/worktree/FileTreeView';
import type { TreeResponse } from '@/types/models';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('FileTreeView', () => {
  const mockRootData: TreeResponse = {
    path: '',
    name: '',
    items: [
      { name: 'src', type: 'directory', itemCount: 5 },
      { name: 'package.json', type: 'file', size: 1024, extension: 'json' },
      { name: 'README.md', type: 'file', size: 2048, extension: 'md' },
    ],
    parentPath: null,
  };

  const mockSrcData: TreeResponse = {
    path: 'src',
    name: 'src',
    items: [
      { name: 'components', type: 'directory', itemCount: 3 },
      { name: 'index.ts', type: 'file', size: 512, extension: 'ts' },
    ],
    parentPath: '',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/tree/src')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockSrcData),
        });
      }
      if (url.includes('/tree')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockRootData),
        });
      }
      return Promise.reject(new Error('Not found'));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic rendering', () => {
    it('should render loading state initially', () => {
      render(<FileTreeView worktreeId="test-worktree" />);
      expect(screen.getByTestId('file-tree-loading')).toBeInTheDocument();
    });

    it('should render tree items after loading', async () => {
      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        expect(screen.getByText('src')).toBeInTheDocument();
        expect(screen.getByText('package.json')).toBeInTheDocument();
        expect(screen.getByText('README.md')).toBeInTheDocument();
      });
    });

    it('should fetch root directory on mount', async () => {
      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/worktrees/test-worktree/tree');
      });
    });

    it('should apply custom className', async () => {
      render(<FileTreeView worktreeId="test-worktree" className="custom-class" />);

      await waitFor(() => {
        const container = screen.getByTestId('file-tree-view');
        expect(container).toHaveClass('custom-class');
      });
    });
  });

  describe('Directory expand/collapse', () => {
    it('should show chevron icon for directories', async () => {
      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        const srcItem = screen.getByTestId('tree-item-src');
        expect(srcItem.querySelector('[data-testid="chevron-icon"]')).toBeInTheDocument();
      });
    });

    it('should not show chevron for files', async () => {
      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        const fileItem = screen.getByTestId('tree-item-package.json');
        expect(fileItem.querySelector('[data-testid="chevron-icon"]')).not.toBeInTheDocument();
      });
    });

    it('should expand directory on click', async () => {
      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        expect(screen.getByText('src')).toBeInTheDocument();
      });

      const srcItem = screen.getByTestId('tree-item-src');
      fireEvent.click(srcItem);

      await waitFor(() => {
        expect(screen.getByText('components')).toBeInTheDocument();
        expect(screen.getByText('index.ts')).toBeInTheDocument();
      });
    });

    it('should fetch subdirectory data on expand', async () => {
      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        expect(screen.getByText('src')).toBeInTheDocument();
      });

      const srcItem = screen.getByTestId('tree-item-src');
      fireEvent.click(srcItem);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/worktrees/test-worktree/tree/src');
      });
    });

    it('should collapse directory on second click', async () => {
      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        expect(screen.getByText('src')).toBeInTheDocument();
      });

      const srcItem = screen.getByTestId('tree-item-src');

      // Expand
      fireEvent.click(srcItem);
      await waitFor(() => {
        expect(screen.getByText('index.ts')).toBeInTheDocument();
      });

      // Collapse
      fireEvent.click(srcItem);
      await waitFor(() => {
        expect(screen.queryByText('index.ts')).not.toBeInTheDocument();
      });
    });

    it('should cache loaded directories', async () => {
      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        expect(screen.getByText('src')).toBeInTheDocument();
      });

      const srcItem = screen.getByTestId('tree-item-src');

      // First expand
      fireEvent.click(srcItem);
      await waitFor(() => {
        expect(screen.getByText('index.ts')).toBeInTheDocument();
      });

      // Collapse
      fireEvent.click(srcItem);
      await waitFor(() => {
        expect(screen.queryByText('index.ts')).not.toBeInTheDocument();
      });

      // Clear call count
      mockFetch.mockClear();

      // Second expand - should use cache
      fireEvent.click(srcItem);
      await waitFor(() => {
        expect(screen.getByText('index.ts')).toBeInTheDocument();
      });

      // Should not have fetched again
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('File selection', () => {
    it('should call onFileSelect when file is clicked', async () => {
      const onFileSelect = vi.fn();
      render(<FileTreeView worktreeId="test-worktree" onFileSelect={onFileSelect} />);

      await waitFor(() => {
        expect(screen.getByText('package.json')).toBeInTheDocument();
      });

      const fileItem = screen.getByTestId('tree-item-package.json');
      fireEvent.click(fileItem);

      expect(onFileSelect).toHaveBeenCalledWith('package.json');
    });

    it('should call onFileSelect with full path for nested files', async () => {
      const onFileSelect = vi.fn();
      render(<FileTreeView worktreeId="test-worktree" onFileSelect={onFileSelect} />);

      await waitFor(() => {
        expect(screen.getByText('src')).toBeInTheDocument();
      });

      // Expand src directory
      const srcItem = screen.getByTestId('tree-item-src');
      fireEvent.click(srcItem);

      await waitFor(() => {
        expect(screen.getByText('index.ts')).toBeInTheDocument();
      });

      const indexFile = screen.getByTestId('tree-item-index.ts');
      fireEvent.click(indexFile);

      expect(onFileSelect).toHaveBeenCalledWith('src/index.ts');
    });

    it('should not call onFileSelect when directory is clicked', async () => {
      const onFileSelect = vi.fn();
      render(<FileTreeView worktreeId="test-worktree" onFileSelect={onFileSelect} />);

      await waitFor(() => {
        expect(screen.getByText('src')).toBeInTheDocument();
      });

      const srcItem = screen.getByTestId('tree-item-src');
      fireEvent.click(srcItem);

      // onFileSelect should NOT be called for directories
      expect(onFileSelect).not.toHaveBeenCalled();
    });
  });

  describe('Icons', () => {
    it('should show folder icon for directories', async () => {
      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        const srcItem = screen.getByTestId('tree-item-src');
        expect(srcItem.querySelector('[data-testid="folder-icon"]')).toBeInTheDocument();
      });
    });

    it('should show file icon for files', async () => {
      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        const fileItem = screen.getByTestId('tree-item-package.json');
        expect(fileItem.querySelector('[data-testid="file-icon"]')).toBeInTheDocument();
      });
    });
  });

  describe('Indentation', () => {
    it('should indent nested items', async () => {
      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        expect(screen.getByText('src')).toBeInTheDocument();
      });

      // Expand src directory
      const srcItem = screen.getByTestId('tree-item-src');
      fireEvent.click(srcItem);

      await waitFor(() => {
        const indexItem = screen.getByTestId('tree-item-index.ts');
        // Check for indentation class or style
        expect(indexItem).toHaveClass('pl-6');
      });
    });
  });

  describe('File size formatting', () => {
    it('should display file size in bytes for small files', async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              path: '',
              name: '',
              items: [{ name: 'tiny.txt', type: 'file', size: 100, extension: 'txt' }],
              parentPath: null,
            }),
        })
      );

      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        expect(screen.getByText(/100/)).toBeInTheDocument();
      });
    });

    it('should display file size in KB for larger files', async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              path: '',
              name: '',
              items: [{ name: 'medium.txt', type: 'file', size: 2048, extension: 'txt' }],
              parentPath: null,
            }),
        })
      );

      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        expect(screen.getByText(/2.*KB/i)).toBeInTheDocument();
      });
    });
  });

  describe('Error handling', () => {
    it('should show error message on fetch failure', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        expect(screen.getByTestId('file-tree-error')).toBeInTheDocument();
      });
    });

    it('should show error message on non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: 'Not found' }),
      });

      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        expect(screen.getByTestId('file-tree-error')).toBeInTheDocument();
      });
    });
  });

  describe('Empty state', () => {
    it('should show empty message when directory is empty', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            path: '',
            name: '',
            items: [],
            parentPath: null,
          }),
      });

      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        expect(screen.getByTestId('file-tree-empty')).toBeInTheDocument();
      });
    });
  });

  describe('Hover and selection states', () => {
    it('should highlight item on hover', async () => {
      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        expect(screen.getByText('package.json')).toBeInTheDocument();
      });

      const fileItem = screen.getByTestId('tree-item-package.json');
      fireEvent.mouseEnter(fileItem);

      expect(fileItem).toHaveClass('hover:bg-gray-100');
    });
  });

  describe('Accessibility', () => {
    it('should have accessible tree role', async () => {
      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        expect(screen.getByRole('tree')).toBeInTheDocument();
      });
    });

    it('should have treeitem role for items', async () => {
      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        const items = screen.getAllByRole('treeitem');
        expect(items.length).toBeGreaterThan(0);
      });
    });

    it('should have aria-expanded for directories', async () => {
      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        const srcItem = screen.getByTestId('tree-item-src');
        expect(srcItem).toHaveAttribute('aria-expanded', 'false');
      });
    });
  });

  describe('Keyboard navigation', () => {
    it('should expand directory on Enter key', async () => {
      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        expect(screen.getByText('src')).toBeInTheDocument();
      });

      const srcItem = screen.getByTestId('tree-item-src');
      fireEvent.keyDown(srcItem, { key: 'Enter' });

      await waitFor(() => {
        expect(screen.getByText('index.ts')).toBeInTheDocument();
      });
    });

    it('should select file on Enter key', async () => {
      const onFileSelect = vi.fn();
      render(<FileTreeView worktreeId="test-worktree" onFileSelect={onFileSelect} />);

      await waitFor(() => {
        expect(screen.getByText('package.json')).toBeInTheDocument();
      });

      const fileItem = screen.getByTestId('tree-item-package.json');
      fireEvent.keyDown(fileItem, { key: 'Enter' });

      expect(onFileSelect).toHaveBeenCalledWith('package.json');
    });
  });
});
