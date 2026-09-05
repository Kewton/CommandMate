/**
 * FilePanelTabs Component
 *
 * Tab bar with close buttons and content area for the file panel.
 * Displays the active tab's content via FilePanelContent.
 *
 * Issue #438: PC file display panel with tabs
 * Issue #469: isDirty indicator for unsaved edits
 * Issue #505: Dropdown for 6+ tabs, onMoveToFront, onOpenFile passthrough
 * Issue #1365: Overflow dropdown clamped to the viewport
 * Issue #2260: bulk close menu, tab right-click / middle-click, unsaved guard
 */

'use client';

import React, { memo, useCallback, useMemo, useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { X, XSquare, ListX, ChevronsRight, ChevronDown, MoreHorizontal } from 'lucide-react';
import { FilePanelContent } from './FilePanelContent';
import { ContextMenu, type ContextMenuItemSpec } from './ContextMenu';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useContextMenu } from '@/hooks/useContextMenu';
import { selectTabsToClose } from '@/hooks/useFileTabs';
import type { BulkCloseMode, FileTab } from '@/hooks/useFileTabs';
import type { FileContent } from '@/types/models';

// ============================================================================
// Constants
// ============================================================================

/** Number of tabs shown in the tab bar before overflow into dropdown */
const VISIBLE_TAB_COUNT = 5;

/** Space (px) kept between the overflow dropdown and the viewport edge. [Issue #1365] */
const VIEWPORT_MARGIN = 8;

/**
 * Offset needed to pull a `[start, start + size]` span back inside a viewport
 * of `viewport` px on one axis, keeping `VIEWPORT_MARGIN` clear at both ends.
 * Returns 0 when the span already fits. A span longer than the viewport is
 * never pushed past the leading margin, so its head stays visible.
 * `size <= 0` means the element has not been laid out — nothing to correct.
 */
function clampShift(start: number, size: number, viewport: number): number {
  if (size <= 0 || viewport <= 0) return 0;
  const overflow = start + size + VIEWPORT_MARGIN - viewport;
  if (overflow > 0) return -Math.min(overflow, Math.max(0, start - VIEWPORT_MARGIN));
  if (start < VIEWPORT_MARGIN) return VIEWPORT_MARGIN - start;
  return 0;
}

// ============================================================================
// Types
// ============================================================================

export interface FilePanelTabsProps {
  /** Array of open file tabs */
  tabs: FileTab[];
  /** Index of the currently active tab */
  activeIndex: number | null;
  /** Worktree ID for API calls */
  worktreeId: string;
  /** Callback when a tab is closed */
  onClose: (path: string) => void;
  /** Callback when a tab is activated */
  onActivate: (path: string) => void;
  /** Callback when content is loaded */
  onLoadContent: (path: string, content: FileContent) => void;
  /** Callback when loading fails */
  onLoadError: (path: string, error: string) => void;
  /** Callback to set loading state */
  onSetLoading: (path: string, loading: boolean) => void;
  /** Callback when file is saved (refresh tree) */
  onFileSaved?: (path: string) => void;
  /** Callback when isDirty state changes (Issue #469) */
  onDirtyChange?: (path: string, isDirty: boolean) => void;
  /** Callback to move a tab to front (Issue #505, DR1-009) */
  onMoveToFront?: (path: string) => void;
  /** Callback to open a file from a link (Issue #505, DR2-009 passthrough) */
  onOpenFile?: (path: string) => void;
}

// ============================================================================
// Tab Button Sub-component
// ============================================================================

