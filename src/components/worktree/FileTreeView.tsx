/**
 * FileTreeView Component
 * Issue #479: Split into FileTreeView.tsx + TreeNode.tsx + TreeContextMenu.tsx
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
import { ContextMenu } from '@/components/worktree/ContextMenu';
import { TreeNode } from '@/components/worktree/TreeNode';
import { FileMetadataToggle } from '@/components/worktree/FileMetadataToggle';
import { computeMatchedPaths } from '@/lib/utils';
import { useFilePolling } from '@/hooks/useFilePolling';
import { useFileMetadataDisplay } from '@/hooks/useFileMetadataDisplay';
import { FILE_TREE_POLL_INTERVAL_MS } from '@/config/file-polling-config';
import { useLocale } from 'next-intl';
import { FilePlus, FolderPlus, AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui';

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
  /**
   * [Issue #888] When true, poll for external file changes across the root and
   * all currently-expanded subdirectories, refreshing only when something
   * actually changed. The caller passes the activation condition (e.g.
   * `activeActivity === 'files'`) so detection stays scoped to when the tree
   * is visible. Defaults to off.
   */
  pollingEnabled?: boolean;
  /** [Issue #21] Search query for filtering (optional) */
  searchQuery?: string;
  /** [Issue #21] Search mode: 'name' or 'content' (optional) */
  searchMode?: SearchMode;
  /** [Issue #21] Content search results for filtering (optional) */
  searchResults?: SearchResultItem[];
  /** [Issue #21] Callback when a search result is selected (optional) */
  onSearchResultSelect?: (filePath: string) => void;
}

