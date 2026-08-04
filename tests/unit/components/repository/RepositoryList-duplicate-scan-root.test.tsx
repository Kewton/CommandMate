/**
 * RepositoryList — duplicate scan-root warning (Issue #1662).
 *
 * The Repositories screen is where someone finds out that two of their scan
 * roots are the same git repository. These tests pin:
 *
 *   - the warning appears on the rows that are duplicates, and NOWHERE else;
 *   - it names the other root, so the user can tell which pair is involved;
 *   - it leads to the Issue #1658 Scan toggle, which is the documented remedy;
 *   - taking one root out of the scan set retires the warning on its partner.
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
 * every interpolated parameter, so "the warning names the other scan root"
 * would pass there without the path ever being rendered. Re-mocked against the
 * real dictionary for the same reason the Issue #1658 suite does it.
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

const MAIN_PATH = '/repos/CommandAgent';
const DEVELOP_PATH = '/repos/CommandAgent-develop';

function buildRepo(overrides: Partial<RepositoryListItem> = {}): RepositoryListItem {
  return {
    id: overrides.id ?? 'repo-1',
    name: overrides.name ?? 'repo-one',
    displayName: overrides.displayName ?? null,
    path: overrides.path ?? '/path/to/repo-one',
    enabled: overrides.enabled ?? true,
    visible: overrides.visible ?? true,
    worktreeCount: overrides.worktreeCount ?? 0,
    duplicateOf: overrides.duplicateOf,
  };
}

/** The #1659 configuration: two scan roots, one repository. */
function duplicatePair(): RepositoryListItem[] {
  return [
    buildRepo({
      id: 'main',
      name: 'CommandAgent',
      path: MAIN_PATH,
      duplicateOf: [DEVELOP_PATH],
    }),
    buildRepo({
      id: 'develop',
      name: 'CommandAgent-develop',
      path: DEVELOP_PATH,
      duplicateOf: [MAIN_PATH],
    }),
  ];
}

/**
 * The exact sentence the badge should be announcing for a given partner list,
 * built from the real dictionary.
 *
 * Exact-match rather than `toContain`, because the paths in play are prefixes
 * of one another (`…/CommandAgent` is a substring of `…/CommandAgent-feature`),
 * so a substring assertion cannot tell "still listed" from "no longer listed".
 */
function detailFor(paths: string[]): string {
  return enCommon.repositories.duplicateRowDetail.replace('{paths}', paths.join(', '));
}

async function renderList(repositories: RepositoryListItem[]) {
  vi.mocked(repositoryApi.list).mockResolvedValue({ success: true, repositories });
  render(<RepositoryList refreshKey={0} />);
  await waitFor(() => {
    expect(screen.getByTestId(`scan-toggle-${repositories[0].id}`)).toBeInTheDocument();
  });
}

