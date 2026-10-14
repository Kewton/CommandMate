/**
 * The PC file panel's search bar follows the Escape layer rule (Issue #3700)
 *
 * `FileSearchBar` is a layer in front of the maximized file: its Escape closes
 * the search alone and marks the press (`markEscapeClosedLayer`), so the
 * maximize (a window listener reading the mark) waits for the next one. Behind
 * a viewport layer drawn over the maximized file, the press is that layer's:
 * the search bar neither closes nor marks it — the same shape as FileViewer's
 * search bar (#3691).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { FilePanelContent } from '@/components/worktree/FilePanelContent';
import { __resetApiReachabilityReporting } from '@/lib/api-client';
import type { FileTab } from '@/hooks/useFileTabs';
import { isEscapeNoLayerClosed, VIEWPORT_LAYER_ATTRIBUTE } from '@/lib/escape-key';
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

beforeEach(() => {
  global.fetch = vi.fn();
  __resetApiReachabilityReporting();
});

afterEach(() => {
  cleanup();
  document.querySelectorAll('[data-testid="front-viewport-layer"]').forEach((el) => el.remove());
  vi.clearAllMocks();
});

function renderPanel(): void {
  render(
    <FilePanelContent
      tab={textTab()}
      worktreeId="wt-3700"
      onLoadContent={vi.fn()}
      onLoadError={vi.fn()}
      onSetLoading={vi.fn()}
    />
  );
}

function maximized(): boolean {
  return screen.queryByTestId('maximized-file-overlay') !== null;
}

function maximize(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Maximize' }));
  expect(maximized()).toBe(true);
}

function searchInput(): HTMLElement | null {
  return screen.queryByPlaceholderText(/.+/);
}

function openSearch(): HTMLElement {
  const buttons = screen.getAllByRole('button', { name: /search in file/i });
  fireEvent.click(buttons[buttons.length - 1]);
  const input = searchInput();
  expect(input).not.toBeNull();
  return input!;
}

function pressEscape(target: Element): void {
  act(() => {
    fireEvent.keyDown(target, { key: 'Escape' });
  });
}

describe('[#3700] FileSearchBar in front of the maximized file', () => {
  it('closes the search alone on the first Escape, the maximize on the second (positive)', () => {
    renderPanel();
    maximize();
    const input = openSearch();

    pressEscape(input);
    expect(searchInput()).toBeNull();
    expect(maximized()).toBe(true);

    pressEscape(document.activeElement ?? document.body);
    expect(maximized()).toBe(false);
  });

  it('exits the maximize on the first Escape with no search bar (negative control)', () => {
    renderPanel();
    maximize();

    pressEscape(document.body);
    expect(maximized()).toBe(false);
  });

  it('still closes on Escape when the file is not maximized', () => {
    renderPanel();
    const input = openSearch();

    pressEscape(input);
    expect(searchInput()).toBeNull();
  });
});

describe('[#3700] FileSearchBar behind a viewport layer', () => {
  it('neither closes the search nor marks the press', () => {
    renderPanel();
    maximize();
    const input = openSearch();

    const front = document.createElement('div');
    front.setAttribute('data-testid', 'front-viewport-layer');
    front.setAttribute(VIEWPORT_LAYER_ATTRIBUTE, '');
    front.style.zIndex = String(Z_INDEX.MAXIMIZED_EDITOR + 1);
    document.body.appendChild(front);

    // Read the press after the search bar, then let the front layer take it
    // (a claim, like the maximized editor's) so the file's maximize — and the
    // search bar mounted in it — stay for the assertions.
    let unmarked: boolean | null = null;
    const after = (event: KeyboardEvent): void => {
      unmarked = isEscapeNoLayerClosed(event);
    };
    const frontLayer = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') event.preventDefault();
    };
    document.addEventListener('keydown', after);
    document.addEventListener('keydown', frontLayer);
    try {
      pressEscape(input);
    } finally {
      document.removeEventListener('keydown', after);
      document.removeEventListener('keydown', frontLayer);
    }
    expect(unmarked).toBe(true);
    expect(searchInput()).not.toBeNull();
    expect(maximized()).toBe(true);
  });
});