/** Maximum number of concurrent directory fetches during tree reload */
const CONCURRENT_LIMIT = 5;

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
  pollingEnabled = false,
  searchQuery,
  searchMode,
  searchResults,
  onSearchResultSelect,
}: FileTreeViewProps) {
  // [Issue #162] Get locale for date formatting
  const locale = useLocale();
  // [Issue #969] Inline metadata column visibility (size / created / modified),
  // localStorage-persisted and synced across hook instances.
  const { settings: metadataDisplay, toggle: toggleMetadata } =
    useFileMetadataDisplay();
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

  // [Issue #706] Mounted ref for the reload function. The ref tracks
  // whether the component is currently mounted so that the retry button
  // (which can fire after unmount) can short-circuit state updates safely.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * [Issue #164] Load root directory and re-fetch all expanded directories
   * on mount or when refreshTrigger changes.
   *
   * Instead of clearing cache and only reloading root (which caused expanded
   * directories to lose their contents), this re-fetches all expanded
   * directories in parallel chunks of CONCURRENT_LIMIT.
   *
   * [Issue #706] Extracted to a useCallback so the refetch error retry
   * button can re-trigger the same loader.
   */
  const reloadTreeWithExpandedDirs = useCallback(async () => {
    if (!mountedRef.current) return;
    setLoading(true);
    setError(null);

    try {
      // Step 1: Re-fetch root directory
      const rootData = await fetchDirectory();
      if (!mountedRef.current || !rootData) return;

      // Step 2: Get currently expanded paths from ref (avoids dependency on expanded)
      const expandedPaths = Array.from(expandedRef.current);

      // Step 3: Re-fetch expanded directories in parallel chunks
      const newCache = new Map<string, TreeItem[]>();
      const stalePaths: string[] = [];

      for (let i = 0; i < expandedPaths.length; i += CONCURRENT_LIMIT) {
        if (!mountedRef.current) return;

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

      if (!mountedRef.current) return;

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
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load files');
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [fetchDirectory]);

  useEffect(() => {
    void reloadTreeWithExpandedDirs();
    // Re-run when refreshTrigger changes; reloadTreeWithExpandedDirs
    // is stable as long as fetchDirectory (= worktreeId) is unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadTreeWithExpandedDirs, refreshTrigger]);

  // ==========================================================================
  // [Issue #888] External change detection (polling)
  //
  // The previous implementation polled only the ROOT directory
  // (useWorktreeDetailController), so files created inside an *expanded*
  // subdirectory were never detected while the Files tab stayed mounted — the
  // root listing (and thus its hash) was unchanged. Detection now lives here,
  // next to `expandedRef` + `fetchDirectory`, and covers the root PLUS every
  // expanded subdirectory, so the detection scope matches the refresh scope of
  // `reloadTreeWithExpandedDirs()`. A real change triggers a single reload that
  // preserves scroll/selection/expansion (Issue #706).
  // ==========================================================================

  // Per-directory content signature (path -> hash of its items) captured on the
  // previous poll. Comparing per directory (rather than one flat hash) means
  // newly-expanded dirs — freshly loaded by loadChildren — and collapsed dirs
  // do NOT count as external changes, avoiding false-positive refreshes.
  const pollSignatureRef = useRef<Map<string, string> | null>(null);
  // Guard against overlapping polls if a tick fires before the previous one's
  // fetches have settled.
  const pollInFlightRef = useRef(false);

  // Reset the baseline when the target worktree changes so a stale signature
  // from a previous worktree can never trip a false refresh.
  useEffect(() => {
    pollSignatureRef.current = null;
  }, [worktreeId]);

  const detectExternalChanges = useCallback(async () => {
    if (!mountedRef.current || pollInFlightRef.current) return;
    pollInFlightRef.current = true;
    try {
      // The directories currently on screen: root ('') + expanded subdirs.
      const paths = ['', ...Array.from(expandedRef.current)];
      const signature = new Map<string, string>();

      for (let i = 0; i < paths.length; i += CONCURRENT_LIMIT) {
        if (!mountedRef.current) return;
        const chunk = paths.slice(i, i + CONCURRENT_LIMIT);
        const results = await Promise.all(
          chunk.map(async (dirPath) => {
            try {
              const data = await fetchDirectory(dirPath);
              return { dirPath, hash: JSON.stringify(data?.items ?? null) };
            } catch {
              // A directory we previously listed that now errors (deleted /
              // inaccessible) is itself a change — record a sentinel so the
              // comparison trips and the reload prunes the stale path.
              return { dirPath, hash: ' unavailable' };
            }
          })
        );
        for (const { dirPath, hash } of results) {
          signature.set(dirPath, hash);
        }
      }

      if (!mountedRef.current) return;

      const baseline = pollSignatureRef.current;
      pollSignatureRef.current = signature;

      // First poll only records a baseline (no reload) so we never fire a
      // false-positive refresh that would disturb scroll/selection (Issue #706).
      if (baseline === null) return;

      // Reload only when a directory present in BOTH snapshots changed content.
      let changed = false;
      for (const [dirPath, hash] of signature) {
        const prev = baseline.get(dirPath);
        if (prev !== undefined && prev !== hash) {
          changed = true;
          break;
        }
      }

      if (changed) {
        void reloadTreeWithExpandedDirs();
      }
    } finally {
      pollInFlightRef.current = false;
    }
  }, [fetchDirectory, reloadTreeWithExpandedDirs]);

  // Reuse the shared polling lifecycle (5s interval + visibilitychange pause).
  useFilePolling({
    intervalMs: FILE_TREE_POLL_INTERVAL_MS,
    enabled: pollingEnabled,
    onPoll: detectExternalChanges,
  });

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

  // [Issue #706] Only show the full-screen loading indicator on the
  // initial load. Subsequent refetches keep the existing tree visible to
  // preserve scroll position / selection, and a compact spinner is
  // rendered in the toolbar area instead (see below).
  const isInitialLoading = loading && rootItems.length === 0;
  if (isInitialLoading) {
    return (
      <div
        data-testid="file-tree-loading"
        className={`flex items-center justify-center p-4 ${className}`}
      >
        <span className="w-5 h-5 border-2 border-input border-t-cyan-500 rounded-full animate-spin" />
        <span className="ml-2 text-sm text-muted-foreground">Loading files...</span>
      </div>
    );
  }

  // [Issue #706] Only show the full-screen error state if we never managed
  // to load any items. Otherwise the tree stays mounted and a refetch
  // error banner is rendered above it (see below).
  const isInitialError = !!error && rootItems.length === 0;
  if (isInitialError) {
    return (
      <div
        data-testid="file-tree-error"
        className={`p-4 bg-red-50 border border-red-200 rounded-lg ${className}`}
      >
        <p className="text-sm text-red-600">{error}</p>
      </div>
    );
  }

  // [Issue #706] Compact, non-destructive refetch indicator state.
  const isRefetching = loading && rootItems.length > 0;
  const isRefetchError = !!error && rootItems.length > 0;

  // Empty state
  if (rootItems.length === 0) {
    return (
      <div
        data-testid="file-tree-empty"
        className={`p-4 text-center text-muted-foreground ${className}`}
      >
        <p className="text-sm">No files found</p>
        {/* Action buttons for empty state - only show when callbacks are provided */}
        {(onNewFile || onNewDirectory) && (
          <div className="flex flex-col gap-2 mt-4">
            {onNewFile && (
              <Button
                variant="ghost"
                data-testid="empty-new-file-button"
                onClick={() => onNewFile('')}
                className="flex items-center justify-center gap-2 px-3 py-2 text-sm text-foreground bg-surface border border-input rounded-md hover:bg-muted transition-colors"
              >
                <FilePlus className="w-4 h-4" aria-hidden="true" />
                <span>New File</span>
              </Button>
            )}
            {onNewDirectory && (
              <Button
                variant="ghost"
                data-testid="empty-new-directory-button"
                onClick={() => onNewDirectory('')}
                className="flex items-center justify-center gap-2 px-3 py-2 text-sm text-foreground bg-surface border border-input rounded-md hover:bg-muted transition-colors"
              >
                <FolderPlus className="w-4 h-4" aria-hidden="true" />
                <span>New Directory</span>
              </Button>
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
        className={`p-4 text-center text-muted-foreground ${className}`}
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
      className={`overflow-auto bg-surface ${className}`}
    >
      {/* [Issue #300/#888] Toolbar: root-level create actions + manual refresh.
          Always rendered so the manual refresh button (Issue #888) is available
          even when no create callbacks are wired in. */}
      <div
        data-testid="file-tree-toolbar"
        className="flex items-center gap-1 p-1 border-b border-border"
      >
        {onNewFile && (
          /* Issue #1061: dense toolbar control — base padding/hover-lift would change the dense feel — 残置 */
          <button
            data-testid="toolbar-new-file-button"
            onClick={() => onNewFile('')}
            className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:bg-muted rounded transition-colors"
          >
            <FilePlus className="w-4 h-4" aria-hidden="true" />
            <span>New File</span>
          </button>
        )}
        {onNewDirectory && (
          /* Issue #1061: dense toolbar control — base padding/hover-lift would change the dense feel — 残置 */
          <button
            data-testid="toolbar-new-directory-button"
            onClick={() => onNewDirectory('')}
            className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:bg-muted rounded transition-colors"
          >
            <FolderPlus className="w-4 h-4" aria-hidden="true" />
            <span>New Directory</span>
          </button>
        )}
        {/* Right-aligned group: metadata toggle + refetch indicator + manual refresh button. */}
        <div className="ml-auto flex items-center gap-1">
          {/* [Issue #969] Toggle which metadata columns show inline per file row. */}
          <FileMetadataToggle settings={metadataDisplay} onToggle={toggleMetadata} />
          {/* [Issue #706] Compact refetch indicator. The tree DOM (and its
              scroll position) is preserved while a background refresh runs. */}
          {isRefetching && (
            <div
              data-testid="file-tree-refetch-indicator"
              role="status"
              aria-live="polite"
              className="flex items-center gap-1 text-xs text-muted-foreground"
            >
              <span
                aria-hidden="true"
                className="w-3 h-3 border-2 border-input border-t-cyan-500 rounded-full animate-spin"
              />
              <span className="sr-only">Refreshing files</span>
            </div>
          )}
          {/* [Issue #888] Manual refresh: re-fetch the root + all expanded
              directories on demand (preserves scroll/selection/expansion). */}
          {/* Issue #1061: dense toolbar icon control — base padding/hover-lift would change the dense feel — 残置 */}
          <button
            data-testid="file-tree-refresh-button"
            type="button"
            onClick={() => {
              void reloadTreeWithExpandedDirs();
            }}
            disabled={isRefetching}
            aria-label="Refresh file tree"
            title="更新"
            className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:bg-muted rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw
              className={`w-4 h-4 ${isRefetching ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
      {/* [Issue #706] Non-destructive refetch error banner. The previous
          tree DOM remains mounted, so we surface the error inline with a
          retry action instead of replacing the whole view. */}
      {isRefetchError && (
        <div
          data-testid="file-tree-refetch-error"
          role="alert"
          className="flex items-center gap-2 px-2 py-1 text-xs bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800 text-red-700 dark:text-red-300"
        >
          <AlertCircle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
          <span className="flex-1 truncate">{error}</span>
          <Button
            variant="ghost"
            data-testid="file-tree-refetch-retry-button"
            onClick={() => {
              void reloadTreeWithExpandedDirs();
            }}
            className="px-2 py-0.5 text-xs rounded border border-red-300 dark:border-red-700 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
          >
            再試行
          </Button>
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
          metadataDisplay={metadataDisplay}
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
