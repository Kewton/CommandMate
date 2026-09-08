/**
 * IME composition guard on the repository display-name editor (Issue #2428)
 *
 * The inline rename input saves on Enter. Enter is also how an IME confirms its
 * conversion candidate, so without a guard the first Enter of a Japanese rename
 * persisted the still-unconverted reading.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { RepositoryList } from '@/components/repository/RepositoryList';
import type { RepositoryListItem } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
  repositoryApi: {
    list: vi.fn(),
    updateDisplayName: vi.fn(),
    updateVisibility: vi.fn(),
  },
  handleApiError: vi.fn((err: unknown) =>
    err instanceof Error ? err.message : 'An error occurred',
  ),
}));

import { repositoryApi } from '@/lib/api-client';

const repo: RepositoryListItem = {
  id: 'r1',
  name: 'repo-a',
  displayName: 'Initial Alias',
  path: '/path/to/repo-a',
  enabled: true,
  visible: true,
  worktreeCount: 0,
};

async function openEditor(): Promise<HTMLInputElement> {
  render(<RepositoryList refreshKey={0} />);
  await waitFor(() => expect(screen.getByText('repo-a')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /edit display name for repo-a/i }));
  return screen.getByRole('textbox', {
    name: /edit display name for repo-a/i,
  }) as HTMLInputElement;
}

describe('RepositoryList inline rename (Issue #2428)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(repositoryApi.list).mockResolvedValue({ success: true, repositories: [repo] });
    vi.mocked(repositoryApi.updateDisplayName).mockResolvedValue({
      success: true,
      repository: { ...repo, displayName: '検証用' },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('saves the converted name, not the reading, when Enter confirms the conversion first', async () => {
    const input = await openEditor();

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'けんしょうよう' } });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true });
    expect(repositoryApi.updateDisplayName).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input, { data: '検証用' });
    fireEvent.change(input, { target: { value: '検証用' } });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, isComposing: false });

    await waitFor(() =>
      expect(repositoryApi.updateDisplayName).toHaveBeenCalledWith('r1', '検証用'),
    );
    expect(repositoryApi.updateDisplayName).toHaveBeenCalledTimes(1);
  });

  it('still saves ASCII input on the first Enter (no regression)', async () => {
    const input = await openEditor();

    fireEvent.change(input, { target: { value: 'New Alias' } });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, isComposing: false });

    await waitFor(() =>
      expect(repositoryApi.updateDisplayName).toHaveBeenCalledWith('r1', 'New Alias'),
    );
  });
});
