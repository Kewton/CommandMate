/**
 * MermaidCodeBlock Component
 *
 * Wrapper component for ReactMarkdown's code block.
 * Conditionally renders MermaidDiagram for mermaid language.
 *
 * @module components/worktree/MermaidCodeBlock
 */

'use client';

import React from 'react';
import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';
import { CodeBlockWithCopy } from '@/components/common/CodeBlockWithCopy';

/**
 * Dynamic import of MermaidDiagram with SSR disabled
 * [SF2-004] Uses existing Loader2 spinner for consistent loading UI
 */
const MermaidDiagram = dynamic(
  () =>
    import('./MermaidDiagram').then((mod) => ({
      default: mod.MermaidDiagram,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="mermaid-loading flex items-center gap-2 text-gray-500 p-4">
        <Loader2 className="animate-spin h-4 w-4" />
        <span>Loading diagram...</span>
      </div>
    ),
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
  /** Whether this is an inline code block */
  inline?: boolean;
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

/**
 * Check if the code block is mermaid
 *
 * @param className - CSS class name from ReactMarkdown
 * @returns True if the code block is mermaid
 */
function isMermaidLanguage(className?: string): boolean {
  if (!className) return false;
  return className.split(' ').includes('language-mermaid');
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
  inline,
}: MermaidCodeBlockProps): JSX.Element {
  // Inline code blocks are always rendered as regular code
  if (inline) {
    return (
      <code className={className}>
        {children}
      </code>
    );
  }

  // Check if this is a mermaid code block
  if (isMermaidLanguage(className)) {
    const code = extractCodeString(children);
    return <MermaidDiagram code={code} />;
  }

  // Non-mermaid code blocks are rendered as regular code elements, wrapped with
  // a copy button (Issue #981). The wrapper is a <span> so it stays valid
  // phrasing content inside the parent <pre>.
  return (
    <CodeBlockWithCopy as="span">
      <code className={className}>
        {children}
      </code>
    </CodeBlockWithCopy>
  );
}
