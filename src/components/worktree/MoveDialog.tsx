/**
 * MoveDialog Component [Issue #162]
 *
 * Dialog for selecting a destination directory when moving files/directories.
 * Uses existing Modal component and tree API for directory browsing.
 *
 * [SOLID-SRP] Focused solely on destination directory selection
 * [KISS] Reuses existing Modal component
 * [SF-002] Client-side filtering (directories only)
 * [CO-003] sourceType maintained for validation and display purposes
 */

'use client';

import React, { useState, useEffect, useCallback, memo } from 'react';
import { Modal } from '@/components/ui/Modal';
import { useTranslations } from 'next-intl';
import type { TreeItem } from '@/types/models';
import { ChevronRight, Folder, FolderOpen, Loader2 } from 'lucide-react';

/**
 * Recursively update a directory tree node's children.
 * Used when subdirectory contents are loaded lazily from the API.
 *
 * @param nodes - Current tree nodes
 * @param targetPath - Path of the node to update
 * @param children - New children to set on the target node
 * @returns Updated tree with the target node's children replaced
 */
function updateTreeNode(
  nodes: DirectoryNode[],
  targetPath: string,
  children: DirectoryNode[]
): DirectoryNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) {
      return { ...node, children, loaded: true };
    }
    if (node.children) {
      return { ...node, children: updateTreeNode(node.children, targetPath, children) };
    }
    return node;
  });
}

/**
 * Recursively search for a node by path in the directory tree.
 * [SRP] Extracted from handleToggleDir for reuse and testability.
 *
 * @param nodes - Tree nodes to search
 * @param path - Path to find
 * @returns The matching node, or null if not found
 */
function findNodeByPath(nodes: DirectoryNode[], path: string): DirectoryNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNodeByPath(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

export interface MoveDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (destinationDir: string) => void;
  worktreeId: string;
  sourcePath: string;
  sourceType: 'file' | 'directory';
}

interface DirectoryNode {
  name: string;
  path: string;
  children?: DirectoryNode[];
  loading?: boolean;
  loaded?: boolean;
}