const TabButton = memo(function TabButton({
  tab,
  isActive,
  onActivate,
  onClose,
  onOpenMenu,
}: {
  tab: FileTab;
  isActive: boolean;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  /** Open the bulk-close menu anchored at this tab [Issue #2260] */
  onOpenMenu: (e: React.MouseEvent, path: string) => void;
}) {
  const t = useTranslations('worktree');

  const handleClick = useCallback(() => {
    if (!isActive) {
      onActivate(tab.path);
    }
  }, [isActive, onActivate, tab.path]);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose(tab.path);
    },
    [onClose, tab.path],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      onOpenMenu(e, tab.path);
    },
    [onOpenMenu, tab.path],
  );

  // [Issue #2260] Middle click closes the tab, matching browser tab bars.
  // `auxclick` also fires for the secondary button, so the button check is what
  // keeps a right-click from closing the tab it just opened the menu on.
  const handleAuxClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      onClose(tab.path);
    },
    [onClose, tab.path],
  );

  const activeClasses = isActive
    ? 'border-accent-500 text-accent-600 dark:text-accent-400 bg-surface'
    : 'border-transparent text-muted-foreground hover:text-foreground';

  return (
    <div
      data-testid={`file-tab-${tab.path}`}
      data-active={isActive}
      onClick={handleClick}
      onAuxClick={handleAuxClick}
      onContextMenu={handleContextMenu}
      className={`flex items-center gap-1 px-3 py-2 text-sm font-medium border-b-2 cursor-pointer flex-shrink-0 ${activeClasses}`}
    >
      <span className="truncate max-w-[120px]" title={tab.path}>
        {tab.name}
      </span>
      {/* [Issue #469] Unsaved changes indicator */}
      {tab.isDirty && (
        <span
          data-testid={`file-tab-dirty-${tab.path}`}
          className="w-2 h-2 rounded-full bg-warning flex-shrink-0"
          title={t('fileTabs.unsavedChanges')}
        />
      )}
      <button
        type="button"
        onClick={handleClose}
        className="ml-1 p-0.5 rounded-sm hover:bg-muted transition-colors"
        aria-label={t('fileTabs.closeTab', { name: tab.name })}
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
});

// ============================================================================
// Main Component
// ============================================================================

/**
 * FilePanelTabs - Tab bar and content area for the file panel.
 *
 * Shows first 5 tabs in the tab bar. When 6+ tabs are open, additional
 * tabs are accessible via a dropdown menu. Dropdown selection dispatches
 * MOVE_TO_FRONT to bring the selected tab to the front. [DR1-008, DR1-009]
 *
 * [Issue #2260] The "⋯" button at the right end of the bar, and a right-click
 * on any tab, open the same bulk-close menu (all / others / to the right); a
 * middle click closes the tab under the pointer. When the set being closed
 * holds unsaved edits the commands route through a confirmation offering
 * "keep unsaved" / "close them anyway" / "cancel".
 */
