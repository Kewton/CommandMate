/**
 * mem の一覧と決定の画面が最後までスクロールできること (Issue #4521).
 *
 * AppShell の main は `flex-1 min-h-0 overflow-hidden` で、ページ自身がスクロールの箱を
 * 持つ前提（src/components/layout/AppShell.tsx）。ほかの一覧のページは根に
 * `overflow-auto h-full` を持つ（src/app/page.tsx）。mem の 2 画面は根が
 * `mx-auto max-w-3xl space-y-4 p-4` だけで、箱が無かった。
 *
 * ここで見るのはその箱: 根に `h-full` と `overflow-auto` があり、中の
 * `mx-auto max-w-3xl` はそのまま残る（横に広げない・幅を固定しない）。
 *
 * 陽性対照: 直す前の根（`mx-auto max-w-3xl …` だけ）を os.tmpdir() の写しで描画すると、
 * 根に箱の class が無いのでこの試験は落ちる。陰性対照: 中の class はそのままで、
 * /repositories は PullToRefresh が箱を持つ（この PR で触っていない）。
 *
 * Runs in the node environment: a module outside the project (the os.tmpdir() copy of the
 * screen) can only be imported there, with jsdom set up by hand (as #4388's mutant test does).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { builtinEnvironments } from 'vitest/runtime';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';

const nav = vi.hoisted(() => ({ id: 'repo-a', search: 'branch=feature%2Fx' }));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: nav.id }),
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});
// The panels own their reads/writes; this test only looks at the page's scroll box.
vi.mock('@/components/mem/MemItemsPanel', () => ({
  MemItemsPanel: () => React.createElement('div', { 'data-testid': 'mem-items-panel' }),
}));
vi.mock('@/components/mem/DecisionPromotePanel', () => ({
  DecisionPromotePanel: () => React.createElement('div', { 'data-testid': 'decision-promote-panel' }),
}));
vi.mock('@/components/repository', () => ({
  RepositoryManager: () => React.createElement('div', { 'data-testid': 'repository-manager' }),
  RepositoryList: () => React.createElement('div', { 'data-testid': 'repository-list' }),
}));

import MemItemsPage from '@/app/repositories/[id]/mem/page';
import MemDecisionsPage from '@/app/repositories/[id]/mem/decisions/page';
import RepositoriesPage from '@/app/repositories/page';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const MEM_ITEMS_SOURCE = path.join(REPO_ROOT, 'src/app/repositories/[id]/mem/page.tsx');
const MEM_DECISIONS_SOURCE = path.join(REPO_ROOT, 'src/app/repositories/[id]/mem/decisions/page.tsx');

type Page = () => React.ReactElement;

let rtl: typeof import('@testing-library/react');
let teardownDom: (() => unknown) | null = null;
beforeAll(async () => {
  const env = await builtinEnvironments.jsdom.setup(globalThis, {});
  teardownDom = () => env.teardown(globalThis);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom does not implement matchMedia; useIsMobile reads it on mount.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  // The decisions screen reads its branches on mount; an answer landing after the
  // jsdom teardown is an unhandled error, so the request is left pending (this test
  // looks at the scroll box only).
  global.fetch = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
  rtl = await import('@testing-library/react');
});

afterAll(async () => {
  await teardownDom?.();
});

/** The root of what a page rendered; Suspense adds no element of its own. */
const rootOf = (container: HTMLElement): HTMLElement => container.firstElementChild as HTMLElement;

