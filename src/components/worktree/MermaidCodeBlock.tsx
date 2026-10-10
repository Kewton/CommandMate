/**
 * MermaidCodeBlock Component
 *
 * Wrapper component for ReactMarkdown's code block.
 * Conditionally renders MermaidDiagram for mermaid language.
 *
 * Since Issue #3503 a mermaid block is the diagram AND its source: a folded
 * "Source" under the diagram (open when the diagram fails), holding the fence
 * body as text. The file preview, chat and History all draw a mermaid fence
 * through this one component.
 *
 * @module components/worktree/MermaidCodeBlock
 */

'use client';

import React, { useCallback, useContext, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { Spinner } from '@/components/ui/Spinner';
import {
  MERMAID_BLOCK_SETTLED_EVENT,
  MERMAID_RAW_END_ATTR,
  MERMAID_RAW_START_ATTR,
  MERMAID_SOURCE_ATTR,
  SEARCH_SKIP_ATTR,
} from '@/lib/terminal-highlight';
import { isMermaidLanguage } from './mermaid-block-utils';
import { MermaidRawOffsetContext } from './mermaid-raw-offset';
import type { MermaidRenderState } from './MermaidDiagram';

/**
 * Dynamic import of MermaidDiagram with SSR disabled
 * [SF2-004] Uses the shared Spinner primitive for consistent loading UI
 */
const MermaidDiagram = dynamic(
  () =>
    import('./MermaidDiagram').then((mod) => ({
      default: mod.MermaidDiagram,
    })),
  {
    ssr: false,
    loading: function MermaidDiagramLoading() {
      const t = useTranslations('worktree');
      return (
        <div className="mermaid-loading flex items-center gap-2 text-muted-foreground p-4">
          <Spinner size="sm" />
          <span>{t('mermaid.loading')}</span>
        </div>
      );
    },
  }
);

/**
 * MermaidCodeBlock Props Interface
 *
 * [SF2-001] ReactMarkdownのCodeComponent型との互換性を確保。
 * childrenはReactMarkdownから文字列または文字列配列として渡される可能性がある。
 *
 * @see ReactMarkdownProps['components']['code'] for type reference
 */
export interface MermaidCodeBlockProps {
  /** CSS class name (used to detect language-mermaid) */
  className?: string;
  /** Code content as string, string array, or React node */
  children?: React.ReactNode | string | string[];
  /** ReactMarkdown passes AST node */
  node?: unknown;
}

/**
 * Extract code string from children
 *
 * @param children - React children (string, string array, or ReactNode)
 * @returns Code as string
 */
function extractCodeString(
  children: React.ReactNode | string | string[] | undefined
): string {
  if (children === undefined || children === null) {
    return '';
  }

  if (typeof children === 'string') {
    return children;
  }

  if (Array.isArray(children)) {
    return children
      .map((child) =>
        typeof child === 'string' ? child : ''
      )
      .join('');
  }

  // For other ReactNode types, try to extract text content
  return String(children);
}

/** react-markdown's hast node for the code element: where it was in the input. */
function nodeRange(node: unknown): { start: number; end: number } | null {
  const position = (node as { position?: { start?: { offset?: unknown }; end?: { offset?: unknown } } } | undefined)
    ?.position;
  const start = position?.start?.offset;
  const end = position?.end?.offset;
  return typeof start === 'number' && typeof end === 'number' ? { start, end } : null;
}

/** Test id of the frame holding one mermaid diagram and its source. */
export const MERMAID_BLOCK_TESTID = 'mermaid-block-frame';
/** Test id of the folded source under a diagram. */
export const MERMAID_SOURCE_TESTID = 'mermaid-source';

const SKIP = { [SEARCH_SKIP_ATTR]: 'true' } as const;
const SOURCE = { [MERMAID_SOURCE_ATTR]: 'true' } as const;

/**
 * One mermaid fence: the diagram, then its source folded underneath.
 *
 * - The source is the fence body as a text child — React escapes it, it is
 *   never parsed as HTML.
 * - It is rendered from the first paint and never re-keyed, so its text nodes
 *   are the same before the diagram loads, after it draws, and after a theme
 *   redraw: a search highlight placed on it stays where it is.
 * - The diagram side and the "Source" label carry `data-search-skip`, so search
 *   counts only the source body (see `lib/terminal-highlight`).
 * - Closed by default; open when the diagram failed, so the error is shown with
 *   the text that caused it.
 */
function MermaidBlock({ code, node }: { code: string; node?: unknown }): React.JSX.Element {
  const t = useTranslations('worktree');
  const [failed, setFailed] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);

  const handleRenderState = useCallback((state: MermaidRenderState) => {
    setFailed(state === 'error');
    frameRef.current?.dispatchEvent(new CustomEvent(MERMAID_BLOCK_SETTLED_EVENT, { bubbles: true }));
  }, []);

  // hast gives a fence's text with one trailing newline; the source shows the
  // body as written (and as search finds it in the raw message).
  const source = code.endsWith('\n') ? code.slice(0, -1) : code;

  // [Issue #3525] Where this fence is in the message as written, for search to
  // pair a hit with this source by structure rather than by a line pattern.
  const toRaw = useContext(MermaidRawOffsetContext);
  const range = nodeRange(node);
  const rawStart = range && toRaw ? toRaw(range.start) : null;
  const rawEnd = range && toRaw ? toRaw(range.end) : null;
  const rawRange =
    rawStart !== null && rawEnd !== null && rawEnd > rawStart
      ? { [MERMAID_RAW_START_ATTR]: String(rawStart), [MERMAID_RAW_END_ATTR]: String(rawEnd) }
      : {};

  return (
    <div ref={frameRef} data-testid={MERMAID_BLOCK_TESTID} className="mermaid-block">
      <div {...SKIP} className="mermaid-figure">
        <MermaidDiagram code={code} onRenderStateChange={handleRenderState} />
      </div>
      <details data-testid={MERMAID_SOURCE_TESTID} className="mermaid-source" open={failed || undefined}>
        <summary {...SKIP}>{t('mermaid.source')}</summary>
        <pre>
          <code {...SOURCE} {...rawRange}>{source}</code>
        </pre>
      </details>
    </div>
  );
}

/**
 * MermaidCodeBlock Component
 *
 * Conditionally renders MermaidDiagram for mermaid language,
 * or a regular code element for other languages.
 *
 * @example
 * ```tsx
 * // Used as ReactMarkdown components prop
 * <ReactMarkdown
 *   components={{
 *     code: MermaidCodeBlock,
 *   }}
 * >
 *   {markdown}
 * </ReactMarkdown>
 * ```
 */
export function MermaidCodeBlock({
  className,
  children,
  node,
}: MermaidCodeBlockProps): React.JSX.Element {
  // Fenced mermaid blocks render as a diagram.
  if (isMermaidLanguage(className)) {
    const code = extractCodeString(children);
    return <MermaidBlock code={code} node={node} />;
  }

  // Everything else — inline code and non-mermaid block code — renders as a
  // plain <code>. react-markdown v10 no longer passes an `inline` prop, so the
  // copy button is attached by MarkdownPreview's `pre` renderer (block code
  // only); inline code has no <pre> ancestor and is therefore never decorated,
  // fixing the inline-code line-break regression. (Issue #983)
  return <code className={className}>{children}</code>;
}
