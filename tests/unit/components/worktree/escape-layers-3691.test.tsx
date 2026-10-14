/**
 * Escape, one layer per press from the front, for the three receivers #3681
 * left out (Issue #3691)
 *
 * 1. FileViewer's fullscreen (the read-only overlay's window listener and the
 *    unified screen's Escape ladder) does not undo itself on a press a layer in
 *    front of it closed on (`markEscapeClosedLayer`). Both screens cover the
 *    viewport (`fixed inset-0`, z 55), so they carry `data-viewport-layer` and
 *    the chip's reason / the second row's "…" panel behind them leave the first
 *    press to them.
 * 2. An Escape pressed inside the chip (`handleRootKeyDown`) goes through the
 *    same "behind a viewport layer" check as the document path: behind one, it
 *    neither closes the reason nor claims the press.
 * 3. The inline reason (phone) gets that check and the mark too.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';
import { FileViewer } from '@/components/worktree/FileViewer';
import { MarkdownEditor } from '@/components/worktree/MarkdownEditor';
import { VerificationStatusChip } from '@/components/worktree/VerificationStatusChip';
import { ActionBarItemsOverflow } from '@/components/worktree/TerminalSplitContainer';
import { __resetApiReachabilityReporting } from '@/lib/api-client';
import { markEscapeClosedLayer, VIEWPORT_LAYER_ATTRIBUTE } from '@/lib/escape-key';
import { Z_INDEX } from '@/config/z-index';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('highlight.js', () => ({
  default: {
    highlightAuto: (code: string) => ({ value: `<span class="hljs">${code}</span>` }),
    highlight: (code: string) => ({ value: `<span class="hljs">${code}</span>` }),
    getLanguage: () => undefined,
  },
}));

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

function stubFile(path: string, content: string): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      success: true,
      path,
      content,
      extension: path.split('.').pop(),
      worktreePath: '/wt',
    }),
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  __resetApiReachabilityReporting();
  try {
    window.localStorage.clear();
  } catch {
    // jsdom always has it; the editor only persists its maximize flag there.
  }
  stubFile('docs/readme.md', '# Doc\n\ntext');
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** Fires Escape on `target`; true when the press was left unclaimed. */
function pressEscape(target: Element): boolean {
  let unclaimed = true;
  act(() => {
    unclaimed = fireEvent.keyDown(target, { key: 'Escape' });
  });
  return unclaimed;
}

/**
 * A floating layer in front that closes on Escape without claiming it (like
 * the second row's "…" panel). Capture phase, so it runs before everyone else.
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

function reason(): HTMLElement | null {
  return screen.queryByTestId('verification-chip-reason-popover');
}

function reasonToggle(): HTMLElement {
  return screen.getByTestId('verification-chip-reason-toggle');
}

function openReason(): void {
  fireEvent.click(reasonToggle());
  expect(reason()).not.toBeNull();
}

function Chip({ popover }: { popover: 'inline' | 'floating' }) {
  return <VerificationStatusChip task={null} latestRun={null} onOpen={vi.fn()} popover={popover} />;
}

// ---------------------------------------------------------------------------
// 1. FileViewer's fullscreen
// ---------------------------------------------------------------------------

const TS_PATH = 'src/index.ts';
const MD_PATH = 'docs/readme.md';

function viewerFullscreen(): HTMLElement | null {
  return screen.queryByTestId('file-viewer-fullscreen');
}

/** The read-only screen (a `.ts` is not editable), maximized. */
async function renderFullscreenViewer(extra?: React.ReactNode): Promise<void> {
  stubFile(TS_PATH, 'const x = 1;\n');
  render(
    <>
      {extra}
      <FileViewer isOpen onClose={vi.fn()} worktreeId="wt-3691" filePath={TS_PATH} />
    </>
  );
  fireEvent.click(await screen.findByRole('button', { name: /^fullscreen$/i }));
  expect(viewerFullscreen()).not.toBeNull();
}

