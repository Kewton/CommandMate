/**
 * Unit Tests for editing non-markdown files on the mobile file screen
 * (Issue #2507)
 *
 * Before this change the unified full-screen file surface was gated on
 * `content.extension === 'md'`, so `.txt` / `.yaml` / `.yml` were viewable but
 * not editable on mobile even though the PC file panel routes them to an editor
 * off the very same `isEditableExtension()` list. These tests pin the new
 * routing and the four boundaries around it:
 *
 * - every editable extension opens the unified screen, in the editor, and saves
 * - `.md` alone keeps the viewer/editor switch (nothing else has a preview)
 * - `.html` / `.htm` deliberately stay on `HtmlPreviewMobile` (the #2507
 *   decision — see the `isUnifiedEditable` comment in FileViewer)
 * - read-only files (Issue #2505) get no editor at all, on any extension
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

let mockFetch: ReturnType<typeof vi.fn>;

/** Stub GET for one file; PUT responses are stubbed per-test by re-mocking. */
function stubFile(filePath: string, content: string, overrides: Record<string, unknown> = {}): void {
  mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      path: filePath,
      content,
      extension: filePath.split('.').pop(),
      worktreePath: '/wt',
      ...overrides,
    }),
  });
  global.fetch = mockFetch as unknown as typeof fetch;
}

const baseProps = { isOpen: true, worktreeId: 'test-wt' };

