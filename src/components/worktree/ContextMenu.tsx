/**
 * ContextMenu Component
 *
 * Right-click context menu for FileTreeView operations.
 * Supports file/directory creation, rename, and delete.
 *
 * Features:
 * - Different menu items based on target type (file vs directory)
 * - Keyboard navigation
 * - Visual styling with danger indicators for destructive actions
 *
 * @module components/worktree/ContextMenu
 * @see Stage 2 SF-003 - Component separation
 */

'use client';

import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'next-intl';
import { FilePlus, FolderPlus, Pencil, Trash2, Upload, FolderInput } from 'lucide-react';
import { Z_INDEX } from '@/config/z-index';
import { CONTEXT_MENU_EXIT_DURATION_MS } from '@/config/ui-feedback-config';
import { useExitAnimation } from '@/hooks/useExitAnimation';

/**
 * Props for ContextMenu component
 * [CONS-004] onUpload callback added for file upload support
 */
export interface ContextMenuProps {
  /** Whether the menu is open */
  isOpen: boolean;
  /** Menu position */
  position: { x: number; y: number };
  /** Target file/directory path */
  targetPath: string | null;
  /** Target type */
  targetType: 'file' | 'directory' | null;
  /** Close menu callback */
  onClose: () => void;
  /** Create new file callback */
  onNewFile?: (parentPath: string) => void;
  /** Create new directory callback */
  onNewDirectory?: (parentPath: string) => void;
  /** Rename callback */
  onRename?: (path: string) => void;
  /** Delete callback */
  onDelete?: (path: string) => void;
  /** Upload file callback [CONS-004] */
  onUpload?: (targetPath: string) => void;
  /** Move file/directory callback [Issue #162] */
  onMove?: (path: string, type: 'file' | 'directory') => void;
}

/** Gap kept between the menu and the viewport edge (px) */
const VIEWPORT_MARGIN_PX = 8;

/**
 * Keep one axis of the menu inside the viewport.
 *
 * [Issue #1362] The menu is `position: fixed` at the pointer, so a right-click
 * (or long press) near the right/bottom edge would otherwise place part of it
 * off screen with no way to scroll to it.
 *
 * @param start - Requested start offset (left or top) in px
 * @param size - Measured menu size on this axis in px
 * @param viewportSize - Viewport size on this axis in px
 * @returns Start offset clamped into the viewport
 */
function clampAxis(start: number, size: number, viewportSize: number): number {
  const maxStart = viewportSize - size - VIEWPORT_MARGIN_PX;
  // Menu taller/wider than the viewport: pin to the near edge so the first
  // items stay reachable rather than pushing the top-left off screen.
  if (maxStart < VIEWPORT_MARGIN_PX) return VIEWPORT_MARGIN_PX;
  return Math.min(Math.max(start, VIEWPORT_MARGIN_PX), maxStart);
}

/** Measured placement, tagged with the anchor it was measured for */
interface Placement {
  key: string;
  left: number;
  top: number;
}

/**
 * Menu item configuration
 */
interface MenuItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  variant?: 'default' | 'danger';
  showDividerAfter?: boolean;
  /** Show only for certain target types */
  showFor?: ('file' | 'directory')[];
}

/**
 * ContextMenu Component
 *
 * @example
 * ```tsx
 * <ContextMenu
 *   isOpen={menuState.isOpen}
 *   position={menuState.position}
 *   targetPath={menuState.targetPath}
 *   targetType={menuState.targetType}
 *   onClose={closeMenu}
 *   onNewFile={handleNewFile}
 *   onRename={handleRename}
 *   onDelete={handleDelete}
 * />
 * ```
 */