describe('[#3691] FileViewer fullscreen (read-only overlay)', () => {
  it('is a viewport layer', async () => {
    await renderFullscreenViewer();
    expect(viewerFullscreen()!.hasAttribute(VIEWPORT_LAYER_ATTRIBUTE)).toBe(true);
  });

  it('stays on the press a layer in front closed on, exits on the next (positive)', async () => {
    await renderFullscreenViewer();
    withFrontLayerClosing(() => pressEscape(document.body));
    expect(viewerFullscreen()).not.toBeNull();

    pressEscape(document.body);
    expect(viewerFullscreen()).toBeNull();
  });

  it('exits on the first Escape with nothing in front (negative control)', async () => {
    await renderFullscreenViewer();
    pressEscape(document.body);
    expect(viewerFullscreen()).toBeNull();
  });

  it('closes the inline reason in front of it first, then itself (positive)', async () => {
    await renderFullscreenViewer(<Chip popover="inline" />);
    openReason();
    viewerFullscreen()!.style.zIndex = String(Z_INDEX.MODAL - 1);

    pressEscape(document.body);
    expect(reason()).toBeNull();
    expect(viewerFullscreen()).not.toBeNull();

    pressEscape(document.body);
    expect(viewerFullscreen()).toBeNull();
  });

  it('closes its own search bar alone, then itself (positive)', async () => {
    await renderFullscreenViewer();
    fireEvent.click(screen.getByRole('button', { name: /search in file/i }));
    const input = await screen.findByPlaceholderText(/.+/);

    pressEscape(input);
    expect(screen.queryByPlaceholderText(/.+/)).toBeNull();
    expect(viewerFullscreen()).not.toBeNull();

    pressEscape(document.body);
    expect(viewerFullscreen()).toBeNull();
  });

  it('exits first over the inline reason behind it, which closes on the next press (positive)', async () => {
    await renderFullscreenViewer(<Chip popover="inline" />);
    openReason();

    pressEscape(document.body);
    expect(viewerFullscreen()).toBeNull();
    expect(reason()).not.toBeNull();

    pressEscape(document.body);
    expect(reason()).toBeNull();
  });

  it('exits first over the "…" panel behind it too', async () => {
    await renderFullscreenViewer(
      <ActionBarItemsOverflow label="More">
        <button type="button" data-testid="folded-item">
          folded
        </button>
      </ActionBarItemsOverflow>
    );
    fireEvent.click(screen.getByTestId('split-action-bar-items-overflow'));
    const item = screen.getByTestId('folded-item');
    await waitFor(() => expect(document.activeElement).toBe(item));

    pressEscape(item);
    expect(viewerFullscreen()).toBeNull();
    expect(screen.queryByTestId('split-action-bar-items-panel')).not.toBeNull();

    pressEscape(item);
    expect(screen.queryByTestId('split-action-bar-items-panel')).toBeNull();
  });
});

function markdownScreen(): HTMLElement {
  return screen.getByTestId('markdown-file-screen');
}

function immersive(): boolean {
  return screen.queryByTestId('markdown-file-immersive-controls') !== null;
}

async function renderUnifiedScreen(
  extra?: React.ReactNode,
  { maximize = true }: { maximize?: boolean } = {}
): Promise<{ onClose: ReturnType<typeof vi.fn> }> {
  const onClose = vi.fn();
  render(
    <>
      {extra}
      <FileViewer isOpen onClose={onClose} worktreeId="wt-3691" filePath={MD_PATH} />
    </>
  );
  await screen.findByTestId('markdown-file-screen');
  await screen.findByTestId('markdown-editor-textarea');
  if (maximize) {
    fireEvent.click(screen.getByTestId('markdown-file-maximize'));
    expect(immersive()).toBe(true);
  }
  return { onClose };
}