function renderViewer(filePath: string, props: Partial<React.ComponentProps<typeof FileViewer>> = {}) {
  const onClose = vi.fn();
  const utils = render(<FileViewer {...baseProps} filePath={filePath} onClose={onClose} {...props} />);
  return { ...utils, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  confirmMock.mockResolvedValue(true);
  copyToClipboardMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ----------------------------------------------------------------------------
// Editable, non-markdown extensions
// ----------------------------------------------------------------------------

describe('FileViewer editable non-markdown files (Issue #2507)', () => {
  const CASES: Array<{ path: string; content: string }> = [
    { path: 'notes/todo.txt', content: 'first line\nsecond line\n' },
    { path: '.commandmate/verify.yaml', content: 'gates:\n  - lint\n' },
    { path: 'ci/config.yml', content: 'jobs:\n  build: {}\n' },
  ];

  for (const { path, content } of CASES) {
    it(`opens ${path} on the unified screen, straight into the editor`, async () => {
      stubFile(path, content);
      renderViewer(path);

      await screen.findByTestId('markdown-file-screen');
      const textarea = (await screen.findByTestId(
        'markdown-editor-textarea',
      )) as HTMLTextAreaElement;

      // Editor pane is the visible one; there is no preview to fall back to.
      expect(screen.getByTestId('markdown-file-editor').className).not.toContain('hidden');
      expect(textarea.value).toBe(content);
      expect(screen.queryByTestId('markdown-file-preview')).not.toBeInTheDocument();
      // Seeded from the host's payload: no second round-trip for the editor.
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it(`hides the viewer/editor switch for ${path}`, async () => {
      stubFile(path, content);
      renderViewer(path);

      await screen.findByTestId('markdown-file-screen');
      expect(screen.queryByTestId('markdown-file-mode-switch')).not.toBeInTheDocument();
      expect(screen.queryByTestId('markdown-file-mode-viewer')).not.toBeInTheDocument();
      expect(screen.queryByTestId('markdown-file-mode-editor')).not.toBeInTheDocument();
    });
  }

  it('saves an edited .txt through PUT and reports the path back', async () => {
    const path = 'notes/todo.txt';
    stubFile(path, 'first line\n');
    const onFileSaved = vi.fn();
    renderViewer(path, { onFileSaved });

    await screen.findByTestId('markdown-file-screen');
    const textarea = await screen.findByTestId('markdown-editor-textarea');

    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    fireEvent.change(textarea, { target: { value: 'first line\nedited on the phone\n' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('save-button'));
    });

    await waitFor(() => expect(onFileSaved).toHaveBeenCalledWith(path));
    const putCall = mockFetch.mock.calls.find((call) => call[1]?.method === 'PUT');
    expect(putCall).toBeDefined();
    expect(String(putCall?.[0])).toContain('/api/worktrees/test-wt/files/notes/todo.txt');
    expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
      content: 'first line\nedited on the phone\n',
    });
  });

  it('keeps maximize, close and the action sheet working for a .yaml', async () => {
    const path = 'config.yaml';
    stubFile(path, 'key: value\n');
    const { onClose } = renderViewer(path);

    await screen.findByTestId('markdown-file-screen');
    await screen.findByTestId('markdown-editor-textarea');

    // Fullscreen collapses the toolbar to the immersive cluster...
    fireEvent.click(screen.getByTestId('markdown-file-maximize'));
    expect(screen.getByTestId('markdown-file-immersive-controls')).toBeInTheDocument();
    // ...and the editor stays on screen while maximized.
    expect(screen.getByTestId('markdown-file-editor').className).not.toContain('hidden');

    // Restore, then check the action sheet still offers all four actions.
    fireEvent.click(screen.getByTestId('markdown-file-maximize'));
    expect(screen.queryByTestId('markdown-file-immersive-controls')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('markdown-file-actions-trigger'));
    await screen.findByTestId('mobile-file-actions-sheet');
    expect(screen.getByTestId('file-actions-sheet-search')).toBeInTheDocument();
    expect(screen.getByTestId('file-actions-sheet-copy-path')).toBeInTheDocument();
    const download = screen.getByTestId('download-file-button');
    expect(download).toHaveAttribute('href', expect.stringContaining('download=1'));
    expect(download).toHaveAttribute('download', 'config.yaml');

    await act(async () => {
      fireEvent.click(screen.getByTestId('file-actions-sheet-copy-content'));
    });
    expect(copyToClipboardMock).toHaveBeenCalledWith('key: value\n');

    await act(async () => {
      fireEvent.click(screen.getByTestId('markdown-file-close'));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('confirms before closing a .txt with unsaved changes and honours a cancel', async () => {
    confirmMock.mockResolvedValue(false);
    const path = 'notes/todo.txt';
    stubFile(path, 'first line\n');
    const { onClose } = renderViewer(path);

    await screen.findByTestId('markdown-file-screen');
    fireEvent.change(await screen.findByTestId('markdown-editor-textarea'), {
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

  it('shows the line-anchored source while searching, then returns to the editor', async () => {
    const path = 'notes/todo.txt';
    stubFile(path, 'alpha\nbravo\ncharlie\n');
    renderViewer(path);

    await screen.findByTestId('markdown-file-screen');
    await screen.findByTestId('markdown-editor-textarea');
    expect(document.querySelector('[data-line]')).toBeNull();

    fireEvent.click(screen.getByTestId('markdown-file-actions-trigger'));
    fireEvent.click(await screen.findByTestId('file-actions-sheet-search'));

    // Search needs line anchors to scroll matches into view, so the source
    // table takes over even though this file has no rendered preview.
    await screen.findByPlaceholderText('Search...');
    expect(document.querySelector('[data-line]')).not.toBeNull();
    expect(screen.getByTestId('markdown-file-editor').className).toContain('hidden');

    fireEvent.click(screen.getByLabelText('Close search'));
    await waitFor(() => {
      expect(screen.getByTestId('markdown-file-editor').className).not.toContain('hidden');
    });
  });
});

// ----------------------------------------------------------------------------
// `.md` is unchanged
// ----------------------------------------------------------------------------

describe('FileViewer markdown keeps both modes (Issue #2507)', () => {
  it('still offers the viewer/editor switch and opens on the preview', async () => {
    stubFile('docs/readme.md', '# Heading\n\nBody.\n');
    renderViewer('docs/readme.md');

    await screen.findByTestId('markdown-file-screen');
    await screen.findByTestId('markdown-editor-textarea');

    expect(screen.getByTestId('markdown-file-mode-switch')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('markdown-file-preview').querySelector('h1')?.textContent).toBe(
        'Heading',
      );
    });
    expect(screen.getByTestId('markdown-file-editor').className).toContain('hidden');

    fireEvent.click(screen.getByTestId('markdown-file-mode-editor'));
    expect(screen.getByTestId('markdown-file-editor').className).not.toContain('hidden');
  });
});

// ----------------------------------------------------------------------------
// `.html` decision: stays on HtmlPreviewMobile
// ----------------------------------------------------------------------------

describe('FileViewer HTML stays on the mobile preview (Issue #2507 decision)', () => {
  for (const path of ['page.html', 'page.htm']) {
    it(`routes ${path} to HtmlPreviewMobile, not the editor`, async () => {
      stubFile(path, '<html><body><p>hi</p></body></html>', { isHtml: true });
      renderViewer(path);

      // The HTML surface owns its Source/Preview tabs and the sandbox trust
      // selector; nesting it under a second mode switch is what this decision
      // avoids. Editing HTML remains a PC affordance (`HtmlPreview`).
      await screen.findByTestId('html-preview-mobile');
      expect(screen.queryByTestId('markdown-file-screen')).not.toBeInTheDocument();
      expect(screen.queryByTestId('markdown-editor-textarea')).not.toBeInTheDocument();
      expect(screen.getByTestId('modal-panel')).toBeInTheDocument();
    });
  }
});

// ----------------------------------------------------------------------------
// Read-only files (Issue #2505) never get an editor
// ----------------------------------------------------------------------------

describe('FileViewer read-only files get no editor (Issue #2505 / #2507)', () => {
  const READ_ONLY = {
    readOnly: true,
    readOnlyReason: {
      code: 'FILE_TOO_LARGE',
      message: 'Opened read-only: this file is 3.0MB, over the 2.0MB limit for editing.',
      limitBytes: 2 * 1024 * 1024,
      sizeBytes: 3 * 1024 * 1024,
    },
  };

  for (const path of ['huge.txt', 'huge.md', 'huge.yaml']) {
    it(`keeps ${path} on the read-only modal with the reason visible`, async () => {
      stubFile(path, 'line one\nline two\n', READ_ONLY);
      renderViewer(path);

      const notice = await screen.findByTestId('file-read-only-notice');
      expect(notice).toHaveAttribute('data-reason-code', 'FILE_TOO_LARGE');
      expect(notice.textContent).toContain('over the 2.0MB limit');

      expect(screen.queryByTestId('markdown-file-screen')).not.toBeInTheDocument();
      expect(screen.queryByTestId('markdown-editor-textarea')).not.toBeInTheDocument();
      expect(screen.queryByTestId('save-button')).not.toBeInTheDocument();
      // Still fully viewable: the highlighted source table and download stay.
      expect(document.querySelector('[data-line]')).not.toBeNull();
      expect(screen.getByTestId('download-file-button')).toBeInTheDocument();
    });
  }

  it('shows no read-only notice for a normal editable file', async () => {
    stubFile('notes/todo.txt', 'fine\n');
    renderViewer('notes/todo.txt');

    await screen.findByTestId('markdown-file-screen');
    expect(screen.queryByTestId('file-read-only-notice')).not.toBeInTheDocument();
  });
});

// ----------------------------------------------------------------------------
// Non-editable extensions are untouched
// ----------------------------------------------------------------------------

describe('FileViewer non-editable files are unaffected (Issue #2507)', () => {
  it('treats an upper-case .MD like .md (the API preserves on-disk case)', async () => {
    stubFile('docs/NOTES.MD', '# Shouty\n');
    renderViewer('docs/NOTES.MD');

    await screen.findByTestId('markdown-file-screen');
    expect(screen.getByTestId('markdown-file-mode-switch')).toBeInTheDocument();
    // `previewText` is populated by an effect and the markdown pipeline renders
    // asynchronously, so poll rather than assert on the first paint.
    await waitFor(() => {
      expect(screen.getByTestId('markdown-file-preview').querySelector('h1')?.textContent).toBe(
        'Shouty',
      );
    });
  });

  it('keeps a .ts file on the modal source table', async () => {
    stubFile('src/app.ts', 'const x = 1;\n');
    renderViewer('src/app.ts');

    await screen.findByTestId('copy-content-button');
    expect(screen.queryByTestId('markdown-file-screen')).not.toBeInTheDocument();
    expect(screen.getByTestId('modal-panel')).toBeInTheDocument();
    expect(document.querySelector('[data-line]')).not.toBeNull();
  });
});
