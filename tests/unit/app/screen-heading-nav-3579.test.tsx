/**
 * The screen name is the page's own <h1>, in the sidebar's words (Issue #3579).
 *
 * The global Header stopped naming the list screens (it showed `common.nav.*`),
 * so each page's <h1> is now the only place the name appears. It must say the
 * same as the sidebar / icon rail destination it was reached from, in both
 * locales — `/repositories` used to hardcode "Repositories" even under ja.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import fs from 'fs';
import path from 'path';

const locale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => locale.current);
});

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
}));

vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useWorktreesCacheContext: () => ({
    worktrees: [],
    repositories: [],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock('@/components/repository', () => ({
  RepositoryManager: () => <div />,
  RepositoryList: () => <div />,
}));
vi.mock('@/components/review/ReviewTab', () => ({ default: () => <div /> }));
vi.mock('@/components/review/ReportTab', () => ({ default: () => <div /> }));
vi.mock('@/components/review/TemplateTab', () => ({ default: () => <div /> }));
vi.mock('@/components/skills/SkillCatalogView', () => ({ SkillCatalogView: () => <div /> }));

import SessionsPage from '@/app/sessions/page';
import RepositoriesPage from '@/app/repositories/page';
import ReviewPage from '@/app/review/page';
import SkillsPage from '@/app/skills/page';
import MorePage from '@/app/more/page';

function readCommon(lang: string): { nav: Record<string, string> } {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), `locales/${lang}/common.json`), 'utf-8'));
}
const NAV = { en: readCommon('en').nav, ja: readCommon('ja').nav };

const PAGES: Array<[string, string, React.ComponentType]> = [
  ['/sessions', 'sessions', SessionsPage],
  ['/repositories', 'repositories', RepositoriesPage],
  ['/review', 'review', ReviewPage],
  ['/skills', 'skills', SkillsPage],
  ['/more', 'more', MorePage],
];

beforeEach(() => {
  locale.current = 'en';
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ apps: [] }),
  }) as unknown as typeof fetch;
});

describe('screen headings use the sidebar destination words (Issue #3579)', () => {
  describe.each(['en', 'ja'] as const)('%s', (lang) => {
    it.each(PAGES)('%s has one <h1>, common.nav.%s', (_route, key, Page) => {
      locale.current = lang;
      render(<Page />);
      const headings = screen.getAllByRole('heading', { level: 1 });
      expect(headings).toHaveLength(1);
      expect(headings[0]).toHaveTextContent(NAV[lang][key]);
      expect(headings[0].textContent?.trim()).toBe(NAV[lang][key]);
    });
  });

  it('ja /repositories reads リポジトリ, not the English literal', () => {
    locale.current = 'ja';
    render(<RepositoriesPage />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('リポジトリ');
    expect(screen.queryByText('Repositories')).toBeNull();
  });
});

describe('/repositories description comes from locales (Issue #3586)', () => {
  const read = (lang: string): { repositories: { pageDescription: string } } =>
    JSON.parse(fs.readFileSync(path.resolve(process.cwd(), `locales/${lang}/common.json`), 'utf-8'));

  it('en keeps the existing sentence', () => {
    locale.current = 'en';
    render(<RepositoriesPage />);
    expect(screen.getByText('Manage repositories and worktrees.')).toBeTruthy();
    expect(read('en').repositories.pageDescription).toBe('Manage repositories and worktrees.');
  });

  it('ja shows the Japanese sentence, not the English literal', () => {
    locale.current = 'ja';
    render(<RepositoriesPage />);
    expect(screen.getByText(read('ja').repositories.pageDescription)).toBeTruthy();
    expect(screen.queryByText('Manage repositories and worktrees.')).toBeNull();
  });
});
