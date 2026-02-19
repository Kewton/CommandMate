/**
 * FileTreeView Component
 *
 * Displays a file tree with lazy loading, expand/collapse functionality,
 * and file selection for browsing worktree contents.
 *
 * Features:
 * - Lazy loading of directories on expand
 * - Caching of loaded directory contents
 * - File/folder icons with expand/collapse chevrons
 * - File selection callback for integration with FileViewer
 * - Right-click context menu for file operations [Phase 4]
 * - Keyboard navigation support
 * - Responsive design with touch-friendly targets
 * - [Issue #123] Touch long press context menu for iPad/iPhone
 */

'use client';

import React, { useState, useEffect, useCallback, useRef, memo, useMemo } from 'react';
import type { TreeItem, TreeResponse, SearchMode, SearchResultItem } from '@/types/models';
import { useContextMenu } from '@/hooks/useContextMenu';
import { useLongPress } from '@/hooks/useLongPress';
import { ContextMenu } from '@/components/worktree/ContextMenu';
import { escapeRegExp, computeMatchedPaths } from '@/lib/utils';
import { formatRelativeTime } from '@/lib/date-utils';
import { getDateFnsLocale } from '@/lib/date-locale';
import { useLocale } from 'next-intl';
import { FilePlus, FolderPlus } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

