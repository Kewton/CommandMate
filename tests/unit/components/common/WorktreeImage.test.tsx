/**
 * WorktreeImage, shared by MarkdownPreview and the chat (Issue #3120).
 *
 * The extraction must not change what MarkdownPreview draws: a relative image
 * is fetched on mount through the files API, shows the gray loading text until
 * then, and becomes an <img> with the data URI.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { WorktreeImage } from '@/components/common/WorktreeImage';
import { MarkdownPreview } from '@/components/worktree/MarkdownPreview';

const DATA_URI = 'data:image/png;base64,iVBORw0KGgo=';
const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true, content: DATA_URI }) });
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MarkdownPreview images (unchanged by the extraction)', () => {
  it('fetches a relative image through the files API and shows it', async () => {
    render(<MarkdownPreview content="![図](./img/a.png)" currentFilePath="docs/readme.md" worktreeId="wt1" />);

    expect(screen.getByText('worktree.markdownPreview.loadingImage')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('img', { name: '図' })).toHaveAttribute('src', DATA_URI));
    expect(mockFetch).toHaveBeenCalledWith('/api/worktrees/wt1/files/docs/img/a.png');
    expect(screen.getByRole('img', { name: '図' })).toHaveStyle({ maxWidth: '100%' });
  });

  it('keeps the loading text when the fetch fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
    render(<MarkdownPreview content="![図](a.png)" currentFilePath="readme.md" worktreeId="wt1" />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(screen.getByText('worktree.markdownPreview.loadingImage')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('renders an external image directly, as before', () => {
    render(<MarkdownPreview content="![外](https://example.com/a.png)" currentFilePath="readme.md" worktreeId="wt1" />);
    expect(screen.getByRole('img', { name: '外' })).toHaveAttribute('src', 'https://example.com/a.png');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('WorktreeImage options', () => {
  it('without IntersectionObserver, a lazy image loads immediately', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    render(<WorktreeImage apiUrl="/api/worktrees/wt1/files/a.png" alt="a" lazy />);
    await waitFor(() => expect(screen.getByRole('img', { name: 'a' })).toBeInTheDocument());
  });

  it('draws the error fallback when given one', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    render(
      <WorktreeImage
        apiUrl="/api/worktrees/wt1/files/a.png"
        alt="a"
        errorFallback={<span>failed</span>}
      />,
    );
    await waitFor(() => expect(screen.getByText('failed')).toBeInTheDocument());
  });
});