export const MoveDialog = memo(function MoveDialog({
  isOpen,
  onClose,
  onConfirm,
  worktreeId,
  sourcePath,
  sourceType,
}: MoveDialogProps) {
  const t = useTranslations('worktree');
  const tCommon = useTranslations('common');
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set(['']));
  const [directoryTree, setDirectoryTree] = useState<DirectoryNode[]>([]);
  const [rootLoading, setRootLoading] = useState(false);
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());

  // Get the parent directory of the source (default selection)
  const sourceParent = sourcePath.includes('/')
    ? sourcePath.substring(0, sourcePath.lastIndexOf('/'))
    : '';

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setSelectedPath(sourceParent);
      setExpandedDirs(new Set(['']));
      setDirectoryTree([]);
      loadRootDirectories();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, worktreeId]);

  const loadRootDirectories = useCallback(async () => {
    setRootLoading(true);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/tree`);
      if (!response.ok) return;
      const data = await response.json();
      const dirs = (data.items as TreeItem[])
        .filter((item) => item.type === 'directory')
        .map((item) => ({
          name: item.name,
          path: item.name,
          loaded: false,
        }));
      setDirectoryTree(dirs);
    } catch {
      // Silently handle errors
    } finally {
      setRootLoading(false);
    }
  }, [worktreeId]);

  const loadSubdirectories = useCallback(async (dirPath: string) => {
    setLoadingDirs((prev) => new Set(prev).add(dirPath));
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/tree/${dirPath}`);
      if (!response.ok) return;
      const data = await response.json();
      const dirs = (data.items as TreeItem[])
        .filter((item) => item.type === 'directory')
        .map((item) => ({
          name: item.name,
          path: `${dirPath}/${item.name}`,
          loaded: false,
        }));

      setDirectoryTree((prev) => updateTreeNode(prev, dirPath, dirs));
    } catch {
      // Silently handle errors
    } finally {
      setLoadingDirs((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  }, [worktreeId]);

  const handleToggleDir = useCallback(async (dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });

    // Load subdirectories if not already loaded
    const node = findNodeByPath(directoryTree, dirPath);
    if (node && !node.loaded) {
      await loadSubdirectories(dirPath);
    }
  }, [directoryTree, loadSubdirectories]);

  const isValidDestination = useCallback((dirPath: string): boolean => {
    // Cannot move to the same parent directory
    if (dirPath === sourceParent) return false;

    // For directories: cannot move into self or children
    if (sourceType === 'directory') {
      if (dirPath === sourcePath) return false;
      if (dirPath.startsWith(sourcePath + '/')) return false;
    }

    return true;
  }, [sourceParent, sourcePath, sourceType]);

  const renderDirectoryNode = (node: DirectoryNode, depth: number = 0): React.ReactNode => {
    const isExpanded = expandedDirs.has(node.path);
    const isSelected = selectedPath === node.path;
    const isLoading = loadingDirs.has(node.path);
    const isValid = isValidDestination(node.path);

    return (
      <div key={node.path}>
        <div
          className={`flex items-center gap-1 py-1.5 px-2 cursor-pointer rounded text-sm transition-colors ${
            isSelected ? 'bg-blue-100 text-blue-800' : 'hover:bg-gray-100 text-gray-700'
          } ${!isValid ? 'opacity-40 cursor-not-allowed' : ''}`}
          style={{ paddingLeft: `${0.5 + depth * 1.25}rem` }}
          onClick={() => {
            if (isValid) {
              setSelectedPath(node.path);
            }
          }}
        >
          <button
            className="w-4 h-4 flex items-center justify-center flex-shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              handleToggleDir(node.path);
            }}
          >
            {isLoading ? (
              <Loader2 className="w-3 h-3 animate-spin text-gray-400" />
            ) : (
              <ChevronRight
                className={`w-3 h-3 text-gray-400 transition-transform ${
                  isExpanded ? 'rotate-90' : ''
                }`}
              />
            )}
          </button>
          {isExpanded ? (
            <FolderOpen className="w-4 h-4 text-yellow-500 flex-shrink-0" />
          ) : (
            <Folder className="w-4 h-4 text-yellow-500 flex-shrink-0" />
          )}
          <span className="truncate">{node.name}</span>
        </div>
        {isExpanded && node.children && (
          <div>
            {node.children.map((child) => renderDirectoryNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const canConfirm = isValidDestination(selectedPath);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('fileTree.moveDialogTitle')} size="md">
      <div className="flex flex-col gap-4">
        {/* Source info */}
        <div className="text-sm text-gray-600">
          {t('fileTree.moveTo')}: <span className="font-mono text-gray-800">{sourcePath}</span>
        </div>

        {/* Directory tree */}
        <div className="border border-gray-200 rounded-lg max-h-64 overflow-y-auto p-2">
          {/* Root directory option */}
          <div
            className={`flex items-center gap-1 py-1.5 px-2 cursor-pointer rounded text-sm transition-colors ${
              selectedPath === '' ? 'bg-blue-100 text-blue-800' : 'hover:bg-gray-100 text-gray-700'
            } ${!isValidDestination('') ? 'opacity-40 cursor-not-allowed' : ''}`}
            onClick={() => {
              if (isValidDestination('')) {
                setSelectedPath('');
              }
            }}
          >
            <span className="w-4 h-4" />
            <Folder className="w-4 h-4 text-yellow-500 flex-shrink-0" />
            <span>{t('fileTree.rootDirectory')}</span>
          </div>

          {rootLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
            </div>
          ) : (
            directoryTree.map((node) => renderDirectoryNode(node, 1))
          )}
        </div>

        {/* Action buttons */}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
          >
            {tCommon('cancel')}
          </button>
          <button
            onClick={() => onConfirm(selectedPath)}
            disabled={!canConfirm}
            className="px-4 py-2 text-sm text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('fileTree.moveConfirm')}
          </button>
        </div>
      </div>
    </Modal>
  );
});

export default MoveDialog;
