/**
 * The `code` / `pre` renderers that turn a ```mermaid fence into a diagram, for
 * the transcript surfaces (chat's `ChatMarkdownBody`, History's
 * `AssistantMarkdown` — Issue #3503).
 *
 * The file preview keeps its own `pre` (it adds a copy button to every other
 * block) but asks the same {@link isMermaidPreChild} and draws the same
 * {@link MermaidCodeBlock}, so all three surfaces share the one judgment and the
 * one diagram frame.
 *
 * Everything that is not a mermaid fence renders exactly as react-markdown's
 * defaults would — same element, same props — so non-mermaid code, its
 * highlighting classes and inline code are untouched.
 *
 * @module components/worktree/mermaid-markdown
 */

'use client';

import React from 'react';
import type { Components } from 'react-markdown';
import { MermaidCodeBlock } from './MermaidCodeBlock';
import { isMermaidLanguage, isMermaidPreChild } from './mermaid-block-utils';

/**
 * Renderers to spread into a ReactMarkdown `components` map. A module constant,
 * so spreading it into a memoised map adds no new identity per render.
 */
export const MERMAID_MARKDOWN_COMPONENTS: Pick<Components, 'code' | 'pre'> = {
  // [Issue #3525] The hast node goes to the mermaid block: its `position` is
  // where the fence is in the input, which search pairs the source with.
  code: ({ node, className, children, ...rest }) =>
    isMermaidLanguage(className) ? (
      <MermaidCodeBlock className={className} node={node}>
        {children}
      </MermaidCodeBlock>
    ) : (
      // [Issue #3523] `className` first: the attributes come out in the order
      // react-markdown's own `<code>` writes them (search's mark comes after).
      <code className={className} {...rest}>
        {children}
      </code>
    ),
  // A mermaid fence is not wrapped in `<pre>`: the diagram frame is a block of
  // its own, and the surfaces' `pre` rules paint an always-dark code canvas.
  pre: ({ node: _node, children, ...rest }) =>
    isMermaidPreChild(children) ? <>{children}</> : <pre {...rest}>{children}</pre>,
};
