/**
 * Unit Tests for the unified mobile markdown screen (Issue #1519)
 *
 * Covers the acceptance criteria that are observable in jsdom:
 * - `.md` opens on the RENDERED markdown, not the raw source table
 * - viewer <-> editor is a two-way switch on one screen
 * - switching modes issues NO additional network calls
 * - the action sheet exposes search / copy content / copy path / download
 * - maximize is a permanent one-tap toolbar control and never traps the user
 * - unsaved edits still prompt before closing
 * - non-markdown files keep the previous modal presentation
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { FileViewer } from '@/components/worktree/FileViewer';

// Resolve keys through the real dictionary so a missing/renamed key fails here
// instead of silently echoing back `worktree.<key>` (Issue #1275).
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const confirmMock = vi.fn<(options: { description?: string }) => Promise<boolean>>();
vi.mock('@/components/ui/ConfirmDialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/ConfirmDialog')>();
  return { ...actual, useConfirm: () => confirmMock };
});

const copyToClipboardMock = vi.fn<(text: string) => Promise<void>>();
vi.mock('@/lib/clipboard-utils', () => ({
  copyToClipboard: (text: string) => copyToClipboardMock(text),
}));

const MD_PATH = 'docs/readme.md';
const MD_CONTENT = '# Unified heading\n\nBody line one.\nBody line two.\n';

let mockFetch: ReturnType<typeof vi.fn>;

function stubFile(overrides: Record<string, unknown> = {}): void {
  mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      path: MD_PATH,
      content: MD_CONTENT,
      extension: 'md',
      worktreePath: '/wt',
      ...overrides,
    }),
  });
  global.fetch = mockFetch as unknown as typeof fetch;
}

const baseProps = {
  isOpen: true,
  worktreeId: 'test-wt',
  filePath: MD_PATH,
};

/** Render and wait until the markdown screen (and its embedded editor) is up. */
async function renderMarkdownScreen(props: Partial<React.ComponentProps<typeof FileViewer>> = {}) {
  const onClose = vi.fn();
  const utils = render(<FileViewer {...baseProps} onClose={onClose} {...props} />);
  await screen.findByTestId('markdown-file-screen');
  // The editor is mounted (hidden) from the start so a draft survives toggles.
  await screen.findByTestId('markdown-editor-textarea');
  return { ...utils, onClose };
}

