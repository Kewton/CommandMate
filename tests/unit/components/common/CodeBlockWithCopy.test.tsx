/**
 * CodeBlockWithCopy Component Tests (Issue #981)
 *
 * Covers:
 * - extractCodeText: plain text extraction from React node trees (the shape
 *   rehype-highlight produces) and primitive/edge inputs
 * - Wrapper rendering: relative group container, span vs div tag
 * - Copy button presence + copying the extracted plain text
 * - No button rendered for empty / whitespace-only code blocks
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CodeBlockWithCopy, extractCodeText } from '@/components/common/CodeBlockWithCopy';

const { mockCopyToClipboard } = vi.hoisted(() => ({
  mockCopyToClipboard: vi.fn(),
}));

vi.mock('@/lib/clipboard-utils', () => ({
  copyToClipboard: mockCopyToClipboard,
}));

describe('extractCodeText', () => {
  it('returns a plain string unchanged', () => {
    expect(extractCodeText('const x = 1;')).toBe('const x = 1;');
  });

  it('stringifies numbers', () => {
    expect(extractCodeText(42)).toBe('42');
  });

  it('joins arrays of strings', () => {
    expect(extractCodeText(['graph TD', '\n', 'A-->B'])).toBe('graph TD\nA-->B');
  });

  it('returns empty string for null / undefined / boolean', () => {
    expect(extractCodeText(null)).toBe('');
    expect(extractCodeText(undefined)).toBe('');
    expect(extractCodeText(true)).toBe('');
    expect(extractCodeText(false)).toBe('');
  });

  it('walks a nested React element tree (highlight.js shape) and concatenates text', () => {
    const tree = (
      <code className="hljs language-js">
        <span className="hljs-keyword">const</span>
        <span> x = </span>
        <span className="hljs-number">1</span>
        <span>;</span>
      </code>
    );
    expect(extractCodeText(tree)).toBe('const x = 1;');
  });
});

describe('CodeBlockWithCopy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCopyToClipboard.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders its children', () => {
    render(
      <CodeBlockWithCopy>
        <pre>
          <code>echo hi</code>
        </pre>
      </CodeBlockWithCopy>,
    );
    expect(screen.getByText('echo hi')).toBeInTheDocument();
  });

  it('renders a copy button for non-empty code blocks', () => {
    render(
      <CodeBlockWithCopy>
        <code>echo hi</code>
      </CodeBlockWithCopy>,
    );
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('wraps content in a relative group container', () => {
    render(
      <CodeBlockWithCopy>
        <code>echo hi</code>
      </CodeBlockWithCopy>,
    );
    const wrapper = screen.getByTestId('code-block-with-copy');
    expect(wrapper).toHaveClass('relative', 'group');
  });

  it('renders a div wrapper by default', () => {
    render(
      <CodeBlockWithCopy>
        <code>echo hi</code>
      </CodeBlockWithCopy>,
    );
    const wrapper = screen.getByTestId('code-block-with-copy');
    expect(wrapper.tagName).toBe('DIV');
  });

  it('renders a span wrapper (block) when as="span"', () => {
    render(
      <CodeBlockWithCopy as="span">
        <code>echo hi</code>
      </CodeBlockWithCopy>,
    );
    const wrapper = screen.getByTestId('code-block-with-copy');
    expect(wrapper.tagName).toBe('SPAN');
    expect(wrapper).toHaveClass('block');
  });

  it('copies the extracted plain text (not highlight markup) when clicked', async () => {
    render(
      <CodeBlockWithCopy>
        <code className="hljs">
          <span className="hljs-keyword">const</span>
          <span> x = 1;</span>
        </code>
      </CodeBlockWithCopy>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(mockCopyToClipboard).toHaveBeenCalledWith('const x = 1;');
  });

  it('does not render a copy button for an empty code block', () => {
    render(
      <CodeBlockWithCopy>
        <code>{''}</code>
      </CodeBlockWithCopy>,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('code-block-with-copy')).not.toBeInTheDocument();
  });

  it('does not render a copy button for a whitespace-only code block', () => {
    render(
      <CodeBlockWithCopy>
        <code>{'   \n  '}</code>
      </CodeBlockWithCopy>,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
