/**
 * TreeNode Component
 * Issue #479: Extracted from FileTreeView.tsx for single responsibility
 *
 * Renders a single node in the file tree with:
 * - File/folder icons with expand/collapse chevrons
 * - Lazy loading indicator
 * - Search query highlighting
 * - Right-click and long-press context menu support
 * - Keyboard navigation
 * - File metadata display (size, birthtime)
 *
 * [Issue #123] Touch long press context menu for iPad/iPhone
 */

'use client';

import React, { useState, useCallback, useMemo, memo } from 'react';
import type { TreeItem, SearchMode } from '@/types/models';
import { useLongPress } from '@/hooks/useLongPress';
import { escapeRegExp } from '@/lib/utils';
import { formatRelativeTime } from '@/lib/date-utils';
import { getDateFnsLocale } from '@/lib/date-locale';

// ============================================================================
// Types
// ============================================================================

/**
 * TreeNode Props
 *
 * [Issue #123 DISC-002/REC-001] onContextMenu type extended to support TouchEvent
 * for iPad/iPhone long press context menu.
 *
 * Touch Event Integration:
 * Touch events are handled via useLongPress hook which provides:
 * - onTouchStart: Starts the long press timer (500ms delay)
 * - onTouchMove: Cancels if touch moves beyond 10px threshold
 * - onTouchEnd/onTouchCancel: Cancels the long press timer
 *
 * [SF-002] These handlers are spread onto each TreeNode element to enable
 * context menu access on touch devices (iPad/iPhone) via long press gesture.
 */