describe('RepositoryList duplicate scan-root warning (Issue #1662)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('marks both rows of a duplicate pair', async () => {
      await renderList(duplicatePair());

      expect(screen.getByTestId('duplicate-scan-root-main')).toBeInTheDocument();
      expect(screen.getByTestId('duplicate-scan-root-develop')).toBeInTheDocument();
    });

    it('names the OTHER scan root, so the pair is identifiable', async () => {
      await renderList(duplicatePair());

      expect(screen.getByTestId('duplicate-scan-root-main')).toHaveAccessibleName(
        detailFor([DEVELOP_PATH])
      );
      expect(screen.getByTestId('duplicate-scan-root-develop')).toHaveAccessibleName(
        detailFor([MAIN_PATH])
      );
    });

    it('points the user at the Scan toggle as the remedy', async () => {
      await renderList(duplicatePair());

      expect(
        screen.getByTestId('duplicate-scan-root-main').getAttribute('aria-label')
      ).toContain('Scan toggle');
    });

    it('renders nothing for rows that are the only root for their repository', async () => {
      // The false-positive guard, at the UI layer: `duplicateOf: []` is what the
      // API sends for every ordinary repository.
      await renderList([
        buildRepo({ id: 'solo', duplicateOf: [] }),
        buildRepo({ id: 'other', name: 'other', path: '/p/other', duplicateOf: [] }),
      ]);

      expect(screen.queryByTestId('duplicate-scan-root-solo')).not.toBeInTheDocument();
      expect(screen.queryByTestId('duplicate-scan-root-other')).not.toBeInTheDocument();
    });

    it('renders nothing when the field is absent (older server, or a cached row)', async () => {
      await renderList([buildRepo({ id: 'legacy', duplicateOf: undefined })]);

      expect(screen.queryByTestId('duplicate-scan-root-legacy')).not.toBeInTheDocument();
    });

    it('lists every partner of a three-way duplicate', async () => {
      await renderList([
        buildRepo({
          id: 'main',
          path: MAIN_PATH,
          duplicateOf: [DEVELOP_PATH, '/repos/CommandAgent-feature'],
        }),
      ]);

      const label = screen.getByTestId('duplicate-scan-root-main').getAttribute('aria-label');
      expect(label).toContain(DEVELOP_PATH);
      expect(label).toContain('/repos/CommandAgent-feature');
    });
  });

  describe('Route to the remedy', () => {
    it('moves focus to that row’s Scan toggle when pressed', async () => {
      await renderList(duplicatePair());

      fireEvent.click(screen.getByTestId('duplicate-scan-root-develop'));

      expect(screen.getByTestId('scan-toggle-develop')).toHaveFocus();
    });

    it('does not mutate anything by itself', async () => {
      await renderList(duplicatePair());

      fireEvent.click(screen.getByTestId('duplicate-scan-root-main'));

      expect(repositoryApi.updateEnabled).not.toHaveBeenCalled();
      expect(repositoryApi.restore).not.toHaveBeenCalled();
      // Focusing the toggle must not be the same thing as pressing it.
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });
  });

  describe('After the remedy is applied', () => {
    it('clears the warning from both rows once one root is excluded', async () => {
      vi.mocked(repositoryApi.updateEnabled).mockResolvedValue({
        success: true,
        repository: {
          id: 'main',
          name: 'CommandAgent',
          displayName: null,
          path: MAIN_PATH,
          enabled: false,
          visible: true,
        },
      });

      await renderList(duplicatePair());

      fireEvent.click(screen.getByTestId('scan-toggle-main'));
      fireEvent.click(await screen.findByRole('button', { name: 'Exclude from scans' }));

      await waitFor(() => {
        expect(repositoryApi.updateEnabled).toHaveBeenCalledWith('main', false);
      });

      await waitFor(() => {
        expect(screen.queryByTestId('duplicate-scan-root-main')).not.toBeInTheDocument();
      });
      // The partner is the row the user is left looking at; it must stop
      // claiming a conflict the click just resolved.
      expect(screen.queryByTestId('duplicate-scan-root-develop')).not.toBeInTheDocument();
    });

    it('keeps the warning on rows whose OTHER partner is still enabled', async () => {
      vi.mocked(repositoryApi.updateEnabled).mockResolvedValue({
        success: true,
        repository: {
          id: 'main',
          name: 'CommandAgent',
          displayName: null,
          path: MAIN_PATH,
          enabled: false,
          visible: true,
        },
      });

      const FEATURE_PATH = '/repos/CommandAgent-feature';
      await renderList([
        buildRepo({
          id: 'main',
          name: 'CommandAgent',
          path: MAIN_PATH,
          duplicateOf: [DEVELOP_PATH, FEATURE_PATH],
        }),
        buildRepo({
          id: 'develop',
          name: 'CommandAgent-develop',
          path: DEVELOP_PATH,
          duplicateOf: [MAIN_PATH, FEATURE_PATH],
        }),
        buildRepo({
          id: 'feature',
          name: 'CommandAgent-feature',
          path: FEATURE_PATH,
          duplicateOf: [MAIN_PATH, DEVELOP_PATH],
        }),
      ]);

      fireEvent.click(screen.getByTestId('scan-toggle-main'));
      fireEvent.click(await screen.findByRole('button', { name: 'Exclude from scans' }));

      await waitFor(() => {
        expect(screen.queryByTestId('duplicate-scan-root-main')).not.toBeInTheDocument();
      });

      // develop and feature are still the same repository as each other, and
      // ONLY each other — the excluded root has dropped out of both lists.
      expect(screen.getByTestId('duplicate-scan-root-develop')).toHaveAccessibleName(
        detailFor([FEATURE_PATH])
      );
      expect(screen.getByTestId('duplicate-scan-root-feature')).toHaveAccessibleName(
        detailFor([DEVELOP_PATH])
      );
    });
  });
});
