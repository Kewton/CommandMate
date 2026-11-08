/**
 * @vitest-environment jsdom
 *
 * Issue #4257: Storage の getItem/setItem/removeItem が例外を投げる環境で、
 * 親のページ部品を描画してもエラー境界に落ちず、既定値で表示される。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const mockReplace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: mockReplace }),
  useParams: () => ({ id: 'wt-1', path: ['docs', 'a.md'] }),
}));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useWorktreesCacheContext: () => ({
    worktrees: [],
    repositories: [],
    isLoading: false,
    error: null,
    refresh: vi.fn(() => Promise.resolve()),
  }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<'a'>) => (
    <a href={href as string} {...rest}>
      {children}
    </a>
  ),
}));

import FileViewerPage from '@/app/worktrees/[id]/files/[...path]/page';
import Home from '@/app/page';
import { MarkdownEditor } from '@/components/worktree/MarkdownEditor';

const MARKDOWN = '# A\n\n## B\n\ntext';

beforeEach(() => {
  const boom = () => {
    throw new DOMException('denied', 'SecurityError');
  };
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        path: 'docs/a.md',
        extension: 'md',
        worktreePath: '/wt',
        content: MARKDOWN,
      }),
    })
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Storage が使えない環境 (Issue #4257)', () => {
  it('ファイル画面は既定値で本文を表示する', async () => {
    render(<FileViewerPage />);
    expect(await screen.findByRole('heading', { name: 'A', level: 1 })).toBeTruthy();
  });

  it('トップ画面は例外にならず描画する', () => {
    expect(() => render(<Home />)).not.toThrow();
  });

  it('MarkdownEditor は既定の表示モードで描画する', () => {
    expect(() =>
      render(<MarkdownEditor worktreeId="wt-1" filePath="a.md" />)
    ).not.toThrow();
  });
});
