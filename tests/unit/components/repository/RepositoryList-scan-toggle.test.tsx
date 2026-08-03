/**
 * RepositoryList — Scan toggle (Issue #1658)
 *
 * The Repositories screen used to render `enabled` as a read-only "Status"
 * badge; the only way to change it was `DELETE /api/repositories`, which purges
 * worktrees and kills sessions. These tests pin the new control:
 *
 *   - it is a separate control from the Issue #690 visibility toggle, and the
 *     two never trigger each other's request;
 *   - turning scanning OFF asks first, and only the confirmation issues the PUT;
 *   - turning it back ON goes through `restore`, which also re-scans.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { RepositoryList } from '@/components/repository/RepositoryList';
import type { RepositoryListItem } from '@/lib/api-client';
import enCommon from '../../../../locales/en/common.json';

/**
 * The suite-wide `next-intl` mock in tests/setup.ts returns the key and drops
 * every interpolated parameter, so an assertion about the rendered copy passes
 * there whether or not the message actually says anything. This file re-mocks it
 * against the real English dictionary: the confirmation body is the thing that
 * promises the user nothing gets deleted, and that promise has to be tested as
 * text, not as a key.
 */
vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => (key: string, params?: Record<string, unknown>) => {
    const dictionary: Record<string, unknown> = namespace === 'common' ? enCommon : {};
    const message = key
      .split('.')
      .reduce<unknown>(
        (node, segment) =>
          node && typeof node === 'object'
            ? (node as Record<string, unknown>)[segment]
            : undefined,
        dictionary
      );
    if (typeof message !== 'string') {
      // Missing key: surface it rather than silently rendering nothing.
      return namespace ? `${namespace}.${key}` : key;
    }
    if (!params) return message;
    return Object.entries(params).reduce(
      (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
      message
    );
  },
  useLocale: () => 'en',
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/lib/api-client', () => ({
  repositoryApi: {
    list: vi.fn(),
    updateDisplayName: vi.fn(),
    updateVisibility: vi.fn(),
    updateEnabled: vi.fn(),
    restore: vi.fn(),
  },
  handleApiError: vi.fn((err: unknown) =>
    err instanceof Error ? err.message : 'An error occurred'
  ),
}));

import { repositoryApi } from '@/lib/api-client';

function buildRepo(overrides: Partial<RepositoryListItem> = {}): RepositoryListItem {
  return {
    id: overrides.id ?? 'repo-1',
    name: overrides.name ?? 'repo-one',
    displayName: overrides.displayName ?? null,
    path: overrides.path ?? '/path/to/repo-one',
    enabled: overrides.enabled ?? true,
    visible: overrides.visible ?? true,
    worktreeCount: overrides.worktreeCount ?? 0,
  };
}

/** Render and wait for the first load to settle. */
async function renderList(repositories: RepositoryListItem[], onChanged?: () => void) {
  vi.mocked(repositoryApi.list).mockResolvedValue({ success: true, repositories });
  render(<RepositoryList refreshKey={0} onChanged={onChanged} />);
  await waitFor(() => {
    expect(screen.getByTestId(`scan-toggle-${repositories[0].id}`)).toBeInTheDocument();
  });
}

