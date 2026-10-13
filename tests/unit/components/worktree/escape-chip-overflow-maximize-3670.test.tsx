/**
 * Escape on the second row's "…" panel over a maximized file (Issue #3670)
 *
 * The "…" panel (`ActionBarItemsOverflow`) closes on a document Escape and
 * only marks itself `data-floating-layer` — it does not `preventDefault`, so
 * the chip's reason (a document listener after it) still closes with it
 * (#3660). The maximized file (`FilePanelContent`) exits on a window Escape
 * and read only `isUnhandledEscape`, so one press closed the panel AND the
 * maximize. The panel now marks the press it closed on
 * (`markEscapeClosedLayer`) and the maximize reads it (`isEscapeNoLayerClosed`).
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

function maximize(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Maximize' }));
  expect(maximized()).toBe(true);
}

function maximized(): boolean {
  return screen.queryByTestId('maximized-file-overlay') !== null;
}

function panelOpen(): boolean {
  return screen.queryByTestId('split-action-bar-items-panel') !== null;
}

async function openOverflow(): Promise<HTMLElement> {
  const more = screen.getByTestId('split-action-bar-items-overflow');
  fireEvent.mouseDown(more);
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

describe('[#3670] the "…" panel over a maximized file', () => {
  it('closes only the panel on the first Escape, then the maximize on the second (positive)', async () => {
    render(<Screen />);
    maximize();
    const item = await openOverflow();

    pressEscape(item);
    expect(panelOpen()).toBe(false);
    expect(maximized()).toBe(true);

    pressEscape(document.activeElement ?? document.body);
    expect(maximized()).toBe(false);
  });

  it('still leaves the closing Escape unclaimed for document listeners after it', async () => {
    render(<Screen />);
    maximize();
    const item = await openOverflow();
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

  it('exits the maximize on the first Escape with the panel closed (negative control)', () => {
    render(<Screen />);
    maximize();
    pressEscape(screen.getByTestId('split-action-bar-items-overflow'));
    expect(maximized()).toBe(false);
  });
});
