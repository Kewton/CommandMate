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
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';
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

// ---------------------------------------------------------------------------
// The unmaximized panel's search bar and the editor's own CSS maximize
// ---------------------------------------------------------------------------

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

function markdownTab(): FileTab {
  return {
    path: 'docs/readme.md',
    name: 'readme.md',
    content: {
      path: 'docs/readme.md',
      content: '# Doc\n\ntext',
      extension: 'md',
      worktreePath: '/repo',
    },
    loading: false,
    error: null,
    isDirty: false,
  };
}

/** The editor's textarea has a placeholder too, so match the search bar's. */
function fileSearchInput(): HTMLElement | null {
  return screen.queryByPlaceholderText('Search...');
}

function openFileSearch(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: /search in file/i }));
  const input = fileSearchInput();
  expect(input).not.toBeNull();
  return input!;
}

function editorMaximized(): boolean {
  return screen.queryByTestId('maximize-hint') !== null;
}

/** The panel unmaximized, its search bar open, the editor under it. */
async function renderMarkdownPanelWithSearch(): Promise<HTMLElement> {
  try {
    window.localStorage.clear();
  } catch {
    // jsdom always has it; the editor only persists its maximize flag there.
  }
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, content: '# Doc\n\ntext' }),
  }) as unknown as typeof fetch;
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
  render(
    <FilePanelContent
      tab={markdownTab()}
      worktreeId="wt-3700"
      onLoadContent={vi.fn()}
      onLoadError={vi.fn()}
      onSetLoading={vi.fn()}
    />
  );
  await waitFor(() => expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument());
  expect(maximized()).toBe(false);
  return openFileSearch();
}

describe('[#3700] the unmaximized panel search bar behind the editor CSS maximize', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('leaves the press to the maximized editor in front and stays open (positive)', async () => {
    const input = await renderMarkdownPanelWithSearch();
    fireEvent.click(screen.getByTestId('maximize-button'));
    await waitFor(() => expect(editorMaximized()).toBe(true));

    pressEscape(input);
    expect(editorMaximized()).toBe(false);
    expect(fileSearchInput()).not.toBeNull();
  });

  it('closes the search on Escape with the editor not maximized (negative control)', async () => {
    const input = await renderMarkdownPanelWithSearch();

    pressEscape(input);
    expect(fileSearchInput()).toBeNull();
    expect(editorMaximized()).toBe(false);
  });
});