describe('RepositoryList scan toggle (Issue #1658)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('renders a scan switch per row reflecting `enabled`', async () => {
      await renderList([
        buildRepo({ id: 'r1', enabled: true }),
        buildRepo({ id: 'r2', name: 'repo-two', path: '/p/two', enabled: false }),
      ]);

      expect(screen.getByTestId('scan-toggle-r1')).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByTestId('scan-toggle-r2')).toHaveAttribute('aria-checked', 'false');
      expect(screen.getByTestId('scan-toggle-r1')).toHaveAttribute('role', 'switch');
    });

    it('is a different control from the visibility toggle', async () => {
      await renderList([buildRepo({ id: 'r1', enabled: true, visible: true })]);

      const scan = screen.getByTestId('scan-toggle-r1');
      const visibility = screen.getByTestId('visibility-toggle-r1');

      expect(scan).not.toBe(visibility);
      // Distinct wording so the two switches are not confusable.
      expect(scan.getAttribute('aria-label')).toMatch(/repository scans/i);
      expect(visibility.getAttribute('aria-label')).toMatch(/sidebar/i);
    });

    it('does not fire a scan request when the visibility toggle is used', async () => {
      vi.mocked(repositoryApi.updateVisibility).mockResolvedValue({
        success: true,
        repository: {
          id: 'r1',
          name: 'repo-one',
          displayName: null,
          path: '/path/to/repo-one',
          enabled: true,
          visible: false,
        },
      });
      await renderList([buildRepo({ id: 'r1' })]);

      fireEvent.click(screen.getByTestId('visibility-toggle-r1'));

      await waitFor(() => {
        expect(repositoryApi.updateVisibility).toHaveBeenCalledWith('r1', false);
      });
      expect(repositoryApi.updateEnabled).not.toHaveBeenCalled();
      expect(screen.getByTestId('scan-toggle-r1')).toHaveAttribute('aria-checked', 'true');
    });
  });

  describe('Disabling asks first', () => {
    it('opens a confirmation instead of issuing the request', async () => {
      await renderList([buildRepo({ id: 'r1', enabled: true })]);

      fireEvent.click(screen.getByTestId('scan-toggle-r1'));

      await waitFor(() => {
        expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
      });
      expect(repositoryApi.updateEnabled).not.toHaveBeenCalled();
      expect(screen.getByTestId('scan-toggle-r1')).toHaveAttribute('aria-checked', 'true');
    });

    it('promises that nothing is deleted, naming the worktree count at risk', async () => {
      await renderList([buildRepo({ id: 'r1', name: 'repo-one', worktreeCount: 4 })]);

      fireEvent.click(screen.getByTestId('scan-toggle-r1'));

      const dialog = await screen.findByTestId('confirm-dialog');
      const body = dialog.textContent ?? '';
      // Rendered against the real dictionary: the row's own name and worktree
      // count reach the message, and the message makes the three promises that
      // distinguish this operation from the purging DELETE.
      expect(body).toContain('repo-one');
      expect(body).toContain('4 worktree(s)');
      expect(body).toMatch(/Nothing is deleted/i);
      expect(body).toMatch(/keeps running/i);
      expect(body).toMatch(/Visibility toggle/i);
      // No leftover placeholders.
      expect(body).not.toMatch(/\{(name|count)\}/);
    });

    it('cancelling changes nothing', async () => {
      await renderList([buildRepo({ id: 'r1', enabled: true })]);

      fireEvent.click(screen.getByTestId('scan-toggle-r1'));
      fireEvent.click(await screen.findByTestId('confirm-dialog-cancel'));

      expect(repositoryApi.updateEnabled).not.toHaveBeenCalled();
      expect(screen.getByTestId('scan-toggle-r1')).toHaveAttribute('aria-checked', 'true');
    });

    it('confirming PUTs enabled=false and flips the row', async () => {
      const onChanged = vi.fn();
      vi.mocked(repositoryApi.updateEnabled).mockResolvedValue({
        success: true,
        repository: {
          id: 'r1',
          name: 'repo-one',
          displayName: null,
          path: '/path/to/repo-one',
          enabled: false,
          visible: true,
        },
      });
      await renderList([buildRepo({ id: 'r1', enabled: true, worktreeCount: 2 })], onChanged);

      fireEvent.click(screen.getByTestId('scan-toggle-r1'));
      fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));

      await waitFor(() => {
        expect(repositoryApi.updateEnabled).toHaveBeenCalledWith('r1', false);
      });
      await waitFor(() => {
        expect(screen.getByTestId('scan-toggle-r1')).toHaveAttribute('aria-checked', 'false');
      });
      // The worktree count is untouched by a disable — nothing was deleted.
      expect(screen.getByTestId('repository-row-r1').textContent).toContain('2');
      expect(onChanged).toHaveBeenCalled();
      // Restore is the other direction; disabling must not re-scan.
      expect(repositoryApi.restore).not.toHaveBeenCalled();
    });

    it('surfaces the error and leaves the row enabled when the PUT fails', async () => {
      vi.mocked(repositoryApi.updateEnabled).mockRejectedValue(new Error('nope'));
      await renderList([buildRepo({ id: 'r1', enabled: true })]);

      fireEvent.click(screen.getByTestId('scan-toggle-r1'));
      fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));

      await waitFor(() => {
        expect(screen.getByText('nope')).toBeInTheDocument();
      });
      expect(screen.getByTestId('scan-toggle-r1')).toHaveAttribute('aria-checked', 'true');
    });
  });

  describe('Re-enabling restores', () => {
    it('calls restore(path) without a confirmation and refetches', async () => {
      const onChanged = vi.fn();
      vi.mocked(repositoryApi.restore).mockResolvedValue({
        success: true,
        worktreeCount: 3,
        message: 'restored',
      });
      await renderList([buildRepo({ id: 'r1', path: '/p/one', enabled: false })], onChanged);

      vi.mocked(repositoryApi.list).mockResolvedValue({
        success: true,
        repositories: [buildRepo({ id: 'r1', path: '/p/one', enabled: true, worktreeCount: 3 })],
      });

      fireEvent.click(screen.getByTestId('scan-toggle-r1'));

      await waitFor(() => {
        expect(repositoryApi.restore).toHaveBeenCalledWith('/p/one');
      });
      expect(screen.queryByTestId('confirm-dialog')).toBeNull();
      await waitFor(() => {
        expect(screen.getByTestId('scan-toggle-r1')).toHaveAttribute('aria-checked', 'true');
      });
      expect(onChanged).toHaveBeenCalled();
    });

    it('shows the server warning when the directory is gone', async () => {
      vi.mocked(repositoryApi.restore).mockResolvedValue({
        success: true,
        worktreeCount: 0,
        warning: 'Repository path not found on disk. No worktrees were restored.',
      });
      await renderList([buildRepo({ id: 'r1', path: '/p/one', enabled: false })]);

      fireEvent.click(screen.getByTestId('scan-toggle-r1'));

      await waitFor(() => {
        expect(
          screen.getByText('Repository path not found on disk. No worktrees were restored.')
        ).toBeInTheDocument();
      });
    });
  });

  describe('Disabled-only list', () => {
    it('filters the table down to the excluded repositories', async () => {
      await renderList([
        buildRepo({ id: 'r1', name: 'kept', enabled: true }),
        buildRepo({ id: 'r2', name: 'dropped', path: '/p/two', enabled: false }),
      ]);

      expect(screen.getByTestId('repository-row-r1')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('repository-filter-disabled'));

      expect(screen.queryByTestId('repository-row-r1')).toBeNull();
      expect(screen.getByTestId('repository-row-r2')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('repository-filter-all'));
      expect(screen.getByTestId('repository-row-r1')).toBeInTheDocument();
    });

    it('counts the disabled repositories in the filter label', async () => {
      await renderList([
        buildRepo({ id: 'r1', enabled: true }),
        buildRepo({ id: 'r2', path: '/p/two', enabled: false }),
        buildRepo({ id: 'r3', path: '/p/three', enabled: false }),
      ]);

      expect(screen.getByTestId('repository-filter-disabled').textContent).toBe('Disabled (2)');
      expect(screen.getByTestId('repository-filter-all').textContent).toBe('All (3)');
    });

    it('explains the empty state when nothing is excluded', async () => {
      await renderList([buildRepo({ id: 'r1', enabled: true })]);

      fireEvent.click(screen.getByTestId('repository-filter-disabled'));

      expect(
        screen.getByText('No repositories are excluded from scans.')
      ).toBeInTheDocument();
    });
  });
});
