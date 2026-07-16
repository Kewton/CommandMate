/**
 * Tests for RepositoryManager component
 * Issue #71: Clone URL registration feature - UI extension
 *
 * TDD Phase 1: Red - Write failing tests first
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RepositoryManager } from '@/components/repository/RepositoryManager';

/**
 * Issue #1219: this file asserts the rendered wording, so it must resolve
 * through the real dictionary — tests/setup.ts's global mock would echo
 * `common.repositories.clone` back and every assertion below would pass
 * against a dictionary that has no such key. Backing them with locales/
 * turns the pre-existing English expectations into the byte-identity guard
 * for the i18n migration.
 */
const locale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => locale.current);
});

// Mock api-client module
vi.mock('@/lib/api-client', () => ({
  repositoryApi: {
    scan: vi.fn(),
    sync: vi.fn(),
    clone: vi.fn(),
    getCloneStatus: vi.fn(),
  },
  handleApiError: vi.fn((err) => {
    if (err instanceof Error) {
      return err.message;
    }
    if (err && typeof err === 'object' && 'message' in err) {
      return String(err.message);
    }
    return 'An error occurred';
  }),
}));

// Mock url-normalizer
vi.mock('@/lib/url-normalizer', () => ({
  UrlNormalizer: {
    getInstance: () => ({
      validate: vi.fn((url: string) => {
        if (!url || url.trim() === '') {
          return { valid: false, error: 'EMPTY_URL' };
        }
        if (url.startsWith('https://') || url.startsWith('git@')) {
          return { valid: true };
        }
        return { valid: false, error: 'INVALID_URL_FORMAT' };
      }),
      extractRepoName: vi.fn((url: string) => {
        const match = url.match(/\/([^\/]+?)(\.git)?$/);
        return match ? match[1] : '';
      }),
    }),
  },
}));

import { repositoryApi } from '@/lib/api-client';

