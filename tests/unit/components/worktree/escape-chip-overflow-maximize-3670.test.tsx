/**
 * Escape on the second row's "…" panel and a maximized file (Issue #3670)
 *
 * The "…" panel (`ActionBarItemsOverflow`) closes on a document Escape without
 * `preventDefault` — the chip's reason (a document listener after it) closes
 * with it (#3660). The maximized file (`FilePanelContent`) exits on a window
 * Escape. Both are portalled to `<body>`: the panel at `Z_INDEX.MODAL` (50),
 * the file's `fixed inset-0` overlay at `Z_INDEX.MAXIMIZED_EDITOR` (55), so
 * with both open the file is in front. Escape closes the front layer first:
 * - panel behind the file (the real stacking): the first press exits the
 *   maximize only, the second closes the panel;
 * - panel in front (its z above the overlay's): the first press closes the
 *   panel only (`markEscapeClosedLayer`), the second exits the maximize.
 * The order is read from the z-index the two elements actually carry.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';
import { FilePanelContent } from '@/components/worktree/FilePanelContent';
import { ActionBarItemsOverflow } from '@/components/worktree/TerminalSplitContainer';
import { __resetApiReachabilityReporting } from '@/lib/api-client';
import type { FileTab } from '@/hooks/useFileTabs';
import { Z_INDEX } from '@/config/z-index';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('highlight.js', () => ({
  default: {
    highlightAuto: (code: string) => ({ value: `<span class="hljs">${code}</span>` }),
  },
}));

function textTab(): FileTab {
  return {
    path: 'src/index.ts',
    name: 'index.ts',
    content: {
      path: 'src/index.ts',
      content: 'const x = 1;',
      extension: 'ts',
      worktreePath: '/repo',
    },
    loading: false,
    error: null,
    isDirty: false,
  };
}

function Screen() {
  return (
    <>
      <ActionBarItemsOverflow label="More">
        <button type="button" data-testid="folded-item">
          folded
        </button>
      </ActionBarItemsOverflow>
      <FilePanelContent
        tab={textTab()}
        worktreeId="wt-3670"
        onLoadContent={vi.fn()}
        onLoadError={vi.fn()}
        onSetLoading={vi.fn()}
      />
    </>
  );
}

beforeEach(() => {
  global.fetch = vi.fn();
  __resetApiReachabilityReporting();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** A pointer press would close the panel first (outside it); Enter does not. */
function maximizeByKeyboard(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Maximize' }));
  expect(maximized()).toBe(true);
}

function overlay(): HTMLElement {
  return screen.getByTestId('maximized-file-overlay');
}

function panel(): HTMLElement {
  return screen.getByTestId('split-action-bar-items-panel');
}

function maximized(): boolean {
  return screen.queryByTestId('maximized-file-overlay') !== null;
}

function panelOpen(): boolean {
  return screen.queryByTestId('split-action-bar-items-panel') !== null;
}

/** The overlay has no focus trap, so "…" under it is still reached by Tab. */
async function openOverflow(): Promise<HTMLElement> {
  const more = screen.getByTestId('split-action-bar-items-overflow');
  fireEvent.click(more);
  expect(panelOpen()).toBe(true);
  const item = screen.getByTestId('folded-item');
  await waitFor(() => expect(document.activeElement).toBe(item));
  return item;
}

function pressEscape(target: Element): void {
  act(() => {
    fireEvent.keyDown(target, { key: 'Escape' });
  });
}

/** Both are body portals, so their z-index orders them against each other. */
function expectStacking(front: HTMLElement, back: HTMLElement): void {
  expect(front.parentElement).toBe(document.body);
  expect(back.parentElement).toBe(document.body);
  expect(Number(front.style.zIndex)).toBeGreaterThan(Number(back.style.zIndex));
}

describe('[#3670] the "…" panel behind a maximized file (the real stacking)', () => {
  it('has the maximized file in front of the panel', async () => {
    render(<Screen />);
    await openOverflow();
    maximizeByKeyboard();
    expect(panel().style.zIndex).toBe(String(Z_INDEX.MODAL));
    expect(overlay().style.zIndex).toBe(String(Z_INDEX.MAXIMIZED_EDITOR));
    expectStacking(overlay(), panel());
  });

  it('opened then maximized: the first Escape exits the maximize only, the second closes the panel', async () => {
    render(<Screen />);
    const item = await openOverflow();
    maximizeByKeyboard();

    pressEscape(item);
    expect(maximized()).toBe(false);
    expect(panelOpen()).toBe(true);

    pressEscape(item);
    expect(panelOpen()).toBe(false);
  });

  it('maximized then opened: the same, front layer first', async () => {
    render(<Screen />);
    maximizeByKeyboard();
    const item = await openOverflow();
    expectStacking(overlay(), panel());

    pressEscape(item);
    expect(maximized()).toBe(false);
    expect(panelOpen()).toBe(true);

    pressEscape(item);
    expect(panelOpen()).toBe(false);
  });
});

describe('[#3670] the "…" panel in front of a maximized file', () => {
  async function panelInFront(): Promise<HTMLElement> {
    render(<Screen />);
    maximizeByKeyboard();
    const item = await openOverflow();
    overlay().style.zIndex = String(Z_INDEX.MODAL - 1);
    expectStacking(panel(), overlay());
    return item;
  }

  it('closes only the panel on the first Escape, then the maximize on the second (positive)', async () => {
    const item = await panelInFront();

    pressEscape(item);
    expect(panelOpen()).toBe(false);
    expect(maximized()).toBe(true);

    pressEscape(document.activeElement ?? document.body);
    expect(maximized()).toBe(false);
  });

  it('still leaves the closing Escape unclaimed for document listeners after it', async () => {
    const item = await panelInFront();
    let claimed: boolean | null = null;
    const after = (event: KeyboardEvent): void => {
      claimed = event.defaultPrevented;
    };
    document.addEventListener('keydown', after);
    try {
      pressEscape(item);
    } finally {
      document.removeEventListener('keydown', after);
    }
    expect(panelOpen()).toBe(false);
    expect(claimed).toBe(false);
  });
});

describe('[#3670] no "…" panel open', () => {
  it('exits the maximize on the first Escape (negative control)', () => {
    render(<Screen />);
    maximizeByKeyboard();
    pressEscape(screen.getByTestId('split-action-bar-items-overflow'));
    expect(maximized()).toBe(false);
  });
});
