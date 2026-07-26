/**
 * Unit tests for the Local Path form's folder picker wiring (Issue #1517)
 *
 * The real DirectoryPickerModal is rendered (only the API client is stubbed) so
 * these cover the seam between the form and the picker, not just the form.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('@/lib/api-client', () => ({
  repositoryApi: { scan: vi.fn(), validatePath: vi.fn() },
  fsApi: { browse: vi.fn(), addRecentPath: vi.fn() },
  handleApiError: (err: unknown) => (err instanceof Error ? err.message : 'error'),
}));

import { RepositoryManager } from '@/components/repository/RepositoryManager';
import { repositoryApi, fsApi } from '@/lib/api-client';
import type { BrowseResponse, ValidatePathResponse } from '@/lib/api-client';

const ROOT = '/srv/repos';
const EXTRA_ROOT = '/mnt/work';

function browseResponse(overrides: Partial<BrowseResponse> = {}): BrowseResponse {
  return {
    path: null,
    parent: null,
    roots: [ROOT, EXTRA_ROOT],
    recentPaths: [],
    entries: [{ name: ROOT, path: ROOT, isGitRepo: false, worktreeCount: null }],
    truncated: false,
    entryLimit: 500,
    ...overrides,
  };
}

function validation(overrides: Partial<ValidatePathResponse> = {}): ValidatePathResponse {
  return {
    valid: true,
    roots: [ROOT, EXTRA_ROOT],
    allowedRootsLabel: `${ROOT}, ${EXTRA_ROOT}`,
    isGitRepo: true,
    worktreeCount: 2,
    ...overrides,
  };
}

/** Open the "Add New Repository" card, which defaults to the Local Path tab. */
async function openAddForm(): Promise<void> {
  render(<RepositoryManager />);
  fireEvent.click(screen.getByText(/common.repositories.add/));
  await waitFor(() => expect(fsApi.browse).toHaveBeenCalled());
}

beforeEach(() => {
  vi.mocked(fsApi.browse).mockReset().mockResolvedValue(browseResponse());
  vi.mocked(fsApi.addRecentPath).mockReset().mockResolvedValue({ success: true });
  vi.mocked(repositoryApi.validatePath).mockReset().mockResolvedValue(validation());
  vi.mocked(repositoryApi.scan).mockReset().mockResolvedValue({
    success: true,
    message: 'added',
    worktreeCount: 1,
    repositoryPath: `${ROOT}/my-repo`,
    repositoryName: 'my-repo',
  });
});

afterEach(() => {
  cleanup();
});

describe('RepositoryManager — allowed roots surfacing', () => {
  it('builds the example path from the first allowed root', async () => {
    await openAddForm();

    // The next-intl test mock substitutes params it recognises into the key.
    expect(
      await screen.findByText('common.repositories.localPathAllowedRoots')
    ).toBeDefined();
    expect(screen.getByText('common.repositories.localPathExample')).toBeDefined();
  });
});

describe('RepositoryManager — folder picker', () => {
  it('keeps the free-text path field, for hosts the server cannot browse', async () => {
    await openAddForm();

    expect(screen.getByPlaceholderText('/absolute/path/to/repository')).toBeDefined();
  });

  it('opens the picker from the Browse button', async () => {
    await openAddForm();

    expect(screen.queryByTestId('modal-panel')).toBeNull();

    fireEvent.click(screen.getByText('common.repositories.browse'));

    expect(await screen.findByTestId('modal-panel')).toBeDefined();
  });

  it('fills the path field with the folder chosen in the picker', async () => {
    const chosen = `${ROOT}/my-repo`;
    await openAddForm();

    fireEvent.click(screen.getByText('common.repositories.browse'));
    await screen.findByTestId('modal-panel');

    // Picker now shows `chosen` as the current directory.
    vi.mocked(fsApi.browse).mockResolvedValue(
      browseResponse({ path: chosen, parent: ROOT, entries: [] })
    );
    fireEvent.click(screen.getByText(ROOT));

    await waitFor(() =>
      expect(screen.getByText('common.repositories.pickerSelectHere').closest('button'))
        .not.toBeDisabled()
    );
    fireEvent.click(screen.getByText('common.repositories.pickerSelectHere'));

    const input = await screen.findByPlaceholderText('/absolute/path/to/repository');
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(chosen));
  });

  it('submits the chosen path to scan, so the picker cannot offer an unregistrable folder', async () => {
    const chosen = `${ROOT}/my-repo`;
    await openAddForm();

    const input = screen.getByPlaceholderText('/absolute/path/to/repository');
    fireEvent.change(input, { target: { value: chosen } });
    fireEvent.click(screen.getByText('common.repositories.scan'));

    await waitFor(() => expect(repositoryApi.scan).toHaveBeenCalledWith(chosen));
  });
});

describe('RepositoryManager — while-typing path check', () => {
  it('reports a detected git repository', async () => {
    await openAddForm();

    fireEvent.change(screen.getByPlaceholderText('/absolute/path/to/repository'), {
      target: { value: `${ROOT}/my-repo` },
    });

    expect(
      await screen.findByText('common.repositories.validationGitRepo')
    ).toBeDefined();
    expect(repositoryApi.validatePath).toHaveBeenCalledWith(`${ROOT}/my-repo`);
  });

  it('explains an out-of-scope path instead of leaving it looking like a typo', async () => {
    vi.mocked(repositoryApi.validatePath).mockResolvedValue(
      validation({ valid: false, reason: 'outside-roots', isGitRepo: false, worktreeCount: null })
    );
    await openAddForm();

    fireEvent.change(screen.getByPlaceholderText('/absolute/path/to/repository'), {
      target: { value: '/etc' },
    });

    expect(
      await screen.findByText('common.repositories.validationOutsideRoots')
    ).toBeDefined();
  });

  it('flags a directory that is not a git repository', async () => {
    vi.mocked(repositoryApi.validatePath).mockResolvedValue(
      validation({ isGitRepo: false, worktreeCount: null })
    );
    await openAddForm();

    fireEvent.change(screen.getByPlaceholderText('/absolute/path/to/repository'), {
      target: { value: `${ROOT}/notes` },
    });

    expect(
      await screen.findByText('common.repositories.validationNotGitRepo')
    ).toBeDefined();
  });

  it('does not call validate-path for an empty field', async () => {
    await openAddForm();

    const input = screen.getByPlaceholderText('/absolute/path/to/repository');
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.change(input, { target: { value: '' } });

    await waitFor(() => expect(screen.queryByText(/validation/)).toBeNull());
    expect(repositoryApi.validatePath).not.toHaveBeenCalledWith('');
  });
});