export interface TreeNodeProps {
  /** Tree item data (name, type, size, etc.) */
  item: TreeItem;
  /** Parent path for building full file path */
  path: string;
  /** Nesting depth for indentation calculation */
  depth: number;
  /** Worktree ID for API calls */
  worktreeId: string;
  /** Set of expanded directory paths */
  expanded: Set<string>;
  /** Cache of loaded directory contents */
  cache: Map<string, TreeItem[]>;
  /** Toggle directory expansion state */
  onToggle: (path: string) => void;
  /** Handle file selection */
  onFileSelect?: (filePath: string) => void;
  /** Load children for a directory (lazy loading) */
  onLoadChildren: (path: string) => Promise<void>;
  /**
   * Context menu handler - supports both mouse right-click and touch long press
   * [Issue #123] Extended to accept TouchEvent for iPad/iPhone support
   */
  onContextMenu?: (e: React.MouseEvent | React.TouchEvent, path: string, type: 'file' | 'directory') => void;
  /** [Issue #21] Search query for name highlighting */
  searchQuery?: string;
  /** [Issue #21] Search mode ('name' or 'content') for filtering behavior */
  searchMode?: SearchMode;
  /** [Issue #21] Set of matched file/directory paths for content search filtering */
  matchedPaths?: Set<string>;
  /** [Issue #162] date-fns locale string for formatRelativeTime */
  dateFnsLocaleStr?: string;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format file size into a human-readable string.
 *
 * @param bytes - File size in bytes, or undefined for directories
 * @returns Formatted string (e.g., "1.2 KB", "3.5 MB"), or empty string if undefined
 */
export function formatFileSize(bytes: number | undefined): string {
  if (bytes === undefined) return '';

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Get indentation style based on depth
 * Uses inline styles instead of Tailwind classes to support unlimited depth
 * Tailwind CSS cannot generate dynamic class names at build time,
 * so we use inline styles to ensure proper indentation at any depth.
 *
 * @param depth - The nesting depth (0 = root level)
 * @returns React.CSSProperties with paddingLeft set
 */
export function getIndentStyle(depth: number): React.CSSProperties {
  // Maximum visual depth to prevent excessive indentation
  const maxVisualDepth = 20;
  const effectiveDepth = Math.min(depth, maxVisualDepth);
  // Base padding of 0.5rem + 1rem per depth level
  const paddingLeft = 0.5 + effectiveDepth * 1;
  return { paddingLeft: `${paddingLeft}rem` };
}

// ============================================================================
// Icon Components
// ============================================================================

export const ChevronIcon = memo(function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      data-testid="chevron-icon"
      className={`w-4 h-4 text-gray-500 dark:text-gray-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 5l7 7-7 7"
      />
    </svg>
  );
});

export const FolderIcon = memo(function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg
      data-testid="folder-icon"
      className="w-5 h-5 text-yellow-500"
      fill="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      {open ? (
        <path d="M19 20H5c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2h6l2 2h6c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2zM5 6v12h14V8h-7l-2-2H5z" />
      ) : (
        <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
      )}
    </svg>
  );
});

/**
 * [Issue #21] Highlight matching text in file names
 * XSS-safe implementation using React auto-escape
 */
export const HighlightedText = memo(function HighlightedText({
  text,
  query,
}: {
  text: string;
  query?: string;
}) {
  if (!query || !query.trim()) {
    return <>{text}</>;
  }

  // Use escapeRegExp to safely create regex pattern
  const escapedQuery = escapeRegExp(query);
  const parts = text.split(new RegExp(`(${escapedQuery})`, 'gi'));

  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={i} className="bg-yellow-200 dark:bg-yellow-700 text-gray-900 dark:text-gray-100 px-0.5 rounded">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
});

export const FileIcon = memo(function FileIcon({ extension }: { extension?: string }) {
  // Determine icon color based on extension
  const iconColor = useMemo(() => {
    if (!extension) return 'text-gray-400';

    const colorMap: Record<string, string> = {
      ts: 'text-blue-500',
      tsx: 'text-blue-500',
      js: 'text-yellow-400',
      jsx: 'text-yellow-400',
      json: 'text-yellow-600',
      md: 'text-gray-500',
      css: 'text-pink-500',
      scss: 'text-pink-500',
      html: 'text-orange-500',
      py: 'text-green-500',
    };

    return colorMap[extension] || 'text-gray-400';
  }, [extension]);

  return (
    <svg
      data-testid="file-icon"
      className={`w-5 h-5 ${iconColor}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
      />
    </svg>
  );
});

// ============================================================================
// TreeNode Component
// ============================================================================

export const TreeNode = memo(function TreeNode({
  item,
  path,
  depth,
  worktreeId,
  expanded,
  cache,
  onToggle,
  onFileSelect,
  onLoadChildren,
  onContextMenu,
  searchQuery,
  searchMode,
  matchedPaths,
  dateFnsLocaleStr,
}: TreeNodeProps) {
  const [loading, setLoading] = useState(false);
  const fullPath = path ? `${path}/${item.name}` : item.name;
  const isExpanded = expanded.has(fullPath);
  const isDirectory = item.type === 'directory';
  const children = cache.get(fullPath);

  const handleClick = useCallback(async () => {
    if (isDirectory) {
      if (!isExpanded && !children) {
        setLoading(true);
        await onLoadChildren(fullPath);
        setLoading(false);
      }
      onToggle(fullPath);
    } else {
      onFileSelect?.(fullPath);
    }
  }, [isDirectory, isExpanded, children, fullPath, onLoadChildren, onToggle, onFileSelect]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick();
      }
    },
    [handleClick]
  );

