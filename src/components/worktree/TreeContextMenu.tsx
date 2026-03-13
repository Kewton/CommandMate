/**
 * TreeContextMenu Component
 * Issue #479: Created as part of FileTreeView.tsx split
 *
 * Re-exports the ContextMenu component for use with FileTreeView's tree nodes.
 * The actual context menu implementation is in ContextMenu.tsx.
 * This file exists for API consistency with the design document's split plan.
 */

export { ContextMenu as TreeContextMenu } from '@/components/worktree/ContextMenu';
export type { ContextMenuProps as TreeContextMenuProps } from '@/components/worktree/ContextMenu';
