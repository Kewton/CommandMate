/**
 * Issue #4345 1c: the file surfaces a worktree page draws report their 401 through the gateway
 * under the page's registration holder (`HandoffPageOwnerContext`): the tree read (`FileTreeView`),
 * the editor's read and save (`MarkdownEditor`), the PC file panel's read, MARP render and partial
 * read (`FilePanelContent`, `useLazyChunkFetcher`), and the phone's file viewer read and MARP render
 * (`FileViewer`). Drawn beside the one host (see `page-owner-harness`).
 *
 * Positive controls are red before 1c (nothing here reported); the negative controls are green
 * before and after. The existing failure each surface tells is kept (checked for the tree and the
 * editor's save below).
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/wt-a',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));

import { FileTreeView } from '@/components/worktree/FileTreeView';
import { MarkdownEditor } from '@/components/worktree/MarkdownEditor';
import { FilePanelContent, useLazyChunkFetcher } from '@/components/worktree/FilePanelContent';
import { FileViewer } from '@/components/worktree/FileViewer';
import { ToastProvider } from '@/components/common/Toast';
import { resetHandoffStoreForTests } from '@/lib/handoff/close-rule';
import { resetHandoffRegistryForTests } from '@/lib/handoff/page-registration';
import type { FileTab } from '@/hooks/useFileTabs';
import {
  describeEntryCases,
  json,
  PAGE_WORKTREE as A,
  PageTree,
  standInPage,
  type EntryCase,
} from '../../lib/handoff/page-owner-harness';

beforeEach(() => {
  resetHandoffRegistryForTests();
  resetHandoffStoreForTests();
  window.localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetHandoffStoreForTests();
  resetHandoffRegistryForTests();
});

const MARP = '---\nmarp: true\n---\n# slide';
const noop = () => undefined;
const tabOf = (content: FileTab['content']): FileTab => ({ path: 'deck.md', name: 'deck.md', content, loading: false, error: null, isDirty: false });

function Chunks() {
  useLazyChunkFetcher({
    virtualItems: [{ index: 700, key: 700, start: 0, end: 20, size: 20, lane: 0 }] as never,
    worktreeId: A,
    filePath: 'big.log',
    onLineRangeFetched: noop,
    loadedStart: 1,
    loadedLineCount: 100,
  });
  return null;
}

/** The editor drawn and its draft changed, then saved. */
async function saveEditor(): Promise<void> {
  const textarea = await screen.findByTestId('markdown-editor-textarea');
  fireEvent.change(textarea, { target: { value: 'changed' } });
  fireEvent.click(screen.getByTestId('save-button'));
}

const CASES: Record<string, EntryCase> = {
  'tree read (FileTreeView)': {
    matches: (url) => url === `/api/worktrees/${A}/tree`,
    ok: () => json(200, { path: '', name: '', items: [], parentPath: null }),
    ui: () => <FileTreeView worktreeId={A} />,
  },
  'editor read (MarkdownEditor)': {
    matches: (url, method) => url === `/api/worktrees/${A}/files/docs/a.md` && method === 'GET',
    ok: () => json(200, { success: true, content: '# a' }),
    ui: () => <MarkdownEditor worktreeId={A} filePath="docs/a.md" />,
  },
  'editor save (MarkdownEditor)': {
    operation: true,
    matches: (url, method) => url === `/api/worktrees/${A}/files/docs/a.md` && method === 'PUT',
    ok: () => json(200, { success: true }),
    ui: () => <MarkdownEditor worktreeId={A} filePath="docs/a.md" />,
    trigger: saveEditor,
  },
  'panel read (FilePanelContent)': {
    matches: (url) => url === `/api/worktrees/${A}/files/deck.md`,
    ok: () => json(200, { path: 'deck.md', content: '# a', extension: 'md', worktreePath: '/p' }),
    ui: () => <FilePanelContent tab={tabOf(null)} worktreeId={A} onLoadContent={noop} onLoadError={noop} onSetLoading={noop} />,
  },
  'panel MARP render (FilePanelContent)': {
    matches: (url) => url === `/api/worktrees/${A}/marp-render`,
    ok: () => json(200, { slides: [] }),
    ui: () => (
      <FilePanelContent
        tab={tabOf({ path: 'deck.md', content: MARP, extension: 'md', worktreePath: '/p' } as FileTab['content'])}
        worktreeId={A}
        onLoadContent={noop}
        onLoadError={noop}
        onSetLoading={noop}
      />
    ),
  },
  'partial read (useLazyChunkFetcher)': {
    matches: (url) => url.startsWith(`/api/worktrees/${A}/files/big.log?startLine=`),
    ok: () => json(200, { success: true, content: 'x', range: { start: 601, end: 700 }, totalLines: 1000 }),
    ui: () => <Chunks />,
  },
  'phone viewer read (FileViewer)': {
    matches: (url) => url === `/api/worktrees/${A}/files/deck.md`,
    ok: () => json(200, { path: 'deck.md', content: '# a', extension: 'md', worktreePath: '/p' }),
    ui: () => <FileViewer isOpen onClose={noop} worktreeId={A} filePath="deck.md" />,
  },
  'phone viewer MARP render (FileViewer)': {
    matches: (url) => url === `/api/worktrees/${A}/marp-render`,
    ok: () => json(200, { slides: [] }),
    ui: () => <FileViewer isOpen onClose={noop} worktreeId={A} filePath="deck.md" />,
  },
};

/** Everything else: the files read normally (the MARP deck for the viewer's render). */
function fallback(url: string, init?: RequestInit): Response {
  if (url === `/api/worktrees/${A}/files/docs/a.md` && (init?.method ?? 'GET') === 'GET') return json(200, { success: true, content: '# a' });
  if (url === `/api/worktrees/${A}/files/deck.md`) return json(200, { path: 'deck.md', content: MARP, extension: 'md', worktreePath: '/p' });
  return json(200, {});
}

describeEntryCases('the file surfaces', CASES, fallback);

describe('[#4345 1c] (negative controls) the existing failure is still told', () => {
  it('the tree read’s 401 still shows the tree’s load error', async () => {
    global.fetch = vi.fn(async () => json(401, { error: 'x' })) as unknown as typeof fetch;
    const page = standInPage();
    render(
      <PageTree owner={page.owner}>
        <FileTreeView worktreeId={A} />
      </PageTree>,
    );
    await waitFor(() => expect(screen.getByText(/401/)).toBeInTheDocument());
  });

  it('the editor save’s 401 still says the session expired', async () => {
    global.fetch = vi.fn(async (input: unknown, init?: RequestInit) =>
      init?.method === 'PUT' ? json(401, { error: 'x' }) : json(200, { success: true, content: '# a' }),
    ) as unknown as typeof fetch;
    const page = standInPage();
    render(
      <ToastProvider>
        <PageTree owner={page.owner}>
          <MarkdownEditor worktreeId={A} filePath="docs/a.md" />
        </PageTree>
      </ToastProvider>,
    );
    await saveEditor();
    await waitFor(() => expect(document.body.textContent).toMatch(/expired/i));
  });
});