  /**
   * Handle context menu for mouse right-click
   * [Issue #123 REC-003] Type extended to support TouchEvent
   */
  const handleContextMenu = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault();
      onContextMenu?.(e, fullPath, isDirectory ? 'directory' : 'file');
    },
    [fullPath, isDirectory, onContextMenu]
  );

  /**
   * [Issue #123] Long press handler for touch devices (iPad/iPhone)
   * Opens context menu on long press (500ms)
   */
  const handleLongPress = useCallback(
    (e: React.TouchEvent) => {
      onContextMenu?.(e, fullPath, isDirectory ? 'directory' : 'file');
    },
    [fullPath, isDirectory, onContextMenu]
  );

  /**
   * [Issue #123] Long press detection for touch context menu
   * Uses useLongPress hook with default 500ms delay and 10px move threshold
   */
  const longPressHandlers = useLongPress({
    onLongPress: handleLongPress,
  });

  const indentStyle = getIndentStyle(depth);

  /**
   * [Issue #123] Combined inline styles for tree item
   * - Base indentation from depth calculation
   * - touch-action: manipulation - prevents browser default long press (scroll optimization)
   * - WebkitTouchCallout: none - prevents iOS native context menu
   */
  const combinedStyle: React.CSSProperties = {
    ...indentStyle,
    touchAction: 'manipulation',
    WebkitTouchCallout: 'none',
  };

  return (
    <>
      <div
        data-testid={`tree-item-${item.name}`}
        role="treeitem"
        aria-selected={false}
        aria-expanded={isDirectory ? isExpanded : undefined}
        tabIndex={0}
        className="flex items-center gap-2 py-1.5 pr-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors"
        style={combinedStyle}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
        onTouchStart={longPressHandlers.onTouchStart}
        onTouchMove={longPressHandlers.onTouchMove}
        onTouchEnd={longPressHandlers.onTouchEnd}
        onTouchCancel={longPressHandlers.onTouchCancel}
      >
        {/* Chevron for directories */}
        {isDirectory ? (
          <span className="w-4 h-4 flex items-center justify-center">
            {loading ? (
              <span className="w-3 h-3 border-2 border-gray-300 dark:border-gray-600 border-t-cyan-500 rounded-full animate-spin" />
            ) : (
              <ChevronIcon expanded={isExpanded} />
            )}
          </span>
        ) : (
          <span className="w-4 h-4" />
        )}

        {/* Icon */}
        {isDirectory ? (
          <FolderIcon open={isExpanded} />
        ) : (
          <FileIcon extension={item.extension} />
        )}

        {/* Name - with highlight for name search */}
        <span className="flex-1 truncate text-sm text-gray-700 dark:text-gray-300">
          {searchMode === 'name' && searchQuery ? (
            <HighlightedText text={item.name} query={searchQuery} />
          ) : (
            item.name
          )}
        </span>

        {/* File size or item count */}
        <span className="text-xs text-gray-400 flex-shrink-0">
          {isDirectory
            ? item.itemCount !== undefined && `${item.itemCount} items`
            : formatFileSize(item.size)}
        </span>

        {/* [Issue #162] File birthtime display */}
        {!isDirectory && item.birthtime && (
          <span
            className="text-xs text-gray-400 flex-shrink-0"
            title={item.birthtime}
          >
            {formatRelativeTime(item.birthtime, dateFnsLocaleStr ? getDateFnsLocale(dateFnsLocaleStr) : undefined)}
          </span>
        )}
      </div>

      {/* Children */}
      {isDirectory && isExpanded && children && (
        <div role="group">
          {children
            .filter((child) => {
              const childFullPath = fullPath ? `${fullPath}/${child.name}` : child.name;

              // No filtering if no search query
              if (!searchQuery?.trim()) {
                return true;
              }

              // Name search: filter by name match
              if (searchMode === 'name') {
                const lowerQuery = searchQuery.toLowerCase();
                // Show if name matches
                if (child.name.toLowerCase().includes(lowerQuery)) {
                  return true;
                }
                // Show directories to allow expansion and discovery of nested matches
                if (child.type === 'directory') {
                  return true;
                }
                return false;
              }

              // Content search: filter by matchedPaths
              if (searchMode === 'content' && matchedPaths && matchedPaths.size > 0) {
                // Show if this path is in matched paths
                if (matchedPaths.has(childFullPath)) {
                  return true;
                }
                // Show directories if they contain matched paths
                if (child.type === 'directory') {
                  for (const path of matchedPaths) {
                    if (path.startsWith(childFullPath + '/')) {
                      return true;
                    }
                  }
                }
                return false;
              }

              return true;
            })
            .map((child) => (
              <TreeNode
                key={child.name}
                item={child}
                path={fullPath}
                depth={depth + 1}
                worktreeId={worktreeId}
                expanded={expanded}
                cache={cache}
                onToggle={onToggle}
                onFileSelect={onFileSelect}
                onLoadChildren={onLoadChildren}
                onContextMenu={onContextMenu}
                searchQuery={searchQuery}
                searchMode={searchMode}
                matchedPaths={matchedPaths}
                dateFnsLocaleStr={dateFnsLocaleStr}
              />
            ))}
        </div>
      )}
    </>
  );
});

export default TreeNode;
