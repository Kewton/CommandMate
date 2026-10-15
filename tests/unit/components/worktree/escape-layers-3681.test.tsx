/**
 * Escape, one layer per press from the front, for the two layers #3670 left
 * out (Issue #3681)
 *
 * 1. The chip's reason (`VerificationStatusChip`, PC = `popover="floating"`):
 *    a body portal at `Z_INDEX.MODAL` (50). A maximized file (the
 *    `FilePanelContent` overlay, `data-viewport-layer`, z 55) is drawn over
 *    it, so while it is, the first Escape is the file's alone and the reason
 *    closes on the second.
 * 2. The editor's own maximize (`MarkdownEditor`): it does not exit on a press
 *    a floating layer in front of it closed on (`markEscapeClosedLayer`).
 *    It is itself a viewport layer, so the reason and the second row's "…"
 *    panel behind it leave the first press to it too.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';
import { FilePanelContent } from '@/components/worktree/FilePanelContent';
import { MarkdownEditor } from '@/components/worktree/MarkdownEditor';
import { VerificationStatusChip } from '@/components/worktree/VerificationStatusChip';
import { ActionBarItemsOverflow } from '@/components/worktree/TerminalSplitContainer';
import { __resetApiReachabilityReporting } from '@/lib/api-client';
import { markEscapeClosedLayer, VIEWPORT_LAYER_ATTRIBUTE } from '@/lib/escape-key';
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

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

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

function Chip() {
  return <VerificationStatusChip task={null} latestRun={null} onOpen={vi.fn()} popover="floating" />;
}

beforeEach(() => {
  __resetApiReachabilityReporting();
  try {
    window.localStorage.clear();
  } catch {
    // jsdom always has it; the editor only persists its maximize flag there.
  }
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, content: '# Doc\n\ntext' }),
  });
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function pressEscape(target: Element): void {
  act(() => {
    fireEvent.keyDown(target, { key: 'Escape' });
  });
}

function reason(): HTMLElement | null {
  return screen.queryByTestId('verification-chip-reason-popover');
}

function openReason(): HTMLElement {
  const toggle = screen.getByTestId('verification-chip-reason-toggle');
  fireEvent.click(toggle);
  expect(reason()).not.toBeNull();
  return toggle;
}

// ---------------------------------------------------------------------------
// 1. The chip's reason and the maximized file
// ---------------------------------------------------------------------------

function FileScreen() {
  return (
    <>
      <Chip />
      <FilePanelContent
        tab={textTab()}
        worktreeId="wt-3681"
        onLoadContent={vi.fn()}
        onLoadError={vi.fn()}
        onSetLoading={vi.fn()}
      />
    </>
  );
}

function fileOverlay(): HTMLElement {
  return screen.getByTestId('maximized-file-overlay');
}

function fileMaximized(): boolean {
  return screen.queryByTestId('maximized-file-overlay') !== null;
}

/** A pointer press would close the reason first (outside it); Enter does not. */
function maximizeFileByKeyboard(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Maximize' }));
  expect(fileMaximized()).toBe(true);
}