export interface FileTreeViewProps {
  /** Worktree ID to load tree from */
  worktreeId: string;
  /** Callback when a file is selected */
  onFileSelect?: (filePath: string) => void;
  /** Callback when new file should be created */
  onNewFile?: (parentPath: string) => void;
  /** Callback when new directory should be created */
  onNewDirectory?: (parentPath: string) => void;
  /** Callback when item should be renamed */
  onRename?: (path: string) => void;
  /** Callback when item should be deleted */
  onDelete?: (path: string) => void;
  /** Callback when file should be uploaded [IMPACT-002] */
  onUpload?: (targetDir: string) => void;
  /** Callback when item should be moved [Issue #162] */
  onMove?: (path: string, type: 'file' | 'directory') => void;
  /** Additional CSS classes */
  className?: string;
  /** Trigger to refresh the tree (increment to refresh) */
  refreshTrigger?: number;
  /** [Issue #21] Search query for filtering (optional) */
  searchQuery?: string;
  /** [Issue #21] Search mode: 'name' or 'content' (optional) */
  searchMode?: SearchMode;
  /** [Issue #21] Content search results for filtering (optional) */
  searchResults?: SearchResultItem[];
  /** [Issue #21] Callback when a search result is selected (optional) */
  onSearchResultSelect?: (filePath: string) => void;
}

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
interface TreeNodeProps {
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

/** Maximum number of concurrent directory fetches during tree reload */
const CONCURRENT_LIMIT = 5;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format file size into a human-readable string.
 *
 * @param bytes - File size in bytes, or undefined for directories
 * @returns Formatted string (e.g., "1.2 KB", "3.5 MB"), or empty string if undefined
 */
function formatFileSize(bytes: number | undefined): string {
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
function getIndentStyle(depth: number): React.CSSProperties {
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

const ChevronIcon = memo(function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      data-testid="chevron-icon"
      className={`w-4 h-4 text-gray-500 transition-transform ${expanded ? 'rotate-90' : ''}`}
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

const FolderIcon = memo(function FolderIcon({ open }: { open: boolean }) {
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
const HighlightedText = memo(function HighlightedText({
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
          <mark key={i} className="bg-yellow-200 text-gray-900 px-0.5 rounded">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
});

const FileIcon = memo(function FileIcon({ extension }: { extension?: string }) {
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

const TreeNode = memo(function TreeNode({
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
        className="flex items-center gap-2 py-1.5 pr-2 cursor-pointer hover:bg-gray-100 rounded transition-colors"
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
              <span className="w-3 h-3 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
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
        <span className="flex-1 truncate text-sm text-gray-700">
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

// ============================================================================
// Main Component
// ============================================================================

/**
 * FileTreeView - Tree view for browsing worktree files
 *
 * @example
 * ```tsx
 * <FileTreeView
 *   worktreeId="feature-123"
 *   onFileSelect={(path) => openFile(path)}
 *   onNewFile={(path) => createNewFile(path)}
 *   onRename={(path) => renameFile(path)}
 *   onDelete={(path) => deleteFile(path)}
 *   className="h-full"
 * />
 * ```
 */
export const FileTreeView = memo(function FileTreeView({
  worktreeId,
  onFileSelect,
  onNewFile,
  onNewDirectory,
  onRename,
  onDelete,
  onUpload,
  onMove,
  className = '',
  refreshTrigger = 0,
  searchQuery,
  searchMode,
  searchResults,
  onSearchResultSelect,
}: FileTreeViewProps) {
  // [Issue #162] Get locale for date formatting
  const locale = useLocale();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rootItems, setRootItems] = useState<TreeItem[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [cache, setCache] = useState<Map<string, TreeItem[]>>(() => new Map());

  // [Issue #164] Ref to access current expanded state without adding to useEffect dependencies
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  // [Issue #164] Ref to track in-progress fetches and prevent duplicate requests
  const loadingPathsRef = useRef<Set<string>>(new Set());

  // Context menu state (separated for rendering optimization)
  const { menuState, openMenu, closeMenu } = useContextMenu();

  /**
   * Fetch directory contents from API
   */
  const fetchDirectory = useCallback(
    async (path: string = ''): Promise<TreeResponse | null> => {
      try {
        const url = path
          ? `/api/worktrees/${worktreeId}/tree/${path}`
          : `/api/worktrees/${worktreeId}/tree`;

        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(`Failed to load directory: ${response.status}`);
        }

        return await response.json();
      } catch (err) {
        console.error('[FileTreeView] Error fetching directory:', err);
        throw err;
      }
    },
    [worktreeId]
  );

  /**
   * [Issue #164] Load root directory and re-fetch all expanded directories
   * on mount or when refreshTrigger changes.
   *
   * Instead of clearing cache and only reloading root (which caused expanded
   * directories to lose their contents), this re-fetches all expanded
   * directories in parallel chunks of CONCURRENT_LIMIT.
   */
  useEffect(() => {
    let mounted = true;

    const reloadTreeWithExpandedDirs = async () => {
      setLoading(true);
      setError(null);

      try {
        // Step 1: Re-fetch root directory
        const rootData = await fetchDirectory();
        if (!mounted || !rootData) return;

        // Step 2: Get currently expanded paths from ref (avoids dependency on expanded)
        const expandedPaths = Array.from(expandedRef.current);

        // Step 3: Re-fetch expanded directories in parallel chunks
        const newCache = new Map<string, TreeItem[]>();
        const stalePaths: string[] = [];

        for (let i = 0; i < expandedPaths.length; i += CONCURRENT_LIMIT) {
          if (!mounted) return;

          const chunk = expandedPaths.slice(i, i + CONCURRENT_LIMIT);
          const results = await Promise.allSettled(
            chunk.map(async (dirPath) => {
              const data = await fetchDirectory(dirPath);
              return { dirPath, data };
            })
          );

          for (const [j, result] of results.entries()) {
            if (result.status === 'fulfilled' && result.value.data) {
              newCache.set(result.value.dirPath, result.value.data.items);
            } else {
              // Directory may have been deleted or become inaccessible
              stalePaths.push(chunk[j]);
            }
          }
        }

        if (!mounted) return;

        // Step 4: Update state in batch
        setRootItems(rootData.items);
        setCache(newCache);

        // Remove stale paths (deleted/inaccessible directories) from expanded set
        if (stalePaths.length > 0) {
          setExpanded((prev) => {
            const next = new Set(prev);
            for (const path of stalePaths) {
              if (path) next.delete(path);
            }
            return next;
          });
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to load files');
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    reloadTreeWithExpandedDirs();

    return () => {
      mounted = false;
    };
  }, [fetchDirectory, refreshTrigger]);

  /**
   * Load children for a directory
   * [Issue #164] Fixed: uses setCache instead of direct Map mutation,
   * and loadingPathsRef to prevent duplicate fetches.
   */
  const loadChildren = useCallback(
    async (path: string) => {
      // Check cache or in-progress fetch first
      if (cache.has(path) || loadingPathsRef.current.has(path)) {
        return;
      }

      loadingPathsRef.current.add(path);
      try {
        const data = await fetchDirectory(path);
        if (data) {
          setCache(prev => {
            const next = new Map(prev);
            next.set(path, data.items);
            return next;
          });
        }
      } catch (err) {
        console.error('[FileTreeView] Error loading children:', err);
      } finally {
        loadingPathsRef.current.delete(path);
      }
    },
    [cache, fetchDirectory]
  );

  /**
   * Toggle directory expansion
   */
  const handleToggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  /**
   * [Issue #21] Compute matched paths for content search
   * Used to filter tree items and auto-expand parent directories
   * [DRY] Uses shared computeMatchedPaths utility
   */
  const matchedPaths = useMemo((): Set<string> => {
    if (searchMode !== 'content' || !searchResults || searchResults.length === 0) {
      return new Set();
    }

    return computeMatchedPaths(searchResults.map((item) => item.filePath));
  }, [searchMode, searchResults]);

  /**
   * [Issue #21] Auto-expand directories containing matched files
   */
  useEffect(() => {
    if (matchedPaths.size > 0) {
      setExpanded((prev) => {
        const next = new Set(prev);
        // Add all matched directory paths
        for (const path of matchedPaths) {
          // Only add if it's a directory (has children in cache or is a parent path)
          if (cache.has(path) || searchResults?.some(r => r.filePath.startsWith(path + '/'))) {
            next.add(path);
          }
        }
        return next;
      });
    }
  }, [matchedPaths, cache, searchResults]);

  /**
   * [Issue #21] Filter root items based on search
   */
  const filteredRootItems = useMemo((): TreeItem[] => {
    // No filtering if no search query
    if (!searchQuery?.trim()) {
      return rootItems;
    }

    // Name search: filter by file/directory name
    if (searchMode === 'name') {
      const lowerQuery = searchQuery.toLowerCase();

      // Recursive filter function that includes directories if any child matches
      const filterItems = (items: TreeItem[], parentPath: string): TreeItem[] => {
        return items.filter((item) => {
          const fullPath = parentPath ? `${parentPath}/${item.name}` : item.name;

          // Check if this item matches
          const itemMatches = item.name.toLowerCase().includes(lowerQuery);

          // For directories, also check if any cached children match
          if (item.type === 'directory') {
            const children = cache.get(fullPath);
            if (children && filterItems(children, fullPath).length > 0) {
              return true;
            }
          }

          return itemMatches;
        });
      };

      return filterItems(rootItems, '');
    }

    // Content search: filter by matched paths from search results
    if (searchMode === 'content' && matchedPaths.size > 0) {
      // Show items that are in matched paths or are parent directories
      return rootItems.filter((item) => {
        if (matchedPaths.has(item.name)) {
          return true;
        }
        // Check if any matched path starts with this directory
        if (item.type === 'directory') {
          for (const path of matchedPaths) {
            if (path.startsWith(item.name + '/') || path === item.name) {
              return true;
            }
          }
        }
        return false;
      });
    }

    return rootItems;
  }, [rootItems, searchQuery, searchMode, matchedPaths, cache]);

  // Loading state
  if (loading) {
    return (
      <div
        data-testid="file-tree-loading"
        className={`flex items-center justify-center p-4 ${className}`}
      >
        <span className="w-5 h-5 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
        <span className="ml-2 text-sm text-gray-500">Loading files...</span>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div
        data-testid="file-tree-error"
        className={`p-4 bg-red-50 border border-red-200 rounded-lg ${className}`}
      >
        <p className="text-sm text-red-600">{error}</p>
      </div>
    );
  }

  // Empty state
  if (rootItems.length === 0) {
    return (
      <div
        data-testid="file-tree-empty"
        className={`p-4 text-center text-gray-500 ${className}`}
      >
        <p className="text-sm">No files found</p>
        {/* Action buttons for empty state - only show when callbacks are provided */}
        {(onNewFile || onNewDirectory) && (
          <div className="flex flex-col gap-2 mt-4">
            {onNewFile && (
              <button
                data-testid="empty-new-file-button"
                onClick={() => onNewFile('')}
                className="flex items-center justify-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                <FilePlus className="w-4 h-4" aria-hidden="true" />
                <span>New File</span>
              </button>
            )}
            {onNewDirectory && (
              <button
                data-testid="empty-new-directory-button"
                onClick={() => onNewDirectory('')}
                className="flex items-center justify-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                <FolderPlus className="w-4 h-4" aria-hidden="true" />
                <span>New Directory</span>
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  // [Issue #21] No search results state
  if (searchQuery?.trim() && filteredRootItems.length === 0) {
    return (
      <div
        data-testid="file-tree-no-results"
        className={`p-4 text-center text-gray-500 ${className}`}
      >
        <p className="text-sm">
          No {searchMode === 'content' ? 'files containing' : 'files matching'} &quot;{searchQuery}&quot;
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="file-tree-view"
      role="tree"
      aria-label="File tree"
      className={`overflow-auto bg-white ${className}`}
    >
      {/* [Issue #300] Toolbar for root-level file/directory creation */}
      {(onNewFile || onNewDirectory) && (
        <div
          data-testid="file-tree-toolbar"
          className="flex items-center gap-1 p-1 border-b border-gray-200 dark:border-gray-700"
        >
          {onNewFile && (
            <button
              data-testid="toolbar-new-file-button"
              onClick={() => onNewFile('')}
              className="flex items-center gap-1 px-2 py-1 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
            >
              <FilePlus className="w-4 h-4" aria-hidden="true" />
              <span>New File</span>
            </button>
          )}
          {onNewDirectory && (
            <button
              data-testid="toolbar-new-directory-button"
              onClick={() => onNewDirectory('')}
              className="flex items-center gap-1 px-2 py-1 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
            >
              <FolderPlus className="w-4 h-4" aria-hidden="true" />
              <span>New Directory</span>
            </button>
          )}
        </div>
      )}
      {filteredRootItems.map((item) => (
        <TreeNode
          key={item.name}
          item={item}
          path=""
          depth={0}
          worktreeId={worktreeId}
          expanded={expanded}
          cache={cache}
          onToggle={handleToggle}
          onFileSelect={onSearchResultSelect || onFileSelect}
          onLoadChildren={loadChildren}
          onContextMenu={openMenu}
          searchQuery={searchQuery}
          searchMode={searchMode}
          matchedPaths={matchedPaths}
          dateFnsLocaleStr={locale}
        />
      ))}

      {/* Context Menu */}
      <ContextMenu
        isOpen={menuState.isOpen}
        position={menuState.position}
        targetPath={menuState.targetPath}
        targetType={menuState.targetType}
        onClose={closeMenu}
        onNewFile={onNewFile}
        onNewDirectory={onNewDirectory}
        onRename={onRename}
        onDelete={onDelete}
        onUpload={onUpload}
        onMove={onMove}
      />
    </div>
  );
});

export default FileTreeView;
