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
 */

'use client';

import React, { useState, useEffect, useCallback, memo, useMemo } from 'react';
import type { TreeItem, TreeResponse } from '@/types/models';
import { useContextMenu } from '@/hooks/useContextMenu';
import { ContextMenu } from '@/components/worktree/ContextMenu';

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
  /** Additional CSS classes */
  className?: string;
  /** Trigger to refresh the tree (increment to refresh) */
  refreshTrigger?: number;
}

interface TreeNodeProps {
  item: TreeItem;
  path: string;
  depth: number;
  worktreeId: string;
  expanded: Set<string>;
  cache: Map<string, TreeItem[]>;
  onToggle: (path: string) => void;
  onFileSelect?: (filePath: string) => void;
  onLoadChildren: (path: string) => Promise<void>;
  onContextMenu?: (e: React.MouseEvent, path: string, type: 'file' | 'directory') => void;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format file size for display
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

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      onContextMenu?.(e, fullPath, isDirectory ? 'directory' : 'file');
    },
    [fullPath, isDirectory, onContextMenu]
  );

  const indentStyle = getIndentStyle(depth);

  return (
    <>
      <div
        data-testid={`tree-item-${item.name}`}
        role="treeitem"
        aria-selected={false}
        aria-expanded={isDirectory ? isExpanded : undefined}
        tabIndex={0}
        className="flex items-center gap-2 py-1.5 pr-2 cursor-pointer hover:bg-gray-100 rounded transition-colors"
        style={indentStyle}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
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

        {/* Name */}
        <span className="flex-1 truncate text-sm text-gray-700">{item.name}</span>

        {/* File size or item count */}
        <span className="text-xs text-gray-400 flex-shrink-0">
          {isDirectory
            ? item.itemCount !== undefined && `${item.itemCount} items`
            : formatFileSize(item.size)}
        </span>
      </div>

      {/* Children */}
      {isDirectory && isExpanded && children && (
        <div role="group">
          {children.map((child) => (
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
  className = '',
  refreshTrigger = 0,
}: FileTreeViewProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rootItems, setRootItems] = useState<TreeItem[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [cache, setCache] = useState<Map<string, TreeItem[]>>(() => new Map());

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
   * Load root directory on mount or when refreshTrigger changes
   */
  useEffect(() => {
    let mounted = true;

    const loadRoot = async () => {
      setLoading(true);
      setError(null);
      // Clear cache on refresh to ensure fresh data
      setCache(new Map());

      try {
        const data = await fetchDirectory();
        if (mounted && data) {
          setRootItems(data.items);
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

    loadRoot();

    return () => {
      mounted = false;
    };
  }, [fetchDirectory, refreshTrigger]);

  /**
   * Load children for a directory
   */
  const loadChildren = useCallback(
    async (path: string) => {
      // Check cache first
      if (cache.has(path)) {
        return;
      }

      try {
        const data = await fetchDirectory(path);
        if (data) {
          cache.set(path, data.items);
        }
      } catch (err) {
        console.error('[FileTreeView] Error loading children:', err);
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
      {rootItems.map((item) => (
        <TreeNode
          key={item.name}
          item={item}
          path=""
          depth={0}
          worktreeId={worktreeId}
          expanded={expanded}
          cache={cache}
          onToggle={handleToggle}
          onFileSelect={onFileSelect}
          onLoadChildren={loadChildren}
          onContextMenu={openMenu}
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
      />
    </div>
  );
});

export default FileTreeView;
