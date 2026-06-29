/**
 * Regression tests for Issue #983 — markdown preview copy button placement.
 *
 * react-markdown v10 dropped the `code` component's `inline` prop, which made
 * every inline `code` span flow through the copy-button wrapper — adding a
 * button and forcing the inline code onto its own line. The copy button is now
 * attached by the `pre` renderer (block code only). These tests exercise the
 * real ReactMarkdown render path (MermaidCodeBlock + CodeBlockWithCopy are NOT
 * mocked) to lock in: inline code = no button / no line break, fenced block =
 * button, mermaid diagram = unchanged (no button).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MarkdownPreview } from '@/components/worktree/MarkdownPreview';

// Hoisted clipboard mock for the copy button.
const { mockCopyToClipboard } = vi.hoisted(() => ({
  mockCopyToClipboard: vi.fn(),
}));

vi.mock('@/lib/clipboard-utils', () => ({
  copyToClipboard: mockCopyToClipboard,
}));

// Render mermaid diagrams synchronously without the real mermaid runtime.
vi.mock('@/components/worktree/MermaidDiagram', () => ({
  MermaidDiagram: ({ code }: { code: string }) => (
    <div data-testid="mermaid-diagram">{code}</div>
  ),
}));

vi.mock('next/dynamic', () => ({
  default: () => {
    const DynamicMermaid = ({ code }: { code: string }) => (
      <div data-testid="mermaid-diagram">{code}</div>
    );
    return DynamicMermaid;
  },
}));

describe('MarkdownPreview copy button placement (Issue #983)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCopyToClipboard.mockResolvedValue(undefined);
  });

  it('does not attach a copy button to inline code', () => {
    render(<MarkdownPreview content={'Here is `inline code` in a sentence.'} />);

    const codeEl = screen.getByText('inline code');
    expect(codeEl.tagName).toBe('CODE');
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('code-block-with-copy')).not.toBeInTheDocument();
  });

  it('does not wrap inline code in the block-level copy wrapper (no line break)', () => {
    render(<MarkdownPreview content={'Text with `code` here.'} />);

    const codeEl = screen.getByText('code');
    // The inline <code> must stay inside its paragraph, not the copy-button
    // block wrapper that forced inline code onto its own line.
    expect(codeEl.closest('[data-testid="code-block-with-copy"]')).toBeNull();
  });

  it('attaches a working copy button to a fenced code block with a language', async () => {
    render(<MarkdownPreview content={'```js\nconst x = 1;\n```'} />);

    const button = screen.getByRole('button', { name: 'Copy' });
    expect(button).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(button);
    });

    expect(mockCopyToClipboard).toHaveBeenCalledWith(
      expect.stringContaining('const x = 1;'),
    );
  });

  it('attaches a copy button to a fenced code block without a language', () => {
    render(<MarkdownPreview content={'```\nplain block\n```'} />);

    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('leaves mermaid diagrams unchanged (no copy button)', () => {
    render(<MarkdownPreview content={'```mermaid\ngraph TD\nA-->B\n```'} />);

    expect(screen.getByTestId('mermaid-diagram')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('code-block-with-copy')).not.toBeInTheDocument();
  });
});
