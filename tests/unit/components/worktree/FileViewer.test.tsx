/**
 * Unit Tests for FileViewer download link (Issue #1024)
 *
 * Verifies the download affordance:
 * - a dedicated `data-testid="download-file-button"` anchor exists
 * - href points at `?download=1` and is `encodePathForUrl`-encoded
 * - it is reachable in preview-success, error, and oversize states
 * - it is NOT gated on `canCopy` (present for image files with no copy button)
 * - it does not collide with the existing `copy-content-button`
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { FileViewer } from '@/components/worktree/FileViewer';
import { encodePathForUrl } from '@/lib/url-path-encoder';

// ----------------------------------------------------------------------------
// fetch stubs
// ----------------------------------------------------------------------------

function stubFetchTextFile(filePath: string): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      path: filePath,
      content: 'const x = 1;\n',
      extension: filePath.split('.').pop(),
      worktreePath: '/wt',
    }),
  }) as unknown as typeof fetch;
}

function stubFetchImageFile(filePath: string): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      path: filePath,
      content: 'data:image/png;base64,iVBORw0KGgo=',
      extension: 'png',
      worktreePath: '/wt',
      isImage: true,
      mimeType: 'image/png',
    }),
  }) as unknown as typeof fetch;
}

function stubFetchError(code: string, message: string): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: false,
    json: async () => ({ success: false, error: { code, message } }),
  }) as unknown as typeof fetch;
}

const baseProps = {
  isOpen: true,
  onClose: vi.fn(),
  worktreeId: 'test-wt',
};

describe('FileViewer download link (Issue #1024)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders a dedicated download anchor on preview success', async () => {
    const filePath = 'src/components/Foo.tsx';
    stubFetchTextFile(filePath);

    render(<FileViewer {...baseProps} filePath={filePath} />);

    const link = await screen.findByTestId('download-file-button');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('aria-label', 'Download file');
    expect(link).toHaveAttribute('title', 'Download');
    expect(link).toHaveAttribute('download');
  });

  it('builds the href with ?download=1 and encodePathForUrl-encoded path', async () => {
    const filePath = 'dir with space/レポート.txt';
    stubFetchTextFile(filePath);

    render(<FileViewer {...baseProps} filePath={filePath} />);

    const link = await screen.findByTestId('download-file-button');
    const expectedHref = `/api/worktrees/test-wt/files/${encodePathForUrl(filePath)}?download=1`;
    expect(link).toHaveAttribute('href', expectedHref);
    // Encoded, not raw (space/non-ASCII must be percent-encoded).
    expect(link.getAttribute('href')).not.toContain(' ');
    expect(link.getAttribute('href')).toContain('%20');
    expect(link.getAttribute('href')).toContain('download=1');
  });

  it('is reachable in the error state (e.g. read failure)', async () => {
    const filePath = 'broken.bin';
    stubFetchError('INTERNAL_ERROR', 'Failed to read file');

    render(<FileViewer {...baseProps} filePath={filePath} />);

    // Error message shows, and the download link is still present.
    await screen.findByText('Failed to read file');
    const link = screen.getByTestId('download-file-button');
    expect(link).toHaveAttribute(
      'href',
      `/api/worktrees/test-wt/files/${encodePathForUrl(filePath)}?download=1`,
    );
  });

  it('is reachable in the oversize (FILE_TOO_LARGE) state', async () => {
    const filePath = 'huge.txt';
    stubFetchError('FILE_TOO_LARGE', 'Editable file exceeds 2MB limit');

    render(<FileViewer {...baseProps} filePath={filePath} />);

    await screen.findByText(/exceeds 2MB/);
    expect(screen.getByTestId('download-file-button')).toBeInTheDocument();
  });

  it('is NOT gated on canCopy: present for images (no copy-content-button)', async () => {
    const filePath = 'assets/pic.png';
    stubFetchImageFile(filePath);

    render(<FileViewer {...baseProps} filePath={filePath} />);

    const link = await screen.findByTestId('download-file-button');
    expect(link).toBeInTheDocument();
    // Image content is not copyable, so the copy button must be absent...
    expect(screen.queryByTestId('copy-content-button')).not.toBeInTheDocument();
    // ...but the download affordance is still there and does not collide.
    expect(link.getAttribute('data-testid')).toBe('download-file-button');
  });

  it('coexists with the copy-content-button for text files (no id collision)', async () => {
    const filePath = 'notes.txt';
    stubFetchTextFile(filePath);

    render(<FileViewer {...baseProps} filePath={filePath} />);

    await screen.findByTestId('download-file-button');
    expect(screen.getByTestId('copy-content-button')).toBeInTheDocument();
    // Exactly one of each — no duplicate render.
    expect(screen.getAllByTestId('download-file-button')).toHaveLength(1);
  });
});
