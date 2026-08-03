/**
 * RepositoryManager — duplicate scan-root warning at registration (Issue #1662).
 *
 * The rule under test is "warn, do not block". Every assertion here is about
 * one of the two ways that can go wrong:
 *
 *   - warning too little — the duplicate is registered with no warning at all,
 *     including when the user submits faster than the debounced check answers;
 *   - warning too much — an ordinary new repository is made to look suspect, or
 *     an unreachable check stops the registration from happening.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { RepositoryManager } from '@/components/repository/RepositoryManager';
import type { ValidatePathResponse } from '@/lib/api-client';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('@/lib/api-client', () => ({
  repositoryApi: {
    scan: vi.fn(),
    sync: vi.fn(),
    clone: vi.fn(),
    getCloneStatus: vi.fn(),
    validatePath: vi.fn(),
  },
  fsApi: {
    browse: vi.fn(() => new Promise(() => {})),
    addRecentPath: vi.fn(),
  },
  handleApiError: vi.fn((err: unknown) =>
    err instanceof Error ? err.message : 'An error occurred'
  ),
}));

vi.mock('@/lib/url-normalizer', () => ({
  UrlNormalizer: {
    getInstance: () => ({ validate: vi.fn(() => ({ valid: true })) }),
  },
}));

import { repositoryApi } from '@/lib/api-client';

const EXISTING_ROOT = '/repos/CommandAgent';
const CANDIDATE = '/repos/CommandAgent-develop';

function validation(overrides: Partial<ValidatePathResponse> = {}): ValidatePathResponse {
  return {
    valid: true,
    resolvedPath: CANDIDATE,
    roots: ['/repos'],
    allowedRootsLabel: '/repos',
    isGitRepo: true,
    worktreeCount: 5,
    ...overrides,
  };
}

/** Open the Add form and type `value` into the Local Path box. */
async function typePath(value: string) {
  render(<RepositoryManager />);
  fireEvent.click(screen.getByTestId('add-repository-button'));
  fireEvent.change(screen.getByTestId('repository-path-input'), { target: { value } });
}

function submit() {
  fireEvent.click(screen.getByTestId('repository-scan-submit'));
}

