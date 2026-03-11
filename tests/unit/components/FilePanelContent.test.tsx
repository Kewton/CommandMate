/**
 * Unit Tests for FilePanelContent Component
 *
 * Issue #438: File panel content display with auto-fetch, syntax highlighting,
 * image/video viewers, and MARP preview support.
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FilePanelContent } from '@/components/worktree/FilePanelContent';
import type { FileTab } from '@/hooks/useFileTabs';
import type { FileContent } from '@/types/models';

// Mock ImageViewer
vi.mock('@/components/worktree/ImageViewer', () => ({
  ImageViewer: ({ src, alt }: { src: string; alt: string }) => (
    <div data-testid="image-viewer" data-src={src} data-alt={alt} />
  ),
}));

// Mock VideoViewer
vi.mock('@/components/worktree/VideoViewer', () => ({
  VideoViewer: ({ src }: { src: string }) => (
    <div data-testid="video-viewer" data-src={src} />
  ),
}));

// Mock highlight.js
vi.mock('highlight.js', () => ({
  default: {
    highlightAuto: (code: string) => ({ value: `<span class="hljs">${code}</span>` }),
  },
}));

// ============================================================================
// Test Fixtures
// ============================================================================

function createTab(overrides: Partial<FileTab> = {}): FileTab {
  return {
    path: 'src/index.ts',
    name: 'index.ts',
    content: null,
    loading: false,
    error: null,
    isDirty: false,
    ...overrides,
  };
}

function createContent(overrides: Partial<FileContent> = {}): FileContent {
  return {
    path: 'src/index.ts',
    content: 'const x = 1;',
    extension: 'ts',
    worktreePath: '/repo',
    ...overrides,
  };
}

describe('FilePanelContent', () => {
  const defaultProps = {
    worktreeId: 'test-wt',
    onLoadContent: vi.fn(),
    onLoadError: vi.fn(),
    onSetLoading: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  describe('loading state', () => {
    it('should show spinner when tab is loading', () => {
      const tab = createTab({ loading: true });
      render(<FilePanelContent tab={tab} {...defaultProps} />);

      expect(screen.getByText('Loading file...')).toBeInTheDocument();
    });
  });

  describe('error state', () => {
    it('should show error message when tab has error', () => {
      const tab = createTab({ error: 'File not found' });
      render(<FilePanelContent tab={tab} {...defaultProps} />);

      expect(screen.getByText('File not found')).toBeInTheDocument();
    });
  });

  describe('content rendering', () => {
    it('should render ImageViewer for image content', () => {
      const content = createContent({
        isImage: true,
        content: 'data:image/png;base64,abc',
        mimeType: 'image/png',
        path: 'image.png',
        extension: 'png',
      });
      const tab = createTab({ content, path: 'image.png', name: 'image.png' });
      render(<FilePanelContent tab={tab} {...defaultProps} />);

      expect(screen.getByTestId('image-viewer')).toBeInTheDocument();
    });

    it('should render VideoViewer for video content', () => {
      const content = createContent({
        isVideo: true,
        content: 'data:video/mp4;base64,abc',
        mimeType: 'video/mp4',
        path: 'video.mp4',
        extension: 'mp4',
      });
      const tab = createTab({ content, path: 'video.mp4', name: 'video.mp4' });
      render(<FilePanelContent tab={tab} {...defaultProps} />);

      expect(screen.getByTestId('video-viewer')).toBeInTheDocument();
    });

    it('should render syntax-highlighted code for text content', () => {
      const content = createContent({
        content: 'const x = 1;',
        extension: 'ts',
      });
      const tab = createTab({ content });
      render(<FilePanelContent tab={tab} {...defaultProps} />);

      // The code should be rendered with highlight.js output
      const codeElement = screen.getByTestId('file-content-code');
      expect(codeElement).toBeInTheDocument();
    });

    it('should render markdown editor for .md files', () => {
      const content = createContent({
        content: '# Hello World',
        extension: 'md',
        path: 'README.md',
      });
      const tab = createTab({ content, path: 'README.md', name: 'README.md' });
      render(
        <FilePanelContent
          tab={tab}
          {...defaultProps}
        />,
      );

      // MarkdownEditor is dynamically imported; the loading placeholder should appear
      // or the component renders. Either way, the maximize button should be present.
      expect(document.querySelector('button[aria-label="Maximize"]')).toBeInTheDocument();
    });
  });

  describe('auto-fetch', () => {
    it('should fetch content when tab has no content, is not loading, and has no error', async () => {
      const mockContent = createContent();
      const mockResponse = {
        ok: true,
        json: () => Promise.resolve(mockContent),
      };
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      const tab = createTab({ content: null, loading: false, error: null });
      render(<FilePanelContent tab={tab} {...defaultProps} />);

      await waitFor(() => {
        expect(defaultProps.onSetLoading).toHaveBeenCalledWith('src/index.ts', true);
      });

      await waitFor(() => {
        expect(defaultProps.onLoadContent).toHaveBeenCalledWith('src/index.ts', mockContent);
      });
    });

    it('should call onLoadError when fetch fails', async () => {
      const mockResponse = {
        ok: false,
        json: () => Promise.resolve({ error: 'Not found' }),
      };
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      const tab = createTab({ content: null, loading: false, error: null });
      render(<FilePanelContent tab={tab} {...defaultProps} />);

      await waitFor(() => {
        expect(defaultProps.onLoadError).toHaveBeenCalledWith('src/index.ts', 'Not found');
      });
    });

    it('should encode file path in fetch URL', async () => {
      const mockContent = createContent({
        path: 'dir/My File #1.ts',
      });
      const mockResponse = {
        ok: true,
        json: () => Promise.resolve(mockContent),
      };
      const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValue(mockResponse);

      const tab = createTab({
        path: 'dir/My File #1.ts',
        name: 'My File #1.ts',
        content: null,
        loading: false,
        error: null,
      });
      render(<FilePanelContent tab={tab} {...defaultProps} />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/worktrees/test-wt/files/dir/My%20File%20%231.ts',
        );
      });
    });

    it('should not fetch when content is already loaded', () => {
      const content = createContent();
      const tab = createTab({ content });
      render(<FilePanelContent tab={tab} {...defaultProps} />);

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should not fetch when tab is loading', () => {
      const tab = createTab({ loading: true });
      render(<FilePanelContent tab={tab} {...defaultProps} />);

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should not fetch when tab has error', () => {
      const tab = createTab({ error: 'Some error' });
      render(<FilePanelContent tab={tab} {...defaultProps} />);

      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('MARP state', () => {
    it('should clear stale MARP slides when content is no longer MARP', async () => {
      const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ slides: ['<html><body><section>Slide</section></body></html>'] }),
      });

      const marpContent = createContent({
        extension: 'md',
        path: 'slides.md',
        content: '---\nmarp: true\n---\n# Slide',
      });
      const nonMarpContent = createContent({
        extension: 'md',
        path: 'notes.md',
        content: '# Plain markdown',
      });

      const { rerender } = render(
        <FilePanelContent
          tab={createTab({ path: 'slides.md', name: 'slides.md', content: marpContent })}
          {...defaultProps}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('marp-preview')).toBeInTheDocument();
      });

      rerender(
        <FilePanelContent
          tab={createTab({ path: 'notes.md', name: 'notes.md', content: nonMarpContent })}
          {...defaultProps}
        />,
      );

      await waitFor(() => {
        expect(screen.queryByTestId('marp-preview')).not.toBeInTheDocument();
      });
    });
  });
});
