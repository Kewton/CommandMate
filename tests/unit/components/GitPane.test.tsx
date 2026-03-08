/**
 * Unit tests for GitPane component
 * Issue #447: Git tab feature
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { GitPane } from '@/components/worktree/GitPane';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('GitPane', () => {
  const defaultProps = {
    worktreeId: 'test-worktree-id',
    onDiffSelect: vi.fn() as (diff: string, filePath: string) => void,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  describe('Loading state', () => {
    it('should show loading indicator on mount', () => {
      mockFetch.mockReturnValue(new Promise(() => {})); // Never resolves
      render(<GitPane {...defaultProps} />);

      expect(screen.getByRole('status')).toBeInTheDocument();
    });
  });

  describe('Empty state', () => {
    it('should show empty message when no commits', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ commits: [] }),
      });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('No commits found')).toBeInTheDocument();
      });
    });
  });

  describe('Error state', () => {
    it('should show error message on fetch failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Not a git repository' }),
      });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(screen.getByText('Not a git repository')).toBeInTheDocument();
      });
    });

    it('should show error on network failure', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Failed to fetch commit history')).toBeInTheDocument();
      });
    });
  });

  describe('Commit list', () => {
    it('should display commit list', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          commits: [
            { hash: 'abc1234', shortHash: 'abc1234', message: 'feat: add feature', author: 'Author', date: '2026-03-08T00:00:00Z' },
            { hash: 'def5678', shortHash: 'def5678', message: 'fix: resolve bug', author: 'Author2', date: '2026-03-07T00:00:00Z' },
          ],
        }),
      });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('abc1234')).toBeInTheDocument();
        expect(screen.getByText('feat: add feature')).toBeInTheDocument();
        expect(screen.getByText('def5678')).toBeInTheDocument();
        expect(screen.getByText('fix: resolve bug')).toBeInTheDocument();
      });
    });
  });

  describe('Refresh button', () => {
    it('should have a refresh button', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ commits: [] }),
      });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByLabelText('Refresh commit history')).toBeInTheDocument();
      });
    });

    it('should refetch commits on refresh click', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ commits: [] }),
      });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('No commits found')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByLabelText('Refresh commit history'));

      // Should have been called twice (initial + refresh)
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('Commit selection', () => {
    it('should fetch changed files when commit is clicked', async () => {
      // First call: git log
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            commits: [
              { hash: 'abc1234', shortHash: 'abc1234', message: 'test', author: 'a', date: '2026-01-01' },
            ],
          }),
        })
        // Second call: git show
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            commit: { hash: 'abc1234', shortHash: 'abc1234', message: 'test', author: 'a', date: '2026-01-01' },
            files: [{ path: 'src/file.ts', status: 'modified' }],
          }),
        });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('abc1234')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('test'));

      await waitFor(() => {
        expect(screen.getByText('Changed Files')).toBeInTheDocument();
        expect(screen.getByText('src/file.ts')).toBeInTheDocument();
      });
    });
  });

  describe('Header', () => {
    it('should show Commit History title', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ commits: [] }),
      });

      render(<GitPane {...defaultProps} />);

      expect(screen.getByText('Commit History')).toBeInTheDocument();
    });
  });

  describe('Custom className', () => {
    it('should apply custom className', () => {
      mockFetch.mockReturnValue(new Promise(() => {}));
      const { container } = render(<GitPane {...defaultProps} className="custom-class" />);

      expect(container.firstChild).toHaveClass('custom-class');
    });
  });
});
