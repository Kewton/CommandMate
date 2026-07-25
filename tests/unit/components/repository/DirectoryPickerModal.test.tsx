/**
 * Unit tests for DirectoryPickerModal (Issue #1517)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('@/lib/api-client', () => ({
  fsApi: { browse: vi.fn(), addRecentPath: vi.fn() },
  handleApiError: (err: unknown) => (err instanceof Error ? err.message : 'error'),
}));

import { DirectoryPickerModal } from '@/components/repository/DirectoryPickerModal';
import { fsApi } from '@/lib/api-client';
import type { BrowseResponse } from '@/lib/api-client';

const ROOT = '/srv/repos';

function response(overrides: Partial<BrowseResponse> = {}): BrowseResponse {
  return {
    path: null,
    parent: null,
    roots: [ROOT],
    recentPaths: [],
    entries: [],
    truncated: false,
    entryLimit: 500,
    ...overrides,
  };
}

const rootListing = response({
  entries: [{ name: ROOT, path: ROOT, isGitRepo: false, worktreeCount: null }],
});

const insideRoot = response({
  path: ROOT,
  parent: null,
  entries: [
    { name: 'my-repo', path: `${ROOT}/my-repo`, isGitRepo: true, worktreeCount: 3 },
    { name: 'notes', path: `${ROOT}/notes`, isGitRepo: false, worktreeCount: null },
  ],
});

beforeEach(() => {
  vi.mocked(fsApi.browse).mockReset();
  vi.mocked(fsApi.addRecentPath).mockReset().mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
});

describe('DirectoryPickerModal', () => {
  it('renders nothing while closed and does not touch the API', () => {
    render(
      <DirectoryPickerModal isOpen={false} onClose={vi.fn()} onSelect={vi.fn()} />
    );

    expect(screen.queryByTestId('modal-panel')).toBeNull();
    expect(fsApi.browse).not.toHaveBeenCalled();
  });

  it('lists the allowed roots when opened with no recent path', async () => {
    vi.mocked(fsApi.browse).mockResolvedValue(rootListing);

    render(<DirectoryPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} />);

    expect(await screen.findByText(ROOT)).toBeDefined();
    expect(fsApi.browse).toHaveBeenCalledWith(undefined);
  });

  it('reopens at the most recently used directory', async () => {
    const recent = `${ROOT}/my-repo`;
    vi.mocked(fsApi.browse)
      .mockResolvedValueOnce(response({ recentPaths: [recent] }))
      .mockResolvedValueOnce(response({ path: recent, parent: ROOT }));

    render(<DirectoryPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} />);

    await waitFor(() => expect(fsApi.browse).toHaveBeenCalledWith(recent));
  });

  it('navigates into a directory when its row is clicked', async () => {
    vi.mocked(fsApi.browse).mockResolvedValue(insideRoot);

    render(
      <DirectoryPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} initialPath={ROOT} />
    );

    fireEvent.click(await screen.findByText('my-repo'));

    await waitFor(() => expect(fsApi.browse).toHaveBeenCalledWith(`${ROOT}/my-repo`));
  });

  it('badges git repositories with their worktree count', async () => {
    vi.mocked(fsApi.browse).mockResolvedValue(insideRoot);

    render(
      <DirectoryPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} initialPath={ROOT} />
    );

    // The next-intl test mock interpolates params into the key name.
    expect(
      await screen.findByText('common.repositories.pickerWorktreeCount')
    ).toBeDefined();
  });

  it('returns the current directory, records it, and closes on confirm', async () => {
    vi.mocked(fsApi.browse).mockResolvedValue(insideRoot);
    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(
      <DirectoryPickerModal
        isOpen
        onClose={onClose}
        onSelect={onSelect}
        initialPath={ROOT}
      />
    );

    fireEvent.click(await screen.findByText('common.repositories.pickerSelectHere'));

    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(ROOT));
    expect(fsApi.addRecentPath).toHaveBeenCalledWith(ROOT);
    expect(onClose).toHaveBeenCalled();
  });

  it('still selects when recording the recent path fails', async () => {
    vi.mocked(fsApi.browse).mockResolvedValue(insideRoot);
    vi.mocked(fsApi.addRecentPath).mockRejectedValue(new Error('db down'));
    const onSelect = vi.fn();

    render(
      <DirectoryPickerModal isOpen onClose={vi.fn()} onSelect={onSelect} initialPath={ROOT} />
    );

    fireEvent.click(await screen.findByText('common.repositories.pickerSelectHere'));

    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(ROOT));
  });

  it('cannot confirm the roots listing, which is not a real directory', async () => {
    vi.mocked(fsApi.browse).mockResolvedValue(rootListing);

    render(<DirectoryPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} />);

    const confirm = await screen.findByText('common.repositories.pickerSelectHere');
    expect(confirm.closest('button')).toBeDisabled();
  });

  it('warns when the listing was truncated', async () => {
    vi.mocked(fsApi.browse).mockResolvedValue(
      response({ path: ROOT, truncated: true, entries: [] })
    );

    render(
      <DirectoryPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} initialPath={ROOT} />
    );

    expect(await screen.findByText('common.repositories.pickerTruncated')).toBeDefined();
  });

  it('shows the API error instead of an empty list', async () => {
    vi.mocked(fsApi.browse).mockRejectedValue(new Error('Path is outside the allowed roots'));

    render(
      <DirectoryPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} initialPath={ROOT} />
    );

    expect(await screen.findByText('Path is outside the allowed roots')).toBeDefined();
  });

  it('offers an up-one-level row only when the API reports a parent', async () => {
    vi.mocked(fsApi.browse).mockResolvedValue(
      response({ path: `${ROOT}/my-repo`, parent: ROOT })
    );

    render(
      <DirectoryPickerModal
        isOpen
        onClose={vi.fn()}
        onSelect={vi.fn()}
        initialPath={`${ROOT}/my-repo`}
      />
    );

    fireEvent.click(await screen.findByText('common.repositories.pickerUp'));

    await waitFor(() => expect(fsApi.browse).toHaveBeenCalledWith(ROOT));
  });
});
