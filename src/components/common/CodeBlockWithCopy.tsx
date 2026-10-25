/**
 * CodeBlockWithCopy Component
 *
 * Issue #981: Wraps a rendered markdown code block (a `<code>` or `<pre>`
 * element) in a `relative group` container and overlays a {@link CopyButton}
 * in the top-right corner.
 *
 * Used by the markdown *file preview* render paths only:
 * - `MermaidCodeBlock` (the `code` renderer used by MarkdownPreview) wraps the
 *   non-mermaid `<code>` element, passing `as="span"` so the wrapper is valid
 *   phrasing content inside the parent `<pre>`.
 * - The file viewer page wraps the `<pre>` element from its `pre` renderer
 *   (default `as="div"`, sitting outside the scrollable `<pre>` so the button
 *   stays pinned while code scrolls horizontally).
 *
 * Chat's `ChatMarkdownBody` wraps its `<pre>` the same way (Issue #3912).
 *
 * The button is hidden by default on pointer/desktop widths and revealed on
 * hover/focus; on small widths, and on any device without hover
 * (`@media (hover: none)`, the `code-copy-button` rule in globals.css), it is
 * always visible. The copy target is the plain text content of the code block
 * (highlight.js decoration markup stripped), extracted via
 * {@link extractCodeText}.
 *
 * [Issue #3912] Only the button is kept out of search and selection
 * (`CopyButton` marks itself); the wrapper and the code are not, so search
 * still reaches the code and a selected range still copies it. The wrapper's
 * `code-block-with-copy` class reserves room on the `<pre>`'s right so a short
 * line never runs under the button.
 *
 * @module components/common/CodeBlockWithCopy
 */

'use client';

import React from 'react';
import { CopyButton } from './CopyButton';

/**
 * Recursively extract the plain text content from a React node tree.
 *
 * rehype-highlight rewrites code children into nested `<span>` elements, so a
 * naive `String(children)` yields `[object Object]`. This walks the tree and
 * concatenates string/number leaves, mirroring DOM `textContent`.
 */
export function extractCodeText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }
  if (typeof node === 'string') {
    return node;
  }
  if (typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractCodeText).join('');
  }
  if (React.isValidElement(node)) {
    return extractCodeText((node.props as { children?: React.ReactNode }).children);
  }
  return '';
}

export interface CodeBlockWithCopyProps {
  /** Rendered code block content (a `<code>` or `<pre>` element) */
  children: React.ReactNode;
  /**
   * Wrapper element tag. Use `'span'` when rendered inside a `<pre>` (phrasing
   * context); `'div'` otherwise. Defaults to `'div'`.
   */
  as?: 'div' | 'span';
  /** Extra classes for the wrapper */
  className?: string;
}

/**
 * Wraps a code block and overlays a copy button. Renders the children
 * unchanged (no button) when the block has no copyable text.
 */
export function CodeBlockWithCopy({
  children,
  as = 'div',
  className = '',
}: CodeBlockWithCopyProps): React.JSX.Element {
  const Wrapper = as;
  const text = extractCodeText(children);

  // Nothing meaningful to copy: render the block as-is without a button.
  if (!text || text.trim().length === 0) {
    return <Wrapper className={className || undefined}>{children}</Wrapper>;
  }

  const wrapperClass =
    `code-block-with-copy relative group ${as === 'span' ? 'block ' : ''}${className}`.trim();

  return (
    <Wrapper className={wrapperClass} data-testid="code-block-with-copy">
      {children}
      <CopyButton
        text={text}
        className="code-copy-button absolute right-2 top-2 z-10 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 focus:opacity-100"
      />
    </Wrapper>
  );
}

export default CodeBlockWithCopy;