describe('RepositoryManager', () => {
  const mockOnRepositoryAdded = vi.fn();

  beforeEach(() => {
    locale.current = 'en';
    vi.clearAllMocks();
    vi.mocked(repositoryApi.scan).mockResolvedValue({
      success: true,
      message: 'Repository added',
      worktreeCount: 3,
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
    });
    vi.mocked(repositoryApi.sync).mockResolvedValue({
      success: true,
      message: 'Synced',
      worktreeCount: 5,
      repositoryCount: 2,
      repositories: ['/path/to/repo1', '/path/to/repo2'],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Input Mode Toggle', () => {
    it('should display mode toggle when add form is shown', async () => {
      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      // Should have mode toggle with Local Path and Clone URL options
      expect(screen.getByRole('tab', { name: /local path/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /clone url/i })).toBeInTheDocument();
    });

    it('should default to local path mode', async () => {
      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      // Local path tab should be selected by default
      const localTab = screen.getByRole('tab', { name: /local path/i });
      expect(localTab).toHaveAttribute('aria-selected', 'true');

      // Should show local path input
      expect(screen.getByPlaceholderText('/absolute/path/to/repository')).toBeInTheDocument();
    });

    it('should switch to clone URL mode when URL tab is clicked', async () => {
      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      const urlTab = screen.getByRole('tab', { name: /clone url/i });
      fireEvent.mouseDown(urlTab);

      // Clone URL tab should be selected
      expect(urlTab).toHaveAttribute('aria-selected', 'true');

      // Should show clone URL input with placeholder
      expect(screen.getByPlaceholderText('https://github.com/user/repo.git')).toBeInTheDocument();
    });

    it('should preserve input when switching modes', async () => {
      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      // Enter local path
      const localInput = screen.getByPlaceholderText('/absolute/path/to/repository');
      fireEvent.change(localInput, { target: { value: '/my/local/path' } });

      // Switch to URL mode
      const urlTab = screen.getByRole('tab', { name: /clone url/i });
      fireEvent.mouseDown(urlTab);

      // Enter URL
      const urlInput = screen.getByPlaceholderText('https://github.com/user/repo.git');
      fireEvent.change(urlInput, { target: { value: 'https://github.com/user/repo.git' } });

      // Switch back to local mode
      const localTab = screen.getByRole('tab', { name: /local path/i });
      fireEvent.mouseDown(localTab);

      // Local path should be preserved
      expect(screen.getByDisplayValue('/my/local/path')).toBeInTheDocument();
    });
  });

  describe('Clone URL Input Form', () => {
    it('should show URL input field in clone mode', async () => {
      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      const urlTab = screen.getByRole('tab', { name: /clone url/i });
      fireEvent.mouseDown(urlTab);

      const urlInput = screen.getByLabelText(/clone url/i, { selector: 'input' });
      expect(urlInput).toBeInTheDocument();
      expect(urlInput).toHaveAttribute('placeholder', 'https://github.com/user/repo.git');
    });

    it('should show helper text for URL format', async () => {
      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      const urlTab = screen.getByRole('tab', { name: /clone url/i });
      fireEvent.mouseDown(urlTab);

      expect(screen.getByText(/supports https and ssh urls/i)).toBeInTheDocument();
    });

    it('should update clone URL state when typing', async () => {
      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      const urlTab = screen.getByRole('tab', { name: /clone url/i });
      fireEvent.mouseDown(urlTab);

      const urlInput = screen.getByPlaceholderText('https://github.com/user/repo.git');
      fireEvent.change(urlInput, { target: { value: 'https://github.com/test/myrepo.git' } });

      expect(urlInput).toHaveValue('https://github.com/test/myrepo.git');
    });
  });

  describe('URL Validation', () => {
    it('should show validation error for empty URL on submit', async () => {
      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      const urlTab = screen.getByRole('tab', { name: /clone url/i });
      fireEvent.mouseDown(urlTab);

      // Enter whitespace-only URL (button still disabled due to trim())
      const urlInput = screen.getByPlaceholderText('https://github.com/user/repo.git');
      fireEvent.change(urlInput, { target: { value: '   ' } });

      // Button should still be disabled because trim() makes it empty
      const submitButton = screen.getByRole('button', { name: /^clone$/i });
      expect(submitButton).toBeDisabled();
    });

    it('should show validation error for invalid URL format', async () => {
      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      const urlTab = screen.getByRole('tab', { name: /clone url/i });
      fireEvent.mouseDown(urlTab);

      const urlInput = screen.getByPlaceholderText('https://github.com/user/repo.git');
      fireEvent.change(urlInput, { target: { value: 'not-a-valid-url' } });

      const submitButton = screen.getByRole('button', { name: /^clone$/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText(/invalid url format/i)).toBeInTheDocument();
      });
    });

    it('should validate HTTPS URL format', async () => {
      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      const urlTab = screen.getByRole('tab', { name: /clone url/i });
      fireEvent.mouseDown(urlTab);

      const urlInput = screen.getByPlaceholderText('https://github.com/user/repo.git');
      fireEvent.change(urlInput, { target: { value: 'https://github.com/user/myrepo.git' } });

      // No validation error should be shown
      expect(screen.queryByText(/invalid url format/i)).not.toBeInTheDocument();
    });

    it('should validate SSH URL format', async () => {
      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      const urlTab = screen.getByRole('tab', { name: /clone url/i });
      fireEvent.mouseDown(urlTab);

      const urlInput = screen.getByPlaceholderText('https://github.com/user/repo.git');
      fireEvent.change(urlInput, { target: { value: 'git@github.com:user/myrepo.git' } });

      // No validation error should be shown
      expect(screen.queryByText(/invalid url format/i)).not.toBeInTheDocument();
    });
  });

  describe('Clone Execution', () => {
    beforeEach(() => {
      vi.mocked(repositoryApi.clone).mockResolvedValue({
        success: true,
        jobId: 'job-123',
        status: 'pending',
        message: 'Clone job started',
      });
    });

    it('should call clone API when clone button is clicked', async () => {
      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      const urlTab = screen.getByRole('tab', { name: /clone url/i });
      fireEvent.mouseDown(urlTab);

      const urlInput = screen.getByPlaceholderText('https://github.com/user/repo.git');
      fireEvent.change(urlInput, { target: { value: 'https://github.com/user/myrepo.git' } });

      const cloneButton = screen.getByRole('button', { name: /^clone$/i });
      fireEvent.click(cloneButton);

      await waitFor(() => {
        expect(repositoryApi.clone).toHaveBeenCalledWith('https://github.com/user/myrepo.git');
      });
    });

    it('should show loading state while cloning', async () => {
      // Make clone take time
      vi.mocked(repositoryApi.clone).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({
          success: true,
          jobId: 'job-123',
          status: 'pending',
          message: 'Clone job started',
        }), 100))
      );

      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      const urlTab = screen.getByRole('tab', { name: /clone url/i });
      fireEvent.mouseDown(urlTab);

      const urlInput = screen.getByPlaceholderText('https://github.com/user/repo.git');
      fireEvent.change(urlInput, { target: { value: 'https://github.com/user/myrepo.git' } });

      const cloneButton = screen.getByRole('button', { name: /^clone$/i });
      fireEvent.click(cloneButton);

      // Should show cloning state
      expect(screen.getByText(/cloning/i)).toBeInTheDocument();
    });

    it('should disable clone button while cloning', async () => {
      vi.mocked(repositoryApi.clone).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({
          success: true,
          jobId: 'job-123',
          status: 'pending',
          message: 'Clone job started',
        }), 100))
      );

      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      const urlTab = screen.getByRole('tab', { name: /clone url/i });
      fireEvent.mouseDown(urlTab);

      const urlInput = screen.getByPlaceholderText('https://github.com/user/repo.git');
      fireEvent.change(urlInput, { target: { value: 'https://github.com/user/myrepo.git' } });

      const cloneButton = screen.getByRole('button', { name: /^clone$/i });
      fireEvent.click(cloneButton);

      // Button should be disabled
      expect(cloneButton).toBeDisabled();
    });

    it('should show error message when clone fails', async () => {
      vi.mocked(repositoryApi.clone).mockRejectedValue(new Error('Clone failed'));

      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      const urlTab = screen.getByRole('tab', { name: /clone url/i });
      fireEvent.mouseDown(urlTab);

      const urlInput = screen.getByPlaceholderText('https://github.com/user/repo.git');
      fireEvent.change(urlInput, { target: { value: 'https://github.com/user/myrepo.git' } });

      const cloneButton = screen.getByRole('button', { name: /^clone$/i });
      fireEvent.click(cloneButton);

      await waitFor(() => {
        expect(screen.getByText(/clone failed/i)).toBeInTheDocument();
      });
    });
  });

  describe('Clone Progress', () => {
    beforeEach(() => {
      vi.mocked(repositoryApi.clone).mockResolvedValue({
        success: true,
        jobId: 'job-123',
        status: 'pending',
        message: 'Clone job started',
      });
    });

    it('should poll clone status after job starts', async () => {
      vi.mocked(repositoryApi.getCloneStatus)
        .mockResolvedValueOnce({
          success: true,
          jobId: 'job-123',
          status: 'running',
          progress: 50,
        })
        .mockResolvedValueOnce({
          success: true,
          jobId: 'job-123',
          status: 'completed',
          progress: 100,
          repositoryId: 'repo-456',
        });

      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      const urlTab = screen.getByRole('tab', { name: /clone url/i });
      fireEvent.mouseDown(urlTab);

      const urlInput = screen.getByPlaceholderText('https://github.com/user/repo.git');
      fireEvent.change(urlInput, { target: { value: 'https://github.com/user/myrepo.git' } });

      const cloneButton = screen.getByRole('button', { name: /^clone$/i });
      fireEvent.click(cloneButton);

      await waitFor(() => {
        expect(repositoryApi.getCloneStatus).toHaveBeenCalledWith('job-123');
      });
    });

    it('should show success message when clone completes', async () => {
      vi.mocked(repositoryApi.getCloneStatus).mockResolvedValue({
        success: true,
        jobId: 'job-123',
        status: 'completed',
        progress: 100,
        repositoryId: 'repo-456',
      });

      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      const urlTab = screen.getByRole('tab', { name: /clone url/i });
      fireEvent.mouseDown(urlTab);

      const urlInput = screen.getByPlaceholderText('https://github.com/user/repo.git');
      fireEvent.change(urlInput, { target: { value: 'https://github.com/user/myrepo.git' } });

      const cloneButton = screen.getByRole('button', { name: /^clone$/i });
      fireEvent.click(cloneButton);

      await waitFor(() => {
        expect(screen.getByText(/repository cloned successfully/i)).toBeInTheDocument();
      });
    });

    it('should call onRepositoryAdded when clone completes', async () => {
      vi.mocked(repositoryApi.getCloneStatus).mockResolvedValue({
        success: true,
        jobId: 'job-123',
        status: 'completed',
        progress: 100,
        repositoryId: 'repo-456',
      });

      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      const urlTab = screen.getByRole('tab', { name: /clone url/i });
      fireEvent.mouseDown(urlTab);

      const urlInput = screen.getByPlaceholderText('https://github.com/user/repo.git');
      fireEvent.change(urlInput, { target: { value: 'https://github.com/user/myrepo.git' } });

      const cloneButton = screen.getByRole('button', { name: /^clone$/i });
      fireEvent.click(cloneButton);

      await waitFor(() => {
        expect(mockOnRepositoryAdded).toHaveBeenCalled();
      });
    });

    it('should show error when clone job fails', async () => {
      vi.mocked(repositoryApi.getCloneStatus).mockResolvedValue({
        success: true,
        jobId: 'job-123',
        status: 'failed',
        progress: 0,
        error: {
          category: 'git',
          code: 'CLONE_FAILED',
          message: 'Repository not found',
        },
      });

      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      const urlTab = screen.getByRole('tab', { name: /clone url/i });
      fireEvent.mouseDown(urlTab);

      const urlInput = screen.getByPlaceholderText('https://github.com/user/repo.git');
      fireEvent.change(urlInput, { target: { value: 'https://github.com/user/myrepo.git' } });

      const cloneButton = screen.getByRole('button', { name: /^clone$/i });
      fireEvent.click(cloneButton);

      await waitFor(() => {
        expect(screen.getByText(/repository not found/i)).toBeInTheDocument();
      });
    });

    /**
     * Issue #1219: `t` is referentially unstable per render, so keying the
     * clone-status effect on pollCloneStatus re-enters polling on every render
     * and leaves a self-perpetuating setTimeout chain behind each time. Pins the
     * effect to the job itself — without it, the re-renders below take this from
     * 1 poll to 6.
     */
    it('should not restart polling when the component re-renders', async () => {
      vi.mocked(repositoryApi.getCloneStatus).mockResolvedValue({
        success: true,
        jobId: 'job-123',
        status: 'running',
        progress: 50,
      });

      const { rerender } = render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      fireEvent.click(screen.getByRole('button', { name: /add repository/i }));
      fireEvent.mouseDown(screen.getByRole('tab', { name: /clone url/i }));
      fireEvent.change(screen.getByPlaceholderText('https://github.com/user/repo.git'), {
        target: { value: 'https://github.com/user/myrepo.git' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^clone$/i }));

      await waitFor(() => expect(repositoryApi.getCloneStatus).toHaveBeenCalled());
      const pollsAfterStart = vi.mocked(repositoryApi.getCloneStatus).mock.calls.length;

      for (let i = 0; i < 5; i++) {
        rerender(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);
      }

      expect(vi.mocked(repositoryApi.getCloneStatus).mock.calls.length).toBe(pollsAfterStart);
    });

    it('should reset form after successful clone', async () => {
      vi.mocked(repositoryApi.getCloneStatus).mockResolvedValue({
        success: true,
        jobId: 'job-123',
        status: 'completed',
        progress: 100,
        repositoryId: 'repo-456',
      });

      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      const urlTab = screen.getByRole('tab', { name: /clone url/i });
      fireEvent.mouseDown(urlTab);

      const urlInput = screen.getByPlaceholderText('https://github.com/user/repo.git');
      fireEvent.change(urlInput, { target: { value: 'https://github.com/user/myrepo.git' } });

      const cloneButton = screen.getByRole('button', { name: /^clone$/i });
      fireEvent.click(cloneButton);

      await waitFor(() => {
        // Form should be hidden
        expect(screen.queryByPlaceholderText('https://github.com/user/repo.git')).not.toBeInTheDocument();
      });
    });
  });

  describe('Error Handling', () => {
    it('should show duplicate URL error', async () => {
      vi.mocked(repositoryApi.clone).mockRejectedValue({
        message: 'Repository with this URL already exists',
        status: 409,
      });

      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      const urlTab = screen.getByRole('tab', { name: /clone url/i });
      fireEvent.mouseDown(urlTab);

      const urlInput = screen.getByPlaceholderText('https://github.com/user/repo.git');
      fireEvent.change(urlInput, { target: { value: 'https://github.com/user/myrepo.git' } });

      const cloneButton = screen.getByRole('button', { name: /^clone$/i });
      fireEvent.click(cloneButton);

      await waitFor(() => {
        expect(screen.getByText(/repository with this url already exists/i)).toBeInTheDocument();
      });
    });

    it('should show network error message', async () => {
      vi.mocked(repositoryApi.clone).mockRejectedValue(new Error('Network error'));

      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      const urlTab = screen.getByRole('tab', { name: /clone url/i });
      fireEvent.mouseDown(urlTab);

      const urlInput = screen.getByPlaceholderText('https://github.com/user/repo.git');
      fireEvent.change(urlInput, { target: { value: 'https://github.com/user/myrepo.git' } });

      const cloneButton = screen.getByRole('button', { name: /^clone$/i });
      fireEvent.click(cloneButton);

      await waitFor(() => {
        expect(screen.getByText(/network error/i)).toBeInTheDocument();
      });
    });
  });

  describe('Cancel Button', () => {
    it('should reset form when cancel is clicked in URL mode', async () => {
      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      const urlTab = screen.getByRole('tab', { name: /clone url/i });
      fireEvent.mouseDown(urlTab);

      const urlInput = screen.getByPlaceholderText('https://github.com/user/repo.git');
      fireEvent.change(urlInput, { target: { value: 'https://github.com/user/myrepo.git' } });

      const cancelButton = screen.getByRole('button', { name: /cancel/i });
      fireEvent.click(cancelButton);

      // Form should be hidden
      expect(screen.queryByPlaceholderText('https://github.com/user/repo.git')).not.toBeInTheDocument();
    });
  });

  describe('Existing Local Path Functionality', () => {
    it('should still work with local path mode', async () => {
      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      // Default should be local path mode
      const pathInput = screen.getByPlaceholderText('/absolute/path/to/repository');
      fireEvent.change(pathInput, { target: { value: '/Users/test/myrepo' } });

      const scanButton = screen.getByRole('button', { name: /scan & add/i });
      fireEvent.click(scanButton);

      await waitFor(() => {
        expect(repositoryApi.scan).toHaveBeenCalledWith('/Users/test/myrepo');
      });
    });

    it('should show scan button in local mode, clone button in URL mode', async () => {
      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      const addButton = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addButton);

      // Local mode - should show Scan & Add button
      expect(screen.getByRole('button', { name: /scan & add/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^clone$/i })).not.toBeInTheDocument();

      // Switch to URL mode
      const urlTab = screen.getByRole('tab', { name: /clone url/i });
      fireEvent.mouseDown(urlTab);

      // URL mode - should show Clone button
      expect(screen.getByRole('button', { name: /^clone$/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /scan & add/i })).not.toBeInTheDocument();
    });
  });

  /**
   * Issue #1219: #1199's onboarding CTA is Japanese, so landing on an English
   * form here is the reported defect. Everything above pins the English copy;
   * these pin that `ja` actually resolves to Japanese.
   */
  describe('Japanese locale (Issue #1219)', () => {
    beforeEach(() => {
      locale.current = 'ja';
    });

    it('renders the add/sync actions in Japanese', () => {
      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);

      expect(screen.getByRole('button', { name: '+ リポジトリを追加' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'すべて同期' })).toBeInTheDocument();
    });

    it('renders the add form heading, tabs and actions in Japanese', () => {
      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);
      fireEvent.click(screen.getByRole('button', { name: '+ リポジトリを追加' }));

      expect(screen.getByRole('heading', { name: 'リポジトリを新規追加' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'ローカルパス' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'クローン URL' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'スキャンして追加' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'キャンセル' })).toBeInTheDocument();
    });

    it('renders validation errors in Japanese', async () => {
      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);
      fireEvent.click(screen.getByRole('button', { name: '+ リポジトリを追加' }));
      fireEvent.mouseDown(screen.getByRole('tab', { name: 'クローン URL' }));

      const urlInput = screen.getByPlaceholderText('https://github.com/user/repo.git');
      fireEvent.change(urlInput, { target: { value: 'not-a-valid-url' } });
      fireEvent.click(screen.getByRole('button', { name: 'クローン' }));

      await waitFor(() => {
        expect(screen.getByText('URL の形式が正しくありません')).toBeInTheDocument();
      });
    });

    /**
     * The example path and placeholders stay literal in both locales: they are
     * copy-paste sample values, not prose, so translating them would only make
     * them wrong to paste.
     */
    it('keeps the technical example values untranslated', () => {
      render(<RepositoryManager onRepositoryAdded={mockOnRepositoryAdded} />);
      fireEvent.click(screen.getByRole('button', { name: '+ リポジトリを追加' }));

      expect(screen.getByPlaceholderText('/absolute/path/to/repository')).toBeInTheDocument();
      expect(screen.getByText('例: /Users/username/projects/my-repo')).toBeInTheDocument();
    });
  });
});
