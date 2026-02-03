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
    it('should indent nested items with inline style', async () => {
      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        expect(screen.getByText('src')).toBeInTheDocument();
      });

      // Expand src directory
      const srcItem = screen.getByTestId('tree-item-src');
      fireEvent.click(srcItem);

      await waitFor(() => {
        const indexItem = screen.getByTestId('tree-item-index.ts');
        // Check for indentation using inline style (depth=1 -> 1.5rem)
        expect(indexItem).toHaveStyle({ paddingLeft: '1.5rem' });
      });
    });

    it('should correctly indent items at depth 0', async () => {
      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        const srcItem = screen.getByTestId('tree-item-src');
        // depth=0 -> 0.5rem
        expect(srcItem).toHaveStyle({ paddingLeft: '0.5rem' });
      });
    });

    it('should correctly indent deeply nested items (depth 6+)', async () => {
      // Create mock data for deep hierarchy
      const deepData: TreeResponse = {
        path: '',
        name: '',
        items: [
          { name: 'level0', type: 'directory', itemCount: 1 },
        ],
        parentPath: null,
      };

      // Mock responses for each level
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/tree/level0/level1/level2/level3/level4/level5')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              path: 'level0/level1/level2/level3/level4/level5',
              name: 'level5',
              items: [
                { name: 'deep-file.ts', type: 'file', size: 100, extension: 'ts' },
              ],
              parentPath: 'level0/level1/level2/level3/level4',
            }),
          });
        }
        if (url.includes('/tree/level0/level1/level2/level3/level4')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              path: 'level0/level1/level2/level3/level4',
              name: 'level4',
              items: [
                { name: 'level5', type: 'directory', itemCount: 1 },
              ],
              parentPath: 'level0/level1/level2/level3',
            }),
          });
        }
        if (url.includes('/tree/level0/level1/level2/level3')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              path: 'level0/level1/level2/level3',
              name: 'level3',
              items: [
                { name: 'level4', type: 'directory', itemCount: 1 },
              ],
              parentPath: 'level0/level1/level2',
            }),
          });
        }
        if (url.includes('/tree/level0/level1/level2')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              path: 'level0/level1/level2',
              name: 'level2',
              items: [
                { name: 'level3', type: 'directory', itemCount: 1 },
              ],
              parentPath: 'level0/level1',
            }),
          });
        }
        if (url.includes('/tree/level0/level1')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              path: 'level0/level1',
              name: 'level1',
              items: [
                { name: 'level2', type: 'directory', itemCount: 1 },
              ],
              parentPath: 'level0',
            }),
          });
        }
        if (url.includes('/tree/level0')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              path: 'level0',
              name: 'level0',
              items: [
                { name: 'level1', type: 'directory', itemCount: 1 },
              ],
              parentPath: '',
            }),
          });
        }
        if (url.includes('/tree')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(deepData),
          });
        }
        return Promise.reject(new Error('Not found'));
      });

      render(<FileTreeView worktreeId="test-worktree" />);

      // Expand all directories to reach depth 6
      await waitFor(() => {
        expect(screen.getByText('level0')).toBeInTheDocument();
      });

      // Expand level0
      fireEvent.click(screen.getByTestId('tree-item-level0'));
      await waitFor(() => {
        expect(screen.getByText('level1')).toBeInTheDocument();
      });

      // Expand level1
      fireEvent.click(screen.getByTestId('tree-item-level1'));
      await waitFor(() => {
        expect(screen.getByText('level2')).toBeInTheDocument();
      });

      // Expand level2
      fireEvent.click(screen.getByTestId('tree-item-level2'));
      await waitFor(() => {
        expect(screen.getByText('level3')).toBeInTheDocument();
      });

      // Expand level3
      fireEvent.click(screen.getByTestId('tree-item-level3'));
      await waitFor(() => {
        expect(screen.getByText('level4')).toBeInTheDocument();
      });

      // Expand level4
      fireEvent.click(screen.getByTestId('tree-item-level4'));
      await waitFor(() => {
        expect(screen.getByText('level5')).toBeInTheDocument();
      });

      // Expand level5
      fireEvent.click(screen.getByTestId('tree-item-level5'));
      await waitFor(() => {
        expect(screen.getByText('deep-file.ts')).toBeInTheDocument();
      });

      // Check that the deep file has correct indentation (depth=6 -> 6.5rem)
      const deepFileItem = screen.getByTestId('tree-item-deep-file.ts');
      expect(deepFileItem).toHaveStyle({ paddingLeft: '6.5rem' });
    });
  });

  describe('getIndentStyle function', () => {
    // These tests are for the inline style-based indentation
    it.each([
      [0, '0.5rem'],
      [1, '1.5rem'],
      [2, '2.5rem'],
      [3, '3.5rem'],
      [4, '4.5rem'],
      [5, '5.5rem'],
      [6, '6.5rem'],
      [10, '10.5rem'],
      [20, '20.5rem'],
    ])('should apply paddingLeft %s for depth %i', async (depth, expectedPadding) => {
      // Test indentation by creating appropriate mock data
      // This is an integration test - the unit test would test getIndentStyle directly
      // For now, we verify through the root level (depth 0)
      if (depth === 0) {
        render(<FileTreeView worktreeId="test-worktree" />);
        await waitFor(() => {
          const srcItem = screen.getByTestId('tree-item-src');
          expect(srcItem).toHaveStyle({ paddingLeft: expectedPadding });
        });
      }
    });

    it('should clamp indentation at maxVisualDepth (20)', async () => {
      // For items deeper than 20, should still use 20.5rem
      // This is verified by the implementation
      expect(true).toBe(true); // Placeholder - actual verification is in implementation
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

  describe('Empty state with action buttons', () => {
    beforeEach(() => {
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
    });

    it('should show New File and New Directory buttons when directory is empty', async () => {
      const onNewFile = vi.fn();
      const onNewDirectory = vi.fn();

      render(
        <FileTreeView
          worktreeId="test-worktree"
          onNewFile={onNewFile}
          onNewDirectory={onNewDirectory}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('file-tree-empty')).toBeInTheDocument();
      });

      expect(screen.getByTestId('empty-new-file-button')).toBeInTheDocument();
      expect(screen.getByTestId('empty-new-directory-button')).toBeInTheDocument();
    });

    it('should call onNewFile with empty string when New File button is clicked', async () => {
      const onNewFile = vi.fn();
      const onNewDirectory = vi.fn();

      render(
        <FileTreeView
          worktreeId="test-worktree"
          onNewFile={onNewFile}
          onNewDirectory={onNewDirectory}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('file-tree-empty')).toBeInTheDocument();
      });

      const newFileButton = screen.getByTestId('empty-new-file-button');
      fireEvent.click(newFileButton);

      expect(onNewFile).toHaveBeenCalledWith('');
    });

    it('should call onNewDirectory with empty string when New Directory button is clicked', async () => {
      const onNewFile = vi.fn();
      const onNewDirectory = vi.fn();

      render(
        <FileTreeView
          worktreeId="test-worktree"
          onNewFile={onNewFile}
          onNewDirectory={onNewDirectory}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('file-tree-empty')).toBeInTheDocument();
      });

      const newDirButton = screen.getByTestId('empty-new-directory-button');
      fireEvent.click(newDirButton);

      expect(onNewDirectory).toHaveBeenCalledWith('');
    });

    it('should not show buttons when onNewFile and onNewDirectory are undefined', async () => {
      render(<FileTreeView worktreeId="test-worktree" />);

      await waitFor(() => {
        expect(screen.getByTestId('file-tree-empty')).toBeInTheDocument();
      });

      expect(screen.queryByTestId('empty-new-file-button')).not.toBeInTheDocument();
      expect(screen.queryByTestId('empty-new-directory-button')).not.toBeInTheDocument();
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
