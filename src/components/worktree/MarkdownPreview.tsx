/**
 * MarkdownPreview Component
 * Issue #479: Extracted from MarkdownEditor.tsx for single responsibility
 *
 * Renders markdown content as HTML with:
 * - GitHub Flavored Markdown (GFM) support
 * - Syntax highlighting (rehype-highlight)
 * - XSS protection (rehype-sanitize) [SEC-MF-001]
 * - Mermaid diagram rendering [Issue #100]
 *
 * Also includes:
 * - Mobile tab bar component for portrait mode switching
 * - ESC hint bar for maximized mode
 * - Large file warning bar
 *
 * @module components/worktree/MarkdownPreview
 */

'use client';

import React, { memo, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import { X, AlertTriangle, FileText, Eye } from 'lucide-react';
import { MermaidCodeBlock } from '@/components/worktree/MermaidCodeBlock';
import type { Components } from 'react-markdown';

// ============================================================================
// Types
// ============================================================================

/** Mobile tab type for portrait mode */
export type MobileTab = 'editor' | 'preview';

export interface MarkdownPreviewProps {
  /** Markdown content to render */
  content: string;
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
 * and Mermaid diagram support.
 */
export const MarkdownPreview = memo(function MarkdownPreview({
  content,
}: MarkdownPreviewProps) {
  // Memoized ReactMarkdown components configuration (DRY principle)
  const markdownComponents: Partial<Components> = useMemo(
    () => ({
      code: MermaidCodeBlock, // [Issue #100] mermaid diagram support
    }),
    []
  );

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[
        rehypeSanitize, // [SEC-MF-001] XSS protection
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