describe('RepositoryManager duplicate scan root (Issue #1662)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(repositoryApi.scan).mockResolvedValue({
      success: true,
      message: 'Successfully scanned and added 5 worktree(s)',
      worktreeCount: 5,
      repositoryPath: CANDIDATE,
      repositoryName: 'CommandAgent-develop',
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe('While typing', () => {
    it('warns that the path is the same repository as an existing scan root', async () => {
      vi.mocked(repositoryApi.validatePath).mockResolvedValue(
        validation({ duplicateScanRoots: [EXISTING_ROOT] })
      );

      await typePath(CANDIDATE);

      const warning = await screen.findByTestId('duplicate-scan-root-warning', undefined, {
        timeout: 2000,
      });
      expect(warning.textContent).toContain(EXISTING_ROOT);
    });

    it('does not warn for a path that is its own repository', async () => {
      vi.mocked(repositoryApi.validatePath).mockResolvedValue(
        validation({ duplicateScanRoots: [] })
      );

      await typePath('/repos/brand-new');

      await waitFor(() => expect(repositoryApi.validatePath).toHaveBeenCalled());
      expect(screen.queryByTestId('duplicate-scan-root-warning')).not.toBeInTheDocument();
    });

    it('leaves the path valid — the warning sits alongside the git-repo line', async () => {
      vi.mocked(repositoryApi.validatePath).mockResolvedValue(
        validation({ duplicateScanRoots: [EXISTING_ROOT] })
      );

      await typePath(CANDIDATE);

      await screen.findByTestId('duplicate-scan-root-warning', undefined, { timeout: 2000 });
      expect(screen.getByText(/Git repository detected/)).toBeInTheDocument();
      expect(screen.getByTestId('repository-scan-submit')).not.toBeDisabled();
    });
  });

  describe('On submit', () => {
    it('asks before registering a duplicate, and registers nothing until answered', async () => {
      vi.mocked(repositoryApi.validatePath).mockResolvedValue(
        validation({ duplicateScanRoots: [EXISTING_ROOT] })
      );

      await typePath(CANDIDATE);
      await screen.findByTestId('duplicate-scan-root-warning', undefined, { timeout: 2000 });

      submit();

      const dialog = await screen.findByTestId('confirm-dialog');
      expect(dialog.textContent).toContain(EXISTING_ROOT);
      expect(repositoryApi.scan).not.toHaveBeenCalled();
    });

    it('registers anyway when the user confirms — it warns, it does not block', async () => {
      vi.mocked(repositoryApi.validatePath).mockResolvedValue(
        validation({ duplicateScanRoots: [EXISTING_ROOT] })
      );

      await typePath(CANDIDATE);
      await screen.findByTestId('duplicate-scan-root-warning', undefined, { timeout: 2000 });
      submit();

      fireEvent.click(await screen.findByRole('button', { name: 'Add anyway' }));

      await waitFor(() => expect(repositoryApi.scan).toHaveBeenCalledWith(CANDIDATE));
    });

    it('registers nothing when the user backs out', async () => {
      vi.mocked(repositoryApi.validatePath).mockResolvedValue(
        validation({ duplicateScanRoots: [EXISTING_ROOT] })
      );

      await typePath(CANDIDATE);
      await screen.findByTestId('duplicate-scan-root-warning', undefined, { timeout: 2000 });
      submit();

      // Scoped to the dialog: the Add form has its own Cancel button, and
      // hitting that one would close the form rather than decline the dialog.
      const dialog = await screen.findByTestId('confirm-dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      await waitFor(() =>
        expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument()
      );
      expect(repositoryApi.scan).not.toHaveBeenCalled();
      // The form is still there with the path intact, so retrying is one click.
      expect(screen.getByTestId('repository-path-input')).toHaveValue(CANDIDATE);
    });

    it('registers a non-duplicate immediately, with no dialog', async () => {
      vi.mocked(repositoryApi.validatePath).mockResolvedValue(
        validation({ duplicateScanRoots: [] })
      );

      await typePath('/repos/brand-new');
      await waitFor(() => expect(repositoryApi.validatePath).toHaveBeenCalled());

      submit();

      await waitFor(() => expect(repositoryApi.scan).toHaveBeenCalledWith('/repos/brand-new'));
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });

    it('still asks when submitted before the debounced check has answered', async () => {
      // The warning must not be skippable by pasting a path and clicking
      // straight away — that is precisely how someone in a hurry registers the
      // duplicate they were meant to be warned about.
      vi.mocked(repositoryApi.validatePath).mockResolvedValue(
        validation({ duplicateScanRoots: [EXISTING_ROOT] })
      );

      await typePath(CANDIDATE);
      expect(repositoryApi.validatePath).not.toHaveBeenCalled();

      submit();

      expect(await screen.findByTestId('confirm-dialog')).toBeInTheDocument();
      expect(repositoryApi.scan).not.toHaveBeenCalled();
    });
  });

  describe('When the check cannot answer', () => {
    it('registers without a dialog when validate-path fails', async () => {
      vi.mocked(repositoryApi.validatePath).mockRejectedValue(new Error('offline'));

      await typePath(CANDIDATE);
      submit();

      await waitFor(() => expect(repositoryApi.scan).toHaveBeenCalledWith(CANDIDATE));
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });

    it('does not wedge the submit button when validate-path never answers', async () => {
      // Advisory checks get a deadline. Without one, an unreachable endpoint
      // would make "Scan & Add" permanently dead.
      vi.mocked(repositoryApi.validatePath).mockImplementation(
        () => new Promise<ValidatePathResponse>(() => {})
      );

      await typePath(CANDIDATE);
      submit();

      await waitFor(() => expect(repositoryApi.scan).toHaveBeenCalledWith(CANDIDATE), {
        timeout: 3000,
      });
    });
  });
});
