/**
 * MarkdownPreview Component
 * Issue #479: Extracted from MarkdownEditor.tsx for single responsibility
 * Issue #505: Link handling (relative file, external URL, anchor) [DR2-001]
 *
 * Renders markdown content as HTML with:
 * - GitHub Flavored Markdown (GFM) support
 * - Syntax highlighting (rehype-highlight)
 * - XSS protection (rehype-sanitize with allowlist) [SEC-MF-001, DR4-001]
 * - Mermaid diagram rendering [Issue #100]
 * - Link click handling (relative -> onOpenFile, external -> window.open, anchor -> scroll)
 *
 * Also includes:
 * - Mobile tab bar component for portrait mode switching
 * - ESC hint bar for maximized mode
 * - Large file warning bar
 *
 * @module components/worktree/MarkdownPreview
 */

'use client';

import React, { memo, useMemo, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import { X, AlertTriangle, FileText, Eye } from 'lucide-react';
import { MermaidCodeBlock } from '@/components/worktree/MermaidCodeBlock';
import { classifyLink, resolveRelativePath, sanitizeHref, REHYPE_SANITIZE_SCHEMA } from '@/lib/link-utils';
import type { Components } from 'react-markdown';

// ============================================================================
// Types
// ============================================================================

/** Mobile tab type for portrait mode */
export type MobileTab = 'editor' | 'preview';

export interface MarkdownPreviewProps {
  /** Markdown content to render */
  content: string;
  /** Callback to open a file from a relative link (Issue #505) */
  onOpenFile?: (path: string) => void;
  /** Current file path for resolving relative links (Issue #505) [DR3-009] */
  currentFilePath?: string;
}

export interface MobileTabBarProps {
  /** Current active tab */
  mobileTab: MobileTab;
  /** Callback to change tab */
  onTabChange: (tab: MobileTab) => void;
}

export interface MaximizeHintProps {
  /** Whether to show mobile hint */
  isMobile: boolean;
}

export interface LargeFileWarningProps {
  /** Callback to dismiss the warning */
  onDismiss: () => void;
}

// ============================================================================
// MarkdownPreview Component
// ============================================================================

/**
 * Renders markdown content with GFM, syntax highlighting, XSS protection,
 * Mermaid diagram support, and link click handling.
 */
export const MarkdownPreview = memo(function MarkdownPreview({
  content,
  onOpenFile,
  currentFilePath,
}: MarkdownPreviewProps) {
  /**
   * Handle link click based on link type. [DR1-002]
   * - relative: resolve path and call onOpenFile
   * - external: open in new window
   * - anchor: default browser scroll behavior
   */
  const handleLinkClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
      const sanitized = sanitizeHref(href);
      if (!sanitized) return;

      const linkType = classifyLink(sanitized);

      switch (linkType) {
        case 'anchor':
          // Let browser handle anchor scroll
          break;
        case 'external':
          e.preventDefault();
          window.open(sanitized, '_blank', 'noopener,noreferrer');
          break;
        case 'relative': {
          e.preventDefault();
          if (currentFilePath && onOpenFile) {
            const resolvedPath = resolveRelativePath(currentFilePath, sanitized);
            if (resolvedPath) {
              onOpenFile(resolvedPath);
            }
          }
          break;
        }
      }
    },
    [onOpenFile, currentFilePath],
  );

  // Memoized ReactMarkdown components configuration (DRY principle)
  const markdownComponents: Partial<Components> = useMemo(
    () => ({
      code: MermaidCodeBlock, // [Issue #100] mermaid diagram support
      // [Issue #505] Custom link component for file navigation
      a: ({ href, children, ...props }) => {
        if (!href) {
          return <a {...props}>{children}</a>;
        }
        return (
          <a
            {...props}
            href={href}
            onClick={(e) => handleLinkClick(e, href)}
          >
            {children}
          </a>
        );
      },
    }),
    [handleLinkClick],
  );

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[
        [rehypeSanitize, REHYPE_SANITIZE_SCHEMA],
        rehypeHighlight,
      ]}
      components={markdownComponents}
    >
      {content}
    </ReactMarkdown>
  );
});

// ============================================================================
// MobileTabBar Component
// ============================================================================

/**
 * Tab bar for switching between editor and preview in mobile portrait mode.
 */
export const MobileTabBar = memo(function MobileTabBar({
  mobileTab,
  onTabChange,
}: MobileTabBarProps) {
  return (
    <div className="flex border-b border-gray-200 dark:border-gray-700">
      <button
        data-testid="mobile-tab-editor"
        onClick={() => onTabChange('editor')}
        className={`flex-1 py-2 text-sm font-medium ${
          mobileTab === 'editor'
            ? 'text-cyan-600 dark:text-cyan-400 border-b-2 border-cyan-600 dark:border-cyan-400'
            : 'text-gray-500 dark:text-gray-400'
        }`}
      >
        <FileText className="h-4 w-4 inline-block mr-1" />
        Editor
      </button>
      <button
        data-testid="mobile-tab-preview"
        onClick={() => onTabChange('preview')}
        className={`flex-1 py-2 text-sm font-medium ${
          mobileTab === 'preview'
            ? 'text-cyan-600 dark:text-cyan-400 border-b-2 border-cyan-600 dark:border-cyan-400'
            : 'text-gray-500 dark:text-gray-400'
        }`}
      >
        <Eye className="h-4 w-4 inline-block mr-1" />
        Preview
      </button>
    </div>
  );
});

// ============================================================================
// MaximizeHint Component
// ============================================================================

/**
 * Hint bar displayed when editor is in maximized/fullscreen mode.
 */
export const MaximizeHint = memo(function MaximizeHint({
  isMobile,
}: MaximizeHintProps) {
  return (
    <div
      data-testid="maximize-hint"
      className="flex items-center justify-center px-4 py-1 bg-gray-800 text-gray-300 text-xs"
    >
      Press ESC to exit fullscreen {isMobile && '(or swipe down)'}
    </div>
  );
});

// ============================================================================
// LargeFileWarning Component
// ============================================================================

/**
 * Warning bar displayed when editing a large file (>500KB).
 */
export const LargeFileWarning = memo(function LargeFileWarning({
  onDismiss,
}: LargeFileWarningProps) {
  return (
    <div
      data-testid="large-file-warning"
      className="flex items-center gap-2 px-4 py-2 bg-yellow-50 dark:bg-yellow-900/30 border-b border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-300 text-sm"
    >
      <AlertTriangle className="h-4 w-4" />
      Large file: Performance may be affected.
      <button
        onClick={onDismiss}
        className="ml-auto text-yellow-600 hover:text-yellow-800"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
});

export default MarkdownPreview;