describe('[#3681] the chip reason behind a maximized file', () => {
  it('has the maximized file in front of the reason (both body portals)', () => {
    render(<FileScreen />);
    openReason();
    maximizeFileByKeyboard();
    const popover = reason()!;
    expect(popover.parentElement).toBe(document.body);
    expect(fileOverlay().parentElement).toBe(document.body);
    expect(popover.style.zIndex).toBe(String(Z_INDEX.MODAL));
    expect(Number(fileOverlay().style.zIndex)).toBeGreaterThan(Number(popover.style.zIndex));
  });

  it('exits the maximize only on the first Escape, closes the reason on the second (positive)', () => {
    render(<FileScreen />);
    openReason();
    maximizeFileByKeyboard();

    pressEscape(document.body);
    expect(fileMaximized()).toBe(false);
    expect(reason()).not.toBeNull();

    pressEscape(document.body);
    expect(reason()).toBeNull();
  });

  it('closes the reason on the first Escape with no maximized file (negative control)', () => {
    render(<FileScreen />);
    openReason();
    pressEscape(document.body);
    expect(reason()).toBeNull();
  });

  it('closes the reason in front of the file first, then the maximize (negative control)', () => {
    render(<FileScreen />);
    openReason();
    maximizeFileByKeyboard();
    fileOverlay().style.zIndex = String(Z_INDEX.MODAL - 1);

    pressEscape(document.body);
    expect(reason()).toBeNull();
    expect(fileMaximized()).toBe(true);

    pressEscape(document.body);
    expect(fileMaximized()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. The editor's own maximize
// ---------------------------------------------------------------------------

function editor(): HTMLElement {
  return screen.getByTestId('markdown-editor');
}

function editorMaximized(): boolean {
  return screen.queryByTestId('maximize-hint') !== null;
}

async function renderMaximizedEditor(extra?: React.ReactNode): Promise<void> {
  render(
    <>
      {extra}
      <MarkdownEditor worktreeId="wt-3681" filePath="docs/readme.md" />
    </>
  );
  await waitFor(() => expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('maximize-button'));
  await waitFor(() => expect(editorMaximized()).toBe(true));
}

/**
 * A floating layer in front of the editor that closes on Escape without
 * claiming it (like the second row's "…" panel in front of a viewport layer).
 * Registered in the capture phase, so it runs before the editor's handlers.
 */
function withFrontLayerClosing(run: () => void): void {
  const frontLayer = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') markEscapeClosedLayer(event);
  };
  window.addEventListener('keydown', frontLayer, true);
  try {
    run();
  } finally {
    window.removeEventListener('keydown', frontLayer, true);
  }
}

describe('[#3681] the editor maximize under a floating layer that closed', () => {
  it('stays maximized on the press a front layer closed on, exits on the next (positive, document)', async () => {
    await renderMaximizedEditor();
    withFrontLayerClosing(() => pressEscape(document.body));
    expect(editorMaximized()).toBe(true);

    pressEscape(document.body);
    await waitFor(() => expect(editorMaximized()).toBe(false));
  });

  it('stays maximized on that press from inside the editor too (positive, textarea)', async () => {
    await renderMaximizedEditor();
    const textarea = screen.getByTestId('markdown-editor-textarea');
    withFrontLayerClosing(() => pressEscape(textarea));
    expect(editorMaximized()).toBe(true);

    pressEscape(textarea);
    await waitFor(() => expect(editorMaximized()).toBe(false));
  });

  it('exits on the first Escape with no floating layer (negative control)', async () => {
    await renderMaximizedEditor();
    pressEscape(document.body);
    await waitFor(() => expect(editorMaximized()).toBe(false));
  });
});

describe('[#3681] the maximized editor as a viewport layer', () => {
  it('marks the CSS-fallback overlay, and drops the mark when it exits', async () => {
    await renderMaximizedEditor();
    expect(editor().hasAttribute(VIEWPORT_LAYER_ATTRIBUTE)).toBe(true);
    expect(editor().parentElement?.parentElement).toBe(document.body);
    pressEscape(document.body);
    await waitFor(() => expect(editorMaximized()).toBe(false));
    expect(editor().hasAttribute(VIEWPORT_LAYER_ATTRIBUTE)).toBe(false);
  });

  it('marks the native Fullscreen API element as well', async () => {
    const originalEnabled = Object.getOwnPropertyDescriptor(document, 'fullscreenEnabled');
    const originalElement = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
    const originalRequest = Element.prototype.requestFullscreen;
    let inFullscreen = false;
    Object.defineProperty(document, 'fullscreenEnabled', { value: true, configurable: true });
    Object.defineProperty(document, 'fullscreenElement', {
      get: () => (inFullscreen ? document.body : null),
      configurable: true,
    });
    Element.prototype.requestFullscreen = vi.fn().mockImplementation(() => {
      inFullscreen = true;
      return Promise.resolve();
    });
    try {
      await renderMaximizedEditor();
      expect(editor().classList.contains('fixed')).toBe(false);
      expect(editor().hasAttribute(VIEWPORT_LAYER_ATTRIBUTE)).toBe(true);
    } finally {
      if (originalEnabled) {
        Object.defineProperty(document, 'fullscreenEnabled', originalEnabled);
      } else {
        // @ts-expect-error - delete property for cleanup
        delete document.fullscreenEnabled;
      }
      if (originalElement) {
        Object.defineProperty(document, 'fullscreenElement', originalElement);
      }
      Element.prototype.requestFullscreen = originalRequest;
    }
  });

  it('leaves the first Escape to the editor over the chip reason (positive)', async () => {
    render(
      <>
        <Chip />
        <MarkdownEditor worktreeId="wt-3681" filePath="docs/readme.md" />
      </>
    );
    await waitFor(() => expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument());
    openReason();
    fireEvent.click(screen.getByTestId('maximize-button'));
    await waitFor(() => expect(editorMaximized()).toBe(true));

    pressEscape(document.body);
    await waitFor(() => expect(editorMaximized()).toBe(false));
    expect(reason()).not.toBeNull();

    pressEscape(document.body);
    expect(reason()).toBeNull();
  });

  // Passes before the fix too (the editor's document listener, registered
  // first, claims the press), but now holds whatever the listener order.
  it('leaves the first Escape to the editor over the "…" panel', async () => {
    await renderMaximizedEditor(
      <ActionBarItemsOverflow label="More">
        <button type="button" data-testid="folded-item">
          folded
        </button>
      </ActionBarItemsOverflow>
    );
    fireEvent.click(screen.getByTestId('split-action-bar-items-overflow'));
    const panel = screen.getByTestId('split-action-bar-items-panel');
    const item = screen.getByTestId('folded-item');
    await waitFor(() => expect(document.activeElement).toBe(item));
    expect(Number(editor().style.zIndex)).toBeGreaterThan(Number(panel.style.zIndex));

    pressEscape(item);
    await waitFor(() => expect(editorMaximized()).toBe(false));
    expect(screen.queryByTestId('split-action-bar-items-panel')).not.toBeNull();

    pressEscape(item);
    expect(screen.queryByTestId('split-action-bar-items-panel')).toBeNull();
  });
});