export const FilePanelTabs = memo(function FilePanelTabs({
  tabs,
  activeIndex,
  worktreeId,
  onClose,
  onActivate,
  onLoadContent,
  onLoadError,
  onSetLoading,
  onFileSaved,
  onDirtyChange,
  onMoveToFront,
  onOpenFile,
}: FilePanelTabsProps) {
  const t = useTranslations('worktree');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const shiftRef = useRef({ x: 0, y: 0 });
  const [shift, setShift] = useState({ x: 0, y: 0 });

  // [Issue #2260] Bulk-close menu (shared by the "⋯" button and tab right-click)
  // and the pending command awaiting confirmation because it would discard
  // unsaved edits.
  const { menuState, openMenu, openMenuAt, closeMenu } = useContextMenu();
  const [pendingClose, setPendingClose] = useState<
    { mode: BulkCloseMode; anchorPath: string } | null
  >(null);

  const activeTab = activeIndex !== null && activeIndex >= 0 && activeIndex < tabs.length
    ? tabs[activeIndex]
    : null;

  const visibleTabs = tabs.length > VISIBLE_TAB_COUNT ? tabs.slice(0, VISIBLE_TAB_COUNT) : tabs;
  const overflowTabs = tabs.length > VISIBLE_TAB_COUNT ? tabs.slice(VISIBLE_TAB_COUNT) : [];

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!dropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [dropdownOpen]);

  // Keep the overflow dropdown inside the viewport. It stays absolutely
  // positioned rather than portalled, because the click-outside handler above
  // asks whether the click landed inside `dropdownRef`. [Issue #1365]
  useLayoutEffect(() => {
    const applyShift = (next: { x: number; y: number }): void => {
      shiftRef.current = next;
      setShift((prev) => (prev.x === next.x && prev.y === next.y ? prev : next));
    };
    if (!dropdownOpen) {
      applyShift({ x: 0, y: 0 });
      return;
    }
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Subtract the shift already applied so the measurement describes the
    // dropdown's uncorrected position and re-running stays idempotent.
    applyShift({
      x: clampShift(rect.left - shiftRef.current.x, rect.width, window.innerWidth),
      y: clampShift(rect.top - shiftRef.current.y, rect.height, window.innerHeight),
    });
  }, [dropdownOpen]);

  const handleDropdownSelect = useCallback((path: string) => {
    setDropdownOpen(false);
    onMoveToFront?.(path);
  }, [onMoveToFront]);

  const handleDropdownToggle = useCallback(() => {
    setDropdownOpen(prev => !prev);
  }, []);

  /**
   * [Issue #2260] Close `paths` right to left.
   *
   * Each close recomputes `activeIndex` against the tabs still open, so
   * removing the rightmost first walks the selection back onto the anchor —
   * the same tab the batched CLOSE_OTHERS / CLOSE_TO_RIGHT reducer cases leave
   * active. Closing left to right would instead drag the selection rightwards
   * through tabs that are about to disappear.
   */
  const closePaths = useCallback(
    (paths: string[]) => {
      for (let i = paths.length - 1; i >= 0; i--) {
        onClose(paths[i]);
      }
    },
    [onClose],
  );

  /**
   * [Issue #2260] Run a bulk-close command, or park it behind the confirmation
   * when the selection holds unsaved edits. `isDirty` is read off the reducer
   * state handed down as `tabs`, which is where the editor's onDirtyChange
   * lands — not off any local copy.
   */
  const requestBulkClose = useCallback(
    (mode: BulkCloseMode, anchorPath: string) => {
      const paths = selectTabsToClose(tabs, anchorPath, mode);
      if (paths.length === 0) return;
      const closing = new Set(paths);
      if (tabs.some((tab) => tab.isDirty && closing.has(tab.path))) {
        setPendingClose({ mode, anchorPath });
        return;
      }
      closePaths(paths);
    },
    [tabs, closePaths],
  );

  const menuAnchorPath = menuState.targetPath;

  const menuItems = useMemo<ContextMenuItemSpec[]>(() => {
    if (!menuAnchorPath) return [];
    return [
      {
        id: 'close-all-tabs',
        label: t('fileTabs.closeAll'),
        icon: <XSquare className="w-4 h-4" aria-hidden="true" role="img" />,
        onSelect: () => requestBulkClose('all', menuAnchorPath),
        disabled: tabs.length === 0,
      },
      {
        id: 'close-other-tabs',
        label: t('fileTabs.closeOthers'),
        icon: <ListX className="w-4 h-4" aria-hidden="true" role="img" />,
        onSelect: () => requestBulkClose('others', menuAnchorPath),
        disabled: selectTabsToClose(tabs, menuAnchorPath, 'others').length === 0,
      },
      {
        id: 'close-tabs-to-right',
        label: t('fileTabs.closeToRight'),
        icon: <ChevronsRight className="w-4 h-4" aria-hidden="true" role="img" />,
        onSelect: () => requestBulkClose('right', menuAnchorPath),
        disabled: selectTabsToClose(tabs, menuAnchorPath, 'right').length === 0,
      },
    ];
  }, [menuAnchorPath, tabs, requestBulkClose, t]);

  const handleTabMenu = useCallback(
    (e: React.MouseEvent, path: string) => {
      openMenu(e, path, 'file');
    },
    [openMenu],
  );

  /**
   * [Issue #2260] The bar button's menu is anchored at the button's own box
   * rather than the pointer, because a keyboard activation (Enter / Space)
   * reports clientX/clientY of 0 and would drop the menu in the page corner.
   * Its anchor tab is the active one, so "close others" / "close to the right"
   * read the same way as they do from a right-click on that tab.
   */
  const barAnchorPath = activeTab?.path ?? tabs[0]?.path ?? null;
  const handleBarMenu = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (!barAnchorPath) return;
      const rect = e.currentTarget.getBoundingClientRect();
      openMenuAt({ x: rect.left, y: rect.bottom }, barAnchorPath, 'file');
    },
    [barAnchorPath, openMenuAt],
  );

  // Confirmation is recomputed from live state so a save landing while the
  // dialog is open shrinks the warning instead of closing a clean tab twice.
  const pendingPaths = pendingClose
    ? selectTabsToClose(tabs, pendingClose.anchorPath, pendingClose.mode)
    : [];
  const pendingDirtyPaths = pendingPaths.filter(
    (path) => tabs.find((tab) => tab.path === path)?.isDirty,
  );

  const cancelPendingClose = useCallback(() => setPendingClose(null), []);

  const keepUnsavedAndClose = (): void => {
    const dirty = new Set(pendingDirtyPaths);
    closePaths(pendingPaths.filter((path) => !dirty.has(path)));
    setPendingClose(null);
  };

  const discardUnsavedAndClose = (): void => {
    closePaths(pendingPaths);
    setPendingClose(null);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex border-b border-border bg-surface dark:bg-surface-2 min-w-0">
        <div className="flex min-w-0 overflow-hidden flex-1">
          {visibleTabs.map((tab, index) => (
            <TabButton
              key={tab.path}
              tab={tab}
              isActive={index === activeIndex}
              onActivate={onActivate}
              onClose={onClose}
              onOpenMenu={handleTabMenu}
            />
          ))}
        </div>
        {/* Dropdown button for overflow tabs [DR1-008] */}
        {overflowTabs.length > 0 && (
          <div className="relative flex-shrink-0" ref={dropdownRef}>
            <button
              type="button"
              data-testid="tab-dropdown-button"
              onClick={handleDropdownToggle}
              className="flex items-center gap-0.5 px-2 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted border-b-2 border-transparent transition-colors"
            >
              <ChevronDown className={`w-3 h-3 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
              <span>+{overflowTabs.length}</span>
            </button>
            {dropdownOpen && (
              <div
                ref={menuRef}
                data-testid="tab-dropdown-menu"
                className="absolute right-0 top-full mt-1 bg-surface border border-border rounded-md shadow-lg z-50 min-w-[200px] max-h-[300px] overflow-y-auto"
                style={
                  shift.x !== 0 || shift.y !== 0
                    ? { transform: `translate(${shift.x}px, ${shift.y}px)` }
                    : undefined
                }
              >
                {overflowTabs.map(tab => (
                  <button
                    key={tab.path}
                    type="button"
                    data-testid={`tab-dropdown-item-${tab.path}`}
                    onClick={() => handleDropdownSelect(tab.path)}
                    className="w-full text-left px-3 py-2 text-sm text-foreground hover:bg-muted truncate"
                    title={tab.path}
                  >
                    {tab.name}
                    {tab.isDirty && (
                      <span className="ml-1 w-2 h-2 inline-block rounded-full bg-warning" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {/* [Issue #2260] Bulk-close menu trigger. Always rendered rather than
            revealed on hover: a hover-reveal control is invisible on touch. */}
        {tabs.length > 0 && (
          <button
            type="button"
            data-testid="tab-actions-button"
            onClick={handleBarMenu}
            aria-haspopup="menu"
            aria-expanded={menuState.isOpen}
            aria-label={t('fileTabs.tabActions')}
            title={t('fileTabs.tabActions')}
            className="flex-shrink-0 flex items-center px-2 py-2 text-muted-foreground hover:text-foreground hover:bg-muted border-b-2 border-transparent transition-colors"
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* [Issue #2260] Bulk-close menu, shared by the bar button and right-click */}
      <ContextMenu
        isOpen={menuState.isOpen}
        position={menuState.position}
        targetPath={menuState.targetPath}
        targetType={menuState.targetType}
        onClose={closeMenu}
        items={menuItems}
        ariaLabel={t('fileTabs.tabActions')}
      />

      {/* [Issue #2260] Unsaved-changes guard. Modal owns the focus trap. */}
      <Modal
        isOpen={pendingClose !== null}
        onClose={cancelPendingClose}
        title={t('fileTabs.confirmCloseTitle')}
        size="sm"
      >
        <p data-testid="file-tabs-close-confirm-body" className="text-sm text-foreground">
          {t('fileTabs.confirmCloseBody', { count: pendingDirtyPaths.length })}
        </p>
        <ul className="mt-2 max-h-32 overflow-y-auto text-sm text-muted-foreground">
          {pendingDirtyPaths.map((path) => (
            <li key={path} className="truncate" title={path}>
              {path}
            </li>
          ))}
        </ul>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            data-testid="file-tabs-close-cancel"
            onClick={cancelPendingClose}
          >
            {t('fileTabs.confirmCancel')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            data-testid="file-tabs-close-keep-unsaved"
            onClick={keepUnsavedAndClose}
          >
            {t('fileTabs.confirmKeepUnsaved')}
          </Button>
          <Button
            variant="danger"
            size="sm"
            data-testid="file-tabs-close-discard"
            onClick={discardUnsavedAndClose}
          >
            {t('fileTabs.confirmDiscard')}
          </Button>
        </div>
      </Modal>

      {/* Content area */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab && (
          <FilePanelContent
            key={activeTab.path}
            tab={activeTab}
            worktreeId={worktreeId}
            onLoadContent={onLoadContent}
            onLoadError={onLoadError}
            onSetLoading={onSetLoading}
            onFileSaved={onFileSaved}
            onDirtyChange={onDirtyChange}
            onOpenFile={onOpenFile}
          />
        )}
      </div>
    </div>
  );
});
