/**
 * Tests for RepositoryList component
 * Issue #644: Repository list display and inline display_name edit UI
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { RepositoryList } from '@/components/repository/RepositoryList';
import type { RepositoryListItem } from '@/lib/api-client';

// Mock api-client module
vi.mock('@/lib/api-client', () => ({
  repositoryApi: {
    list: vi.fn(),
    updateDisplayName: vi.fn(),
  },
  handleApiError: vi.fn((err: unknown) => {
    if (err instanceof Error) return err.message;
    if (err && typeof err === 'object' && 'message' in err) {
      return String((err as { message: unknown }).message);
    }
    return 'An error occurred';
  }),
}));

import { repositoryApi } from '@/lib/api-client';

function buildRepo(overrides: Partial<RepositoryListItem> = {}): RepositoryListItem {
  return {
    id: overrides.id ?? 'repo-1',
    name: overrides.name ?? 'repo-one',
    displayName: overrides.displayName ?? null,
    path: overrides.path ?? '/path/to/repo-one',
    enabled: overrides.enabled ?? true,
    worktreeCount: overrides.worktreeCount ?? 0,
  };
}

describe('RepositoryList (Issue #644)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('loads repositories on mount via repositoryApi.list()', async () => {
      vi.mocked(repositoryApi.list).mockResolvedValue({
        success: true,
        repositories: [buildRepo()],
      });

      render(<RepositoryList refreshKey={0} />);

      await waitFor(() => {
        expect(repositoryApi.list).toHaveBeenCalledTimes(1);
      });
    });

    it('renders name, path, worktreeCount for each repository', async () => {
      vi.mocked(repositoryApi.list).mockResolvedValue({
        success: true,
        repositories: [
          buildRepo({
            id: 'r1',
            name: 'repo-a',
            path: '/path/to/repo-a',
            worktreeCount: 3,
          }),
        ],
      });

      render(<RepositoryList refreshKey={0} />);

      await waitFor(() => {
        expect(screen.getByText('repo-a')).toBeInTheDocument();
      });
      expect(screen.getByText('/path/to/repo-a')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('renders "Disabled" badge when a repository has enabled=false', async () => {
      vi.mocked(repositoryApi.list).mockResolvedValue({
        success: true,
        repositories: [
          buildRepo({ id: 'r1', name: 'active-repo', enabled: true }),
          buildRepo({
            id: 'r2',
            name: 'disabled-repo',
            path: '/path/to/disabled-repo',
            enabled: false,
          }),
        ],
      });

      render(<RepositoryList refreshKey={0} />);

      await waitFor(() => {
        expect(screen.getByText('disabled-repo')).toBeInTheDocument();
      });

      // Scope the badge lookups inside each row to disambiguate from the
      // header "Status" label. Each row exposes data-testid="repository-row-*".
      const enabledRow = screen.getByTestId('repository-row-r1');
      const disabledRow = screen.getByTestId('repository-row-r2');
      expect(enabledRow.textContent).toMatch(/Enabled/);
      expect(disabledRow.textContent).toMatch(/Disabled/);
    });

    it('shows "(none)" placeholder when displayName is null', async () => {
      vi.mocked(repositoryApi.list).mockResolvedValue({
        success: true,
        repositories: [buildRepo({ displayName: null })],
      });

      render(<RepositoryList refreshKey={0} />);

      await waitFor(() => {
        expect(screen.getByText('(none)')).toBeInTheDocument();
      });
    });

    it('shows the displayName when it is set', async () => {
      vi.mocked(repositoryApi.list).mockResolvedValue({
        success: true,
        repositories: [buildRepo({ displayName: 'My Alias' })],
      });

      render(<RepositoryList refreshKey={0} />);

      await waitFor(() => {
        expect(screen.getByText('My Alias')).toBeInTheDocument();
      });
    });

    it('renders empty state when there are no repositories', async () => {
      vi.mocked(repositoryApi.list).mockResolvedValue({
        success: true,
        repositories: [],
      });

      render(<RepositoryList refreshKey={0} />);

      await waitFor(() => {
        expect(screen.getByText(/no repositories registered/i)).toBeInTheDocument();
      });
    });

    it('refetches when refreshKey changes', async () => {
      vi.mocked(repositoryApi.list).mockResolvedValue({
        success: true,
        repositories: [],
      });

      const { rerender } = render(<RepositoryList refreshKey={0} />);
      await waitFor(() => {
        expect(repositoryApi.list).toHaveBeenCalledTimes(1);
      });

      rerender(<RepositoryList refreshKey={1} />);
      await waitFor(() => {
        expect(repositoryApi.list).toHaveBeenCalledTimes(2);
      });
    });

    it('shows an error message when list() fails', async () => {
      vi.mocked(repositoryApi.list).mockRejectedValue(new Error('Boom'));

      render(<RepositoryList refreshKey={0} />);

      await waitFor(() => {
        expect(screen.getByText(/failed to load repositories/i)).toBeInTheDocument();
      });
      expect(screen.getByText(/boom/i)).toBeInTheDocument();
    });
  });

  describe('Inline editing', () => {
    beforeEach(() => {
      vi.mocked(repositoryApi.list).mockResolvedValue({
        success: true,
        repositories: [
          buildRepo({
            id: 'r1',
            name: 'repo-a',
            displayName: 'Initial Alias',
            path: '/path/to/repo-a',
            worktreeCount: 2,
          }),
        ],
      });
      vi.mocked(repositoryApi.updateDisplayName).mockResolvedValue({
        success: true,
        repository: {
          id: 'r1',
          name: 'repo-a',
          displayName: 'New Alias',
          path: '/path/to/repo-a',
          enabled: true,
        },
      });
    });

    async function openEditor() {
      render(<RepositoryList refreshKey={0} />);
      await waitFor(() => {
        expect(screen.getByText('repo-a')).toBeInTheDocument();
      });
      const editButton = screen.getByRole('button', { name: /edit display name for repo-a/i });
      fireEvent.click(editButton);
      const input = screen.getByRole('textbox', {
        name: /edit display name for repo-a/i,
      }) as HTMLInputElement;
      return input;
    }

    it('enters edit mode with the current displayName in the input', async () => {
      const input = await openEditor();
      expect(input).toBeInTheDocument();
      expect(input.value).toBe('Initial Alias');
    });

    it('calls updateDisplayName on Save click', async () => {
      const input = await openEditor();
      fireEvent.change(input, { target: { value: 'New Alias' } });

      const saveButton = screen.getByRole('button', { name: /save/i });
      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(repositoryApi.updateDisplayName).toHaveBeenCalledWith('r1', 'New Alias');
      });
    });

    it('sends null when the new value is an empty string', async () => {
      const input = await openEditor();
      fireEvent.change(input, { target: { value: '' } });

      const saveButton = screen.getByRole('button', { name: /save/i });
      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(repositoryApi.updateDisplayName).toHaveBeenCalledWith('r1', null);
      });
    });

    it('cancels the edit when Cancel button is clicked', async () => {
      const input = await openEditor();
      fireEvent.change(input, { target: { value: 'Changed' } });

      const cancelButton = screen.getByRole('button', { name: /cancel/i });
      fireEvent.click(cancelButton);

      // Input is gone, original value is visible again
      expect(
        screen.queryByRole('textbox', { name: /edit display name for repo-a/i })
      ).not.toBeInTheDocument();
      expect(screen.getByText('Initial Alias')).toBeInTheDocument();
      expect(repositoryApi.updateDisplayName).not.toHaveBeenCalled();
    });

    it('saves on Enter key', async () => {
      const input = await openEditor();
      fireEvent.change(input, { target: { value: 'Enter Alias' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => {
        expect(repositoryApi.updateDisplayName).toHaveBeenCalledWith('r1', 'Enter Alias');
      });
    });

    it('cancels on Escape key', async () => {
      const input = await openEditor();
      fireEvent.change(input, { target: { value: 'Escape Alias' } });
      fireEvent.keyDown(input, { key: 'Escape' });

      expect(
        screen.queryByRole('textbox', { name: /edit display name for repo-a/i })
      ).not.toBeInTheDocument();
      expect(repositoryApi.updateDisplayName).not.toHaveBeenCalled();
    });

    it('shows client-side validation error when input exceeds 100 chars', async () => {
      const input = await openEditor();
      const tooLong = 'x'.repeat(101);
      fireEvent.change(input, { target: { value: tooLong } });

      expect(screen.getByText(/100 characters or less/i)).toBeInTheDocument();
      const saveButton = screen.getByRole('button', { name: /save/i });
      expect(saveButton).toBeDisabled();
    });

    it('updates the row locally with the API response after save', async () => {
      const input = await openEditor();
      fireEvent.change(input, { target: { value: 'New Alias' } });

      const saveButton = screen.getByRole('button', { name: /save/i });
      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(screen.getByText('New Alias')).toBeInTheDocument();
      });
      // worktreeCount must be preserved (it is not returned by PUT)
      expect(screen.getByText('2')).toBeInTheDocument();
    });

    it('surfaces server error in feedback when save fails', async () => {
      vi.mocked(repositoryApi.updateDisplayName).mockRejectedValueOnce(
        new Error('Server exploded')
      );

      const input = await openEditor();
      fireEvent.change(input, { target: { value: 'New Alias' } });

      const saveButton = screen.getByRole('button', { name: /save/i });
      fireEvent.click(saveButton);

      await waitFor(() => {
        // Feedback region renders the error text (duplicated inline too)
        expect(screen.getAllByText(/server exploded/i).length).toBeGreaterThan(0);
      });
    });

    it('calls onChanged after a successful save', async () => {
      const onChanged = vi.fn();

      render(<RepositoryList refreshKey={0} onChanged={onChanged} />);
      await waitFor(() => {
        expect(screen.getByText('repo-a')).toBeInTheDocument();
      });
      const editButton = screen.getByRole('button', { name: /edit display name for repo-a/i });
      fireEvent.click(editButton);

      const input = screen.getByRole('textbox', {
        name: /edit display name for repo-a/i,
      }) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'Bumped' } });

      vi.mocked(repositoryApi.updateDisplayName).mockResolvedValue({
        success: true,
        repository: {
          id: 'r1',
          name: 'repo-a',
          displayName: 'Bumped',
          path: '/path/to/repo-a',
          enabled: true,
        },
      });

      const saveButton = screen.getByRole('button', { name: /save/i });
      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(onChanged).toHaveBeenCalled();
      });
    });
  });
});
