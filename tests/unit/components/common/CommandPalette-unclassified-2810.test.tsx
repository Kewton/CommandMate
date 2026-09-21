/**
 * The command palette's worktree rows draw "cannot tell" for a worktree whose
 * only reading is an agent frame no rule could read (Issue #2810).
 *
 * The row's dot used to come from the worktree-level flags alone, and an
 * unreadable frame raises none of them (#2775), so it was the static green
 * `ready`. The per-CLI entries are now asked too, with the sidebar's
 * precedence: waiting > running > cannot tell > ready.
 *
 * Harness from `CommandPalette.test.tsx`, with the real `ja` dictionary so the
 * word 不明 itself is pinned.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { UNCLASSIFIED_STATUS_DOT_CLASS } from '@/components/sidebar/BranchStatusIndicator';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/',
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
}));

vi.mock('@/contexts/PcDisplaySizeContext', () => ({
  usePcDisplaySizeContext: () => ({
    size: 'medium',
    setSize: vi.fn(),
    isMobile: false,
    factor: 1,
    isAvailable: false,
  }),
}));

let mockWorktrees: Array<Record<string, unknown>> = [];
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => ({
    worktrees: mockWorktrees,
    repositories: [],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useLocaleSwitch', () => ({
  useLocaleSwitch: () => ({ currentLocale: 'ja', switchLocale: vi.fn() }),
}));

import { CommandPalette } from '@/components/common/CommandPalette';
import { ToastProvider } from '@/components/common/Toast';
import { ViewTransitionsProvider } from '@/components/providers/ViewTransitionsProvider';
import { CommandPaletteProvider } from '@/contexts/CommandPaletteContext';

const BASE = {
  isRunning: true,
  isWaitingForResponse: false,
  waitingKind: null,
  waitingSince: null,
  awaitingInstruction: false,
} as const;

const UNCLASSIFIED = {
  ...BASE,
  isProcessing: false,
  statusEvidence: 'none',
  sessionStatusReason: 'default',
  isUnclassified: true,
};

const THINKING = {
  ...BASE,
  isProcessing: true,
  statusEvidence: 'positive',
  sessionStatusReason: 'thinking_indicator',
};

const READY = {
  ...BASE,
  isProcessing: false,
  statusEvidence: 'positive',
  sessionStatusReason: 'input_prompt',
};

const WAITING = {
  ...BASE,
  isWaitingForResponse: true,
  isProcessing: false,
  waitingKind: 'prompt',
};

type Entry = { isRunning: boolean; isWaitingForResponse: boolean; isProcessing: boolean };

/**
 * One worktree row. The worktree-level triple is folded from the entries the
 * way the list API folds it (logical OR), so each fixture is a payload the
 * server could actually send.
 */
function worktree(sessionStatusByCli: Record<string, Entry>) {
  const entries = Object.values(sessionStatusByCli);
  return {
    id: 'wt-2810',
    name: 'fix/2810',
    branch: 'fix/2810',
    repositoryName: 'CommandMate',
    sessionStatusByCli,
    isSessionRunning: entries.some((e) => e.isRunning),
    isWaitingForResponse: entries.some((e) => e.isWaitingForResponse),
    isProcessing: entries.some((e) => e.isProcessing),
  };
}

function renderOpenPalette() {
  render(
    <ToastProvider>
      <ViewTransitionsProvider>
        <CommandPaletteProvider>
          <CommandPalette />
        </CommandPaletteProvider>
      </ViewTransitionsProvider>
    </ToastProvider>
  );
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'k', metaKey: true }));
  });
}

/** Every worktree-row dot on screen (the Recent row and the Worktrees row). */
function rowDots(): HTMLElement[] {
  return screen
    .getAllByText('fix/2810')
    .map((label) => label.closest('[cmdk-item]')!.querySelector('span.rounded-full') as HTMLElement);
}

function expectCannotTell(dot: HTMLElement): void {
  expect(dot).toHaveAttribute('data-unclassified', 'true');
  for (const cls of UNCLASSIFIED_STATUS_DOT_CLASS.split(' ')) {
    expect(dot.className).toContain(cls);
  }
  expect(dot.className).not.toMatch(/animate-status/);
  expect(dot.className).not.toContain('bg-success');
  expect(dot.getAttribute('aria-label')).toBe('不明');
}

describe('[#2810] CommandPalette worktree row dot', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('is the "cannot tell" ring, labelled 不明, when the only reading is an unreadable frame', () => {
    mockWorktrees = [worktree({ codex: UNCLASSIFIED })];
    renderOpenPalette();

    const dots = rowDots();
    expect(dots).toHaveLength(1);
    expectCannotTell(dots[0]);
    // Layout class survives the merge.
    expect(dots[0].className).toContain('ml-auto');
  });

  it('draws the same ring on the Recent row', () => {
    localStorage.setItem('cm.palette.recents', JSON.stringify([{ kind: 'worktree', id: 'wt-2810' }]));
    mockWorktrees = [worktree({ codex: UNCLASSIFIED })];
    renderOpenPalette();

    const dots = rowDots();
    expect(dots).toHaveLength(2);
    dots.forEach(expectCannotTell);
  });

  it('outranks a sibling agent that is merely ready', () => {
    mockWorktrees = [worktree({ claude: READY, codex: UNCLASSIFIED })];
    renderOpenPalette();

    expectCannotTell(rowDots()[0]);
  });

  it('a running with positive evidence still glows, labelled 実行中', () => {
    mockWorktrees = [worktree({ codex: THINKING })];
    renderOpenPalette();

    const [dot] = rowDots();
    expect(dot).not.toHaveAttribute('data-unclassified');
    expect(dot.className).toMatch(/animate-status-glow/);
    expect(dot.getAttribute('aria-label')).toBe('実行中');
  });

  it('a working sibling outranks it (running > cannot tell)', () => {
    mockWorktrees = [worktree({ claude: THINKING, codex: UNCLASSIFIED })];
    renderOpenPalette();

    const [dot] = rowDots();
    expect(dot).not.toHaveAttribute('data-unclassified');
    expect(dot.className).toMatch(/animate-status-glow/);
  });

  it('a waiting sibling outranks it (waiting > cannot tell)', () => {
    mockWorktrees = [worktree({ claude: WAITING, codex: UNCLASSIFIED })];
    renderOpenPalette();

    const [dot] = rowDots();
    expect(dot).not.toHaveAttribute('data-unclassified');
    expect(dot.className).toMatch(/animate-status-attention/);
    expect(dot.getAttribute('aria-label')).toBe('応答待ち');
  });

  it('a ready that was actually read stays the green ready dot', () => {
    mockWorktrees = [worktree({ codex: READY })];
    renderOpenPalette();

    const [dot] = rowDots();
    expect(dot).not.toHaveAttribute('data-unclassified');
    expect(dot.className).toContain('bg-success');
    expect(dot.getAttribute('aria-label')).toBe('準備完了');
  });
});
