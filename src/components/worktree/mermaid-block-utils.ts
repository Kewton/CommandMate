/**
 * Pure helpers shared by every Markdown surface that draws ```mermaid fences
 * (file preview, chat, History — Issue #100 / #3503).
 *
 * Kept free of React components and of mermaid itself, so the renderers and the
 * search highlighters can import them without pulling the diagram runtime in.
 *
 * @module components/worktree/mermaid-block-utils
 */

import React from 'react';

/**
 * Whether a `<code>` className marks a ```mermaid fence.
 *
 * @param className - CSS class name from ReactMarkdown
 */
export function isMermaidLanguage(className?: string): boolean {
  if (!className) return false;
  return className.split(' ').includes('language-mermaid');
}

/**
 * Detects whether a `<pre>`'s child is a mermaid fenced block. react-markdown
 * passes the (unrendered) `<code>` element as the pre's only child; mermaid
 * blocks carry a `language-mermaid` class. Such blocks render a diagram rather
 * than copyable source, so a `pre` renderer must not wrap them with a copy
 * button (Issue #983) — nor with the always-dark code background (Issue #3503).
 */
export function isMermaidPreChild(children: React.ReactNode): boolean {
  const child = React.Children.toArray(children)[0];
  if (!React.isValidElement(child)) return false;
  const className = (child.props as { className?: string }).className;
  return isMermaidLanguage(typeof className === 'string' ? className : undefined);
}
