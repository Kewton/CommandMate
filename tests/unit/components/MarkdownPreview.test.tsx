/**
 * Unit Tests for MarkdownPreview Component
 *
 * Issue #505: Link handling in markdown preview
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MarkdownPreview } from '@/components/worktree/MarkdownPreview';

// Mock MermaidCodeBlock to avoid complex dependency
vi.mock('@/components/worktree/MermaidCodeBlock', () => ({
  MermaidCodeBlock: ({ children }: { children?: React.ReactNode }) => (
    <pre data-testid="mermaid-block">{children}</pre>
  ),
}));

describe('MarkdownPreview', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should render markdown content', () => {
    render(<MarkdownPreview content="# Hello World" />);
    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });

  describe('link handling', () => {
    it('should call onOpenFile for relative path links', () => {
      const onOpenFile = vi.fn();
      render(
        <MarkdownPreview
          content="[link](./readme.md)"
          onOpenFile={onOpenFile}
          currentFilePath="docs/index.md"
        />,
      );

      const link = screen.getByText('link');
      fireEvent.click(link);

      expect(onOpenFile).toHaveBeenCalledWith('docs/readme.md');
    });

    it('should call window.open for external links', () => {
      const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
      render(
        <MarkdownPreview
          content="[external](https://example.com)"
          onOpenFile={vi.fn()}
          currentFilePath="docs/index.md"
        />,
      );

      const link = screen.getByText('external');
      fireEvent.click(link);

      expect(windowOpen).toHaveBeenCalledWith(
        'https://example.com',
        '_blank',
        'noopener,noreferrer',
      );
    });

    it('should not call onOpenFile for anchor links', () => {
      const onOpenFile = vi.fn();
      render(
        <MarkdownPreview
          content="[anchor](#section)"
          onOpenFile={onOpenFile}
          currentFilePath="docs/index.md"
        />,
      );

      const link = screen.getByText('anchor');
      fireEvent.click(link);

      expect(onOpenFile).not.toHaveBeenCalled();
    });

    it('should render links without onOpenFile (backward compatible)', () => {
      render(<MarkdownPreview content="[link](./readme.md)" />);
      expect(screen.getByText('link')).toBeInTheDocument();
    });

    it('should preserve href on relative path links (rehype-sanitize allowlist)', () => {
      render(
        <MarkdownPreview
          content="[link](./readme.md)"
          onOpenFile={vi.fn()}
          currentFilePath="docs/index.md"
        />,
      );

      const link = screen.getByText('link');
      expect(link.tagName).toBe('A');
      expect(link.getAttribute('href')).toBe('./readme.md');
    });
  });
});
