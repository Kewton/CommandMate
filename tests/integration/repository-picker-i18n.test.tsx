/**
 * Integration test: the picker's new messages interpolate their parameters
 * against the real dictionaries (Issue #1517).
 *
 * The global next-intl mock in tests/setup.ts returns the key name and drops
 * params, so an assertion on rendered text passes even when the code and the
 * dictionary disagree on a placeholder name. This file re-mocks next-intl with a
 * real interpolating implementation backed by locales/*.json so a mismatch
 * actually fails.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import fs from 'fs';
import path from 'path';

const LOCALES = ['en', 'ja'] as const;
type Locale = (typeof LOCALES)[number];

const dictionaries: Record<Locale, Record<string, unknown>> = {
  en: JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../locales/en/common.json'), 'utf-8')
  ),
  ja: JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../locales/ja/common.json'), 'utf-8')
  ),
};

let activeLocale: Locale = 'en';

vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => (
    key: string,
    params?: Record<string, string | number>
  ) => {
    const dict = namespace === 'common' ? dictionaries[activeLocale] : {};
    const raw = key
      .split('.')
      .reduce<unknown>(
        (acc, part) =>
          acc && typeof acc === 'object'
            ? (acc as Record<string, unknown>)[part]
            : undefined,
        dict
      );
    if (typeof raw !== 'string') {
      throw new Error(`Missing translation: common.${key} (${activeLocale})`);
    }
    if (!params) return raw;
    return raw.replace(/\{(\w+)\}/g, (_match, name: string) => {
      if (!(name in params)) {
        throw new Error(`Unfilled placeholder {${name}} in common.${key}`);
      }
      return String(params[name]);
    });
  },
  useLocale: () => activeLocale,
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/lib/api-client', () => ({
  repositoryApi: { scan: vi.fn(), validatePath: vi.fn() },
  fsApi: { browse: vi.fn(), addRecentPath: vi.fn() },
  handleApiError: () => 'error',
}));

import { RepositoryManager } from '@/components/repository/RepositoryManager';
import { repositoryApi, fsApi } from '@/lib/api-client';

const ROOT = '/srv/repos';
const EXTRA_ROOT = '/mnt/work';

beforeEach(() => {
  activeLocale = 'en';
  vi.mocked(fsApi.browse).mockReset().mockResolvedValue({
    path: null,
    parent: null,
    roots: [ROOT, EXTRA_ROOT],
    recentPaths: [],
    entries: [],
    truncated: false,
    entryLimit: 500,
  });
  vi.mocked(repositoryApi.validatePath).mockReset().mockResolvedValue({
    valid: true,
    roots: [ROOT, EXTRA_ROOT],
    allowedRootsLabel: `${ROOT}, ${EXTRA_ROOT}`,
    isGitRepo: true,
    worktreeCount: 2,
  });
});

afterEach(() => {
  cleanup();
});

describe.each(LOCALES)('repository picker messages (%s)', (locale) => {
  beforeEach(() => {
    activeLocale = locale;
  });

  it('renders the example path built from the first allowed root', async () => {
    render(<RepositoryManager />);
    fireEvent.click(screen.getByRole('button', { name: /Add Repository|リポジトリを追加/ }));

    expect(await screen.findByText(new RegExp(`${ROOT}/my-repo`))).toBeDefined();
  });

  it('renders every allowed root in the hint', async () => {
    render(<RepositoryManager />);
    fireEvent.click(screen.getByRole('button', { name: /Add Repository|リポジトリを追加/ }));

    const hint = await screen.findByText(new RegExp(`${ROOT}, ${EXTRA_ROOT}`));
    expect(hint).toBeDefined();
  });

  it('renders the worktree count in the while-typing feedback', async () => {
    render(<RepositoryManager />);
    fireEvent.click(screen.getByRole('button', { name: /Add Repository|リポジトリを追加/ }));

    fireEvent.change(await screen.findByPlaceholderText('/absolute/path/to/repository'), {
      target: { value: `${ROOT}/my-repo` },
    });

    // "2 worktree(s)" / "worktree 2 件検出" — the count must be substituted.
    await waitFor(() => expect(screen.getByText(/2/)).toBeDefined());
    expect(document.body.textContent).not.toContain('{count}');
  });

  it('renders the out-of-scope message with the allowed roots substituted', async () => {
    vi.mocked(repositoryApi.validatePath).mockResolvedValue({
      valid: false,
      reason: 'outside-roots',
      roots: [ROOT, EXTRA_ROOT],
      allowedRootsLabel: `${ROOT}, ${EXTRA_ROOT}`,
      isGitRepo: false,
      worktreeCount: null,
    });

    render(<RepositoryManager />);
    fireEvent.click(screen.getByRole('button', { name: /Add Repository|リポジトリを追加/ }));

    fireEvent.change(await screen.findByPlaceholderText('/absolute/path/to/repository'), {
      target: { value: '/etc' },
    });

    await waitFor(() =>
      expect(document.body.textContent).toContain(`${ROOT}, ${EXTRA_ROOT}`)
    );
    expect(document.body.textContent).not.toContain('{roots}');
  });
});