describe('FileViewer unified markdown screen (Issue #1519)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmMock.mockResolvedValue(true);
    copyToClipboardMock.mockResolvedValue(undefined);
    stubFile();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens a markdown file on the rendered preview, not the raw source', async () => {
    await renderMarkdownScreen();

    const preview = screen.getByTestId('markdown-file-preview');
    expect(preview.querySelector('h1')?.textContent).toBe('Unified heading');
    // The line-numbered source table is the search view only.
    expect(preview.querySelector('[data-line]')).toBeNull();
  });

  it('switches viewer <-> editor both ways on the same screen', async () => {
    await renderMarkdownScreen();

    const viewerPane = () => screen.getByTestId('markdown-file-preview').closest('div[class]');
    expect(screen.getByTestId('markdown-file-editor').className).toContain('hidden');

    fireEvent.click(screen.getByTestId('markdown-file-mode-editor'));
    expect(screen.getByTestId('markdown-file-editor').className).not.toContain('hidden');
    expect(screen.getByTestId('markdown-file-mode-editor')).toHaveAttribute('aria-pressed', 'true');

    // ...and back again, which the old pencil-only flow could not do.
    fireEvent.click(screen.getByTestId('markdown-file-mode-viewer'));
    expect(screen.getByTestId('markdown-file-editor').className).toContain('hidden');
    expect(screen.getByTestId('markdown-file-mode-viewer')).toHaveAttribute('aria-pressed', 'true');
    expect(viewerPane()).not.toBeNull();
  });

  it('performs no extra network calls when toggling modes', async () => {
    await renderMarkdownScreen();

    const fileUrlCalls = () =>
      mockFetch.mock.calls.filter((call) => String(call[0]).includes('/files/')).length;

    expect(fileUrlCalls()).toBe(1);

    fireEvent.click(screen.getByTestId('markdown-file-mode-editor'));
    fireEvent.click(screen.getByTestId('markdown-file-mode-viewer'));
    fireEvent.click(screen.getByTestId('markdown-file-mode-editor'));

    await waitFor(() => {
      expect(screen.getByTestId('markdown-file-editor').className).not.toContain('hidden');
    });

    // Still exactly the one fetch from the initial open.
    expect(fileUrlCalls()).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps an unsaved draft when the user visits the viewer and returns', async () => {
    await renderMarkdownScreen();

    fireEvent.click(screen.getByTestId('markdown-file-mode-editor'));
    const textarea = screen.getByTestId('markdown-editor-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '# Draft heading\n' } });

    fireEvent.click(screen.getByTestId('markdown-file-mode-viewer'));
    fireEvent.click(screen.getByTestId('markdown-file-mode-editor'));

    expect((screen.getByTestId('markdown-editor-textarea') as HTMLTextAreaElement).value).toBe(
      '# Draft heading\n',
    );
  });

  it('shows the unsaved draft in the viewer, not the last-fetched text', async () => {
    await renderMarkdownScreen();

    fireEvent.click(screen.getByTestId('markdown-file-mode-editor'));
    fireEvent.change(screen.getByTestId('markdown-editor-textarea'), {
      target: { value: '# Draft heading\n' },
    });
    fireEvent.click(screen.getByTestId('markdown-file-mode-viewer'));

    await waitFor(() => {
      expect(screen.getByTestId('markdown-file-preview').querySelector('h1')?.textContent).toBe(
        'Draft heading',
      );
    });
  });

  it('runs all four actions from the bottom sheet', async () => {
    await renderMarkdownScreen();

    // Sheet is closed until the "more actions" trigger is tapped.
    expect(screen.queryByTestId('mobile-file-actions-sheet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('markdown-file-actions-trigger'));
    await screen.findByTestId('mobile-file-actions-sheet');

    expect(screen.getByTestId('file-actions-sheet-copy-content')).toBeInTheDocument();
    expect(screen.getByTestId('file-actions-sheet-copy-path')).toBeInTheDocument();
    const download = screen.getByTestId('download-file-button');
    expect(download).toHaveAttribute('href', expect.stringContaining('download=1'));
    expect(download).toHaveAttribute('download', 'readme.md');

    await act(async () => {
      fireEvent.click(screen.getByTestId('file-actions-sheet-copy-content'));
    });
    expect(copyToClipboardMock).toHaveBeenCalledWith(MD_CONTENT);

    fireEvent.click(screen.getByTestId('markdown-file-actions-trigger'));
    await act(async () => {
      fireEvent.click(await screen.findByTestId('file-actions-sheet-copy-path'));
    });
    expect(copyToClipboardMock).toHaveBeenCalledWith(MD_PATH);

    // Search: opens the search bar over the highlighted source so matches have
    // line anchors to scroll to.
    fireEvent.click(screen.getByTestId('markdown-file-actions-trigger'));
    fireEvent.click(await screen.findByTestId('file-actions-sheet-search'));
    const searchInput = await screen.findByPlaceholderText('Search...');
    expect(searchInput).toBeInTheDocument();
    expect(document.querySelector('[data-line]')).not.toBeNull();
  });

  it('gives every sheet row and toolbar control a 44px tap target', async () => {
    await renderMarkdownScreen();

    for (const id of [
      'markdown-file-actions-trigger',
      'markdown-file-maximize',
      'markdown-file-close',
      'markdown-file-mode-viewer',
      'markdown-file-mode-editor',
    ]) {
      expect(screen.getByTestId(id).className).toContain('min-h-[44px]');
    }

    fireEvent.click(screen.getByTestId('markdown-file-actions-trigger'));
    await screen.findByTestId('mobile-file-actions-sheet');
    for (const id of [
      'file-actions-sheet-search',
      'file-actions-sheet-copy-content',
      'file-actions-sheet-copy-path',
      'download-file-button',
    ]) {
      expect(screen.getByTestId(id).className).toContain('min-h-[44px]');
    }
  });

  it('maximizes in one tap and still offers a close control while maximized', async () => {
    const { onClose } = await renderMarkdownScreen();

    fireEvent.click(screen.getByTestId('markdown-file-maximize'));
    expect(screen.getByTestId('markdown-file-immersive-controls')).toBeInTheDocument();
    // The toolbar is collapsed, but close survives — no dead end.
    await act(async () => {
      fireEvent.click(screen.getByTestId('markdown-file-close'));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('maximize behaves the same in editor mode', async () => {
    await renderMarkdownScreen();

    fireEvent.click(screen.getByTestId('markdown-file-mode-editor'));
    fireEvent.click(screen.getByTestId('markdown-file-maximize'));
    expect(screen.getByTestId('markdown-file-immersive-controls')).toBeInTheDocument();
    expect(screen.getByTestId('markdown-file-editor').className).not.toContain('hidden');
  });

  it('hides the embedded editor duplicate chrome (view mode + maximize)', async () => {
    await renderMarkdownScreen();

    // The host owns these; the editor toolbar must not offer a second copy.
    expect(screen.queryByTestId('view-mode-split')).not.toBeInTheDocument();
    expect(screen.queryByTestId('maximize-button')).not.toBeInTheDocument();
    // ...but the indent/outdent controls (Issue #1518) stay: touch keyboards
    // have no Tab key, so these are the only way to indent on mobile.
    expect(screen.getByTestId('editor-indent-button')).toBeInTheDocument();
    expect(screen.getByTestId('editor-outdent-button')).toBeInTheDocument();
  });

  it('confirms before closing with unsaved changes and honours a cancel', async () => {
    confirmMock.mockResolvedValue(false);
    const { onClose } = await renderMarkdownScreen();

    fireEvent.click(screen.getByTestId('markdown-file-mode-editor'));
    fireEvent.change(screen.getByTestId('markdown-editor-textarea'), {
      target: { value: 'dirty' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('markdown-file-close'));
    });

    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('unsaved') }),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes without a prompt when there are no unsaved changes', async () => {
    const { onClose } = await renderMarkdownScreen();

    await act(async () => {
      fireEvent.click(screen.getByTestId('markdown-file-close'));
    });

    expect(confirmMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('shows saved content in the viewer after saving from the editor', async () => {
    const onFileSaved = vi.fn();
    await renderMarkdownScreen({ onFileSaved });

    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });

    fireEvent.click(screen.getByTestId('markdown-file-mode-editor'));
    fireEvent.change(screen.getByTestId('markdown-editor-textarea'), {
      target: { value: '# Saved heading\n' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('save-button'));
    });

    await waitFor(() => expect(onFileSaved).toHaveBeenCalledWith(MD_PATH));

    fireEvent.click(screen.getByTestId('markdown-file-mode-viewer'));
    await waitFor(() => {
      expect(screen.getByTestId('markdown-file-preview').querySelector('h1')?.textContent).toBe(
        'Saved heading',
      );
    });
  });
});

describe('FileViewer non-markdown files are unaffected (Issue #1519)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmMock.mockResolvedValue(true);
    copyToClipboardMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps the modal + source table presentation for a text file', async () => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        path: 'src/app.ts',
        content: 'const x = 1;\n',
        extension: 'ts',
        worktreePath: '/wt',
      }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    render(<FileViewer {...baseProps} filePath="src/app.ts" onClose={vi.fn()} />);

    await screen.findByTestId('copy-content-button');
    expect(screen.queryByTestId('markdown-file-screen')).not.toBeInTheDocument();
    expect(screen.getByTestId('modal-panel')).toBeInTheDocument();
    expect(screen.getByTestId('download-file-button')).toBeInTheDocument();
    expect(document.querySelector('[data-line]')).not.toBeNull();
  });

  it('keeps the image viewer path', async () => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        path: 'assets/pic.png',
        content: 'data:image/png;base64,iVBORw0KGgo=',
        extension: 'png',
        worktreePath: '/wt',
        isImage: true,
        mimeType: 'image/png',
      }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    render(<FileViewer {...baseProps} filePath="assets/pic.png" onClose={vi.fn()} />);

    await screen.findByTestId('download-file-button');
    expect(screen.queryByTestId('markdown-file-screen')).not.toBeInTheDocument();
    expect(screen.queryByTestId('copy-content-button')).not.toBeInTheDocument();
  });
});