export const ContextMenu = memo(function ContextMenu({
  isOpen,
  position,
  targetPath,
  targetType,
  onClose,
  onNewFile,
  onNewDirectory,
  onRename,
  onDelete,
  onUpload,
  onMove,
}: ContextMenuProps) {
  const t = useTranslations('worktree');
  const menuRef = useRef<HTMLDivElement>(null);

  // [Issue #1114] Keep the menu mounted briefly after close so the fade-out
  // exit animation can play (matches the duration-100 enter animation).
  const { shouldRender, isExiting } = useExitAnimation(
    isOpen,
    CONTEXT_MENU_EXIT_DURATION_MS
  );

  // [Issue #1362] Placement measured for the current anchor. The item set
  // depends on targetType, so the size must be re-measured when it changes.
  const placementKey = `${position.x}:${position.y}:${targetType}`;
  const [placement, setPlacement] = useState<Placement | null>(null);
  const placed = placement?.key === placementKey ? placement : null;

  /**
   * [Issue #1362] Measure the menu and clamp it into the viewport.
   *
   * Runs before paint, so the pre-measure render at the origin is never
   * visible. Measuring at (0, 0) rather than at the anchor is deliberate: a
   * fixed box shrinks to the space left of the viewport edge, so measuring it
   * near the edge would report a narrower menu than it actually needs.
   */
  useLayoutEffect(() => {
    if (!isOpen) return;
    const el = menuRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    setPlacement({
      key: placementKey,
      left: clampAxis(position.x, rect.width, window.innerWidth),
      top: clampAxis(position.y, rect.height, window.innerHeight),
    });
  }, [isOpen, placementKey, position.x, position.y]);

  /**
   * Handle menu item click
   */
  const handleItemClick = useCallback(
    (handler?: (path: string) => void) => {
      if (handler && targetPath) {
        handler(targetPath);
      }
      onClose();
    },
    [targetPath, onClose]
  );

  /**
   * Build menu items based on target type
   */
  const menuItems: MenuItem[] = [
    {
      id: 'new-file',
      // Issue #1277: reuses the existing fileTree.* entries (same wording as the
      // file tree's own New File / New Directory affordances).
      label: t('fileTree.newFile'),
      icon: <FilePlus className="w-4 h-4" aria-hidden="true" role="img" />,
      onClick: () => handleItemClick(onNewFile),
      showFor: ['directory'],
    },
    {
      id: 'new-directory',
      label: t('fileTree.newDirectory'),
      icon: <FolderPlus className="w-4 h-4" aria-hidden="true" role="img" />,
      onClick: () => handleItemClick(onNewDirectory),
      showFor: ['directory'],
    },
    {
      id: 'upload',
      label: t('contextMenu.uploadFile'),
      icon: <Upload className="w-4 h-4" aria-hidden="true" role="img" />,
      onClick: () => handleItemClick(onUpload),
      showFor: ['directory'],
      showDividerAfter: true,
    },
    {
      id: 'rename',
      label: t('contextMenu.rename'),
      icon: <Pencil className="w-4 h-4" aria-hidden="true" role="img" />,
      onClick: () => handleItemClick(onRename),
    },
    {
      id: 'move',
      label: t('contextMenu.move'),
      icon: <FolderInput className="w-4 h-4" aria-hidden="true" role="img" />,
      onClick: () => {
        if (onMove && targetPath && targetType) {
          onMove(targetPath, targetType);
        }
        onClose();
      },
      showDividerAfter: true,
    },
    {
      id: 'delete',
      label: t('contextMenu.delete'),
      icon: <Trash2 className="w-4 h-4" aria-hidden="true" role="img" />,
      onClick: () => handleItemClick(onDelete),
      variant: 'danger',
    },
  ];

  /**
   * Filter items based on target type
   */
  const visibleItems = menuItems.filter((item) => {
    if (!item.showFor) return true;
    return targetType && item.showFor.includes(targetType);
  });

  /**
   * Handle keyboard navigation
   */
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = menuRef.current?.querySelectorAll('[role="menuitem"]');
        if (!items?.length) return;

        const currentIndex = Array.from(items).findIndex(
          (item) => item === document.activeElement
        );

        let nextIndex: number;
        if (e.key === 'ArrowDown') {
          nextIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
        } else {
          nextIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
        }

        (items[nextIndex] as HTMLElement).focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  /**
   * Focus first item when menu opens
   */
  useEffect(() => {
    if (isOpen && menuRef.current) {
      const firstItem = menuRef.current.querySelector('[role="menuitem"]');
      if (firstItem) {
        (firstItem as HTMLElement).focus();
      }
    }
  }, [isOpen]);

  if (!shouldRender) {
    return null;
  }

  // [Issue #1114] Swap enter/exit animation classes; pointer-events-none
  // keeps a dismissing menu from swallowing clicks during the exit window.
  const animationClasses = isExiting
    ? 'animate-out fade-out-0 zoom-out-95 duration-100 fill-mode-forwards pointer-events-none'
    : 'animate-in fade-in-0 zoom-in-95 duration-100';

  return (
    <div
      ref={menuRef}
      data-testid="context-menu"
      role="menu"
      aria-label={t('contextMenu.label')}
      className={`fixed min-w-[160px] py-1 bg-surface rounded-lg shadow-lg border border-border ${animationClasses}`}
      style={{
        zIndex: Z_INDEX.CONTEXT_MENU,
        // [Issue #1362] Before the measure pass completes the menu sits at the
        // origin; useLayoutEffect moves it to the clamped anchor before paint.
        left: `${placed ? placed.left : 0}px`,
        top: `${placed ? placed.top : 0}px`,
      }}
    >
      {visibleItems.map((item, index) => (
        <React.Fragment key={item.id}>
          <button
            role="menuitem"
            // Issue #1277: locale-stable hook for e2e. The visible label is
            // translated, so text selectors would break under a non-en locale.
            data-testid={`context-menu-${item.id}`}
            onClick={item.onClick}
            disabled={!targetPath}
            className={`w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors focus:outline-none focus:bg-muted ${
              item.variant === 'danger'
                ? 'text-danger hover:bg-danger-subtle focus:bg-danger-subtle'
                : 'text-foreground hover:bg-muted'
            } ${!targetPath ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
          {item.showDividerAfter && index < visibleItems.length - 1 && (
            <div
              data-testid="context-menu-divider"
              className="my-1 border-t border-border"
            />
          )}
        </React.Fragment>
      ))}
    </div>
  );
});

export default ContextMenu;
