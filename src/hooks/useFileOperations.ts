/**
 * useFileOperations - Custom hook for file operation handlers [MF-002]
 *
 * Manages move operation state and handlers to prevent
 * WorktreeDetailRefactored from growing too large.
 *
 * Phase 1 (Issue #162): handleMove only
 * Phase 2 (future): migrate handleNewFile, handleNewDirectory,
 *   handleRename, handleDelete, handleUpload
 *
 * @module hooks/useFileOperations
 */

'use client';

import { useState, useCallback } from 'react';

/**
 * Represents the target of a move operation.
 */
interface MoveTarget {
  /** Relative path of the file/directory to move */
  path: string;
  /** Whether the target is a file or directory */
  type: 'file' | 'directory';
}

/**
 * Return type for the useFileOperations hook.
 */
interface UseFileOperationsReturn {
  /** Current move target (null if no move in progress) */
  moveTarget: MoveTarget | null;
  /** Whether the move dialog is currently open */
  isMoveDialogOpen: boolean;
  /** Initiate a move operation (opens dialog) */
  handleMove: (path: string, type: 'file' | 'directory') => void;
  /** Confirm the move with a destination directory */
  handleMoveConfirm: (destinationDir: string) => Promise<void>;
  /** Cancel the move operation (closes dialog) */
  handleMoveCancel: () => void;
}

/**
 * Custom hook for file operations
 *
 * @param worktreeId - Target worktree ID
 * @param onRefresh - Callback to refresh the file tree after operations
 * @param onSuccess - Optional callback for success notification
 * @param onError - Optional callback for error notification
 */
export function useFileOperations(
  worktreeId: string,
  onRefresh: () => void,
  onSuccess?: (message: string) => void,
  onError?: (message: string) => void
): UseFileOperationsReturn {
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [isMoveDialogOpen, setIsMoveDialogOpen] = useState(false);

  const handleMove = useCallback((path: string, type: 'file' | 'directory') => {
    setMoveTarget({ path, type });
    setIsMoveDialogOpen(true);
  }, []);

  const handleMoveConfirm = useCallback(async (destinationDir: string) => {
    if (!moveTarget) return;

    try {
      const response = await fetch(
        `/api/worktrees/${worktreeId}/files/${moveTarget.path}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'move',
            destination: destinationDir,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok || !data.success) {
        const errorMessage = data.error?.message || 'Failed to move';
        onError?.(errorMessage);
        return;
      }

      onSuccess?.('Moved successfully');
      onRefresh();
    } catch {
      onError?.('Failed to move');
    } finally {
      setMoveTarget(null);
      setIsMoveDialogOpen(false);
    }
  }, [moveTarget, worktreeId, onRefresh, onSuccess, onError]);

  const handleMoveCancel = useCallback(() => {
    setMoveTarget(null);
    setIsMoveDialogOpen(false);
  }, []);

  return {
    moveTarget,
    isMoveDialogOpen,
    handleMove,
    handleMoveConfirm,
    handleMoveCancel,
  };
}