describe('[#3691] FileViewer unified screen Escape ladder', () => {
  it('is a viewport layer', async () => {
    await renderUnifiedScreen(undefined, { maximize: false });
    expect(markdownScreen().hasAttribute(VIEWPORT_LAYER_ATTRIBUTE)).toBe(true);
  });

  it('stays maximized on the press a layer in front closed on, exits on the next (positive)', async () => {
    const { onClose } = await renderUnifiedScreen();
    withFrontLayerClosing(() => pressEscape(document.body));
    expect(immersive()).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    pressEscape(document.body);
    expect(immersive()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close on the press a layer in front closed on (positive)', async () => {
    const { onClose } = await renderUnifiedScreen(undefined, { maximize: false });
    withFrontLayerClosing(() => pressEscape(document.body));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('un-maximizes on the first Escape with nothing in front, then closes (negative control)', async () => {
    const { onClose } = await renderUnifiedScreen();
    pressEscape(document.body);
    expect(immersive()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    pressEscape(document.body);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('closes the inline reason in front of it alone (positive)', async () => {
    const { onClose } = await renderUnifiedScreen(<Chip popover="inline" />);
    openReason();
    markdownScreen().style.zIndex = String(Z_INDEX.MODAL - 1);

    pressEscape(document.body);
    expect(reason()).toBeNull();
    expect(immersive()).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('un-maximizes first over the inline reason behind it', async () => {
    await renderUnifiedScreen(<Chip popover="inline" />);
    openReason();

    pressEscape(document.body);
    expect(immersive()).toBe(false);
    expect(reason()).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. An Escape pressed inside the chip
// ---------------------------------------------------------------------------

function editorMaximized(): boolean {
  return screen.queryByTestId('maximize-hint') !== null;
}

async function renderChipAndMaximizedEditor(popover: 'inline' | 'floating'): Promise<void> {
  render(
    <>
      <Chip popover={popover} />
      <MarkdownEditor worktreeId="wt-3691" filePath={MD_PATH} />
    </>
  );
  await waitFor(() => expect(screen.getByTestId('markdown-editor-textarea')).toBeInTheDocument());
  openReason();
  fireEvent.click(screen.getByTestId('maximize-button'));
  await waitFor(() => expect(editorMaximized()).toBe(true));
}

describe('[#3691] Escape inside the chip with the reason behind a viewport layer', () => {
  it('leaves the press to the maximized editor in front, unclaimed (positive, floating)', async () => {
    await renderChipAndMaximizedEditor('floating');

    pressEscape(reasonToggle());
    await waitFor(() => expect(editorMaximized()).toBe(false));
    expect(reason()).not.toBeNull();

    expect(pressEscape(reasonToggle())).toBe(false);
    expect(reason()).toBeNull();
  });

  it('leaves the press to the fullscreen file in front (positive, inline)', async () => {
    await renderFullscreenViewer(<Chip popover="inline" />);
    openReason();

    pressEscape(reasonToggle());
    expect(viewerFullscreen()).toBeNull();
    expect(reason()).not.toBeNull();
  });

  it('closes the reason and claims the press with no layer in front (negative control)', () => {
    render(<Chip popover="floating" />);
    openReason();
    expect(pressEscape(reasonToggle())).toBe(false);
    expect(reason()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. The inline reason (phone)
// ---------------------------------------------------------------------------

describe('[#3691] the inline reason under a CSS-maximized editor', () => {
  it('closes one layer per Escape from outside the chip (positive)', async () => {
    await renderChipAndMaximizedEditor('inline');

    pressEscape(document.body);
    await waitFor(() => expect(editorMaximized()).toBe(false));
    expect(reason()).not.toBeNull();

    pressEscape(document.body);
    expect(reason()).toBeNull();
  });

  it('closes on Escape with no maximize (negative control)', () => {
    render(<Chip popover="inline" />);
    openReason();
    pressEscape(document.body);
    expect(reason()).toBeNull();
  });
});