let dir: string | null = null;
afterEach(() => {
  rtl.cleanup();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/**
 * The page before its fix: the same screen without the scroll box around the
 * `mx-auto max-w-3xl` block, written to a fresh os.tmpdir() directory (the
 * repository's files are never touched).
 */
async function loadBefore(sourcePath: string): Promise<Page> {
  const mutations = [
    {
      from: '    <div className="h-full overflow-auto">\n      <div className="mx-auto max-w-3xl space-y-4 p-4">',
      to: '    <div className="mx-auto max-w-3xl space-y-4 p-4">',
    },
    { from: '      </div>\n    </div>\n  );\n}', to: '    </div>\n  );\n}' },
  ];
  let source = fs.readFileSync(sourcePath, 'utf8');
  for (const mutation of mutations) {
    expect(source).toContain(mutation.from);
    source = source.replace(mutation.from, mutation.to);
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4521-'));
  const file = path.join(dir, 'before.tsx');
  fs.writeFileSync(file, source);
  return ((await import(/* @vite-ignore */ pathToFileURL(file).href)) as { default: Page }).default;
}

const expectScrollBox = (root: HTMLElement) => {
  expect(root).toHaveClass('h-full');
  expect(root).toHaveClass('overflow-auto');
};

describe('mem の一覧 (Issue #4521)', () => {
  it('根に h-full overflow-auto の箱があり、中の mx-auto max-w-3xl はそのまま', () => {
    const { container } = rtl.render(<MemItemsPage />);
    const root = rootOf(container as HTMLElement);
    expectScrollBox(root);
    const inner = root.firstElementChild as HTMLElement;
    expect(inner).toHaveClass('mx-auto');
    expect(inner).toHaveClass('max-w-3xl');
    expect(inner).toHaveClass('space-y-4');
    expect(inner).toHaveClass('p-4');
  });

  it('(陰性対照) 横に広げない: overflow-x を足さず、幅を固定しない', () => {
    const { container } = rtl.render(<MemItemsPage />);
    const root = rootOf(container as HTMLElement);
    expect(root.className).not.toMatch(/overflow-x-/);
    expect(root.className).not.toMatch(/(^|\s)w-\d/);
    expect(root.className).not.toMatch(/(^|\s)min-w-\[/);
  });

  it('(陽性対照) 直す前の根には箱が無い', async () => {
    const Before = await loadBefore(MEM_ITEMS_SOURCE);
    const { container } = rtl.render(<Before />);
    const before = rootOf(container as HTMLElement);
    expect(before).toHaveClass('mx-auto');
    expect(before).toHaveClass('max-w-3xl');
    expect(before).not.toHaveClass('h-full');
    expect(before).not.toHaveClass('overflow-auto');
  });
});

describe('mem の決定 (Issue #4521)', () => {
  it('根に h-full overflow-auto の箱があり、中の mx-auto max-w-3xl はそのまま', () => {
    const { container } = rtl.render(<MemDecisionsPage />);
    const root = rootOf(container as HTMLElement);
    expectScrollBox(root);
    const inner = root.firstElementChild as HTMLElement;
    expect(inner).toHaveClass('mx-auto');
    expect(inner).toHaveClass('max-w-3xl');
    expect(inner).toHaveClass('space-y-4');
    expect(inner).toHaveClass('p-4');
    expect(rtl.screen.getByTestId('decision-repository-select')).toBeTruthy();
  });

  it('(陰性対照) 横に広げない: overflow-x を足さず、幅を固定しない', () => {
    const { container } = rtl.render(<MemDecisionsPage />);
    const root = rootOf(container as HTMLElement);
    expect(root.className).not.toMatch(/overflow-x-/);
    expect(root.className).not.toMatch(/(^|\s)w-\d/);
    expect(root.className).not.toMatch(/(^|\s)min-w-\[/);
  });

  it('(陽性対照) 直す前の根には箱が無い', async () => {
    const Before = await loadBefore(MEM_DECISIONS_SOURCE);
    const { container } = rtl.render(<Before />);
    const before = rootOf(container as HTMLElement);
    expect(before).toHaveClass('mx-auto');
    expect(before).toHaveClass('max-w-3xl');
    expect(before).not.toHaveClass('h-full');
    expect(before).not.toHaveClass('overflow-auto');
  });
});

describe('/repositories は変わらない (Issue #4521)', () => {
  it('(陰性対照) PullToRefresh が箱（overflow-auto）を持ったまま', () => {
    rtl.render(<RepositoriesPage />);
    expect(rtl.screen.getByTestId('pull-to-refresh')).toHaveClass('overflow-auto');
    expect(rtl.screen.getByTestId('repository-manager')).toBeTruthy();
    expect(rtl.screen.getByTestId('repository-list')).toBeTruthy();
  });
});
