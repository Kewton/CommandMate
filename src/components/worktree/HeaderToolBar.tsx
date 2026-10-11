/**
 * HeaderToolBar Component (Issue #3591)
 *
 * The worktree's tools (File Tree … Env) as icons at the right of the PC
 * worktree header. Replaces the vertical 48px `ActivityBar` column, so the
 * body gets that width back and the only vertical column left of it is the
 * app-wide icon rail. Same tools, same order, same panes: the Verification
 * pane is the one exception — its entry point is the Verification chip on the
 * second row (`HEADER_TOOLS` leaves it out).
 *
 * Behavior (unchanged from the bar):
 *   - Clicking an inactive icon switches to that activity.
 *   - Re-clicking the active icon toggles the pane closed.
 *
 * Narrow header: the trailing `foldedCount` tools leave the row for a "…"
 * button (the header's width fit, `useDesktopHeaderFit`, decides how many).
 * The folded tools are a list under "…", two clicks away. When the open tool
 * is one of them, "…" carries the active mark and says which tool is open.
 *
 * Keyboard:
 *   - The row is `role="tablist"` `aria-orientation="horizontal"` with a
 *     roving tabindex: Tab enters it on the open tool (or on "…" when that
 *     tool is folded, else on the first tool) and leaves it in one step.
 *   - ←/→ move between the tools and "…" (wrapping), Home/End go to the ends.
 *   - Enter/Space open/close the focused tool; on "…" they (or ↓) open the list.
 *   - The list is a vertical tablist: focus lands on the open tool (else the
 *     first), Tab and ↑/↓ move through it, Enter/Space pick a tool, Esc closes
 *     the list and hands focus back to "…".
 *   - Focus coming back when the pane closes is the caller's: each visible
 *     tool carries `data-activity-entry="<id>"`, and "…" is
 *     `data-testid="header-tool-more"` (see `WorktreeDetailDesktop`).
 */

'use client';

import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Ellipsis } from 'lucide-react';
import { HEADER_TOOLS, type ActivityId } from '@/config/activity-bar-config';
import { Tooltip } from '@/components/common/Tooltip';

export interface HeaderToolBarProps {
  /** Currently active activity, or null when the pane is closed. */
  active: ActivityId | null;
  /** Toggle an activity (re-clicking the active one closes it). */
  onToggle: (activity: ActivityId) => void;
  /**
   * How many tools, counted from the end, are folded behind "…". 0 draws them
   * all in the row. Clamped to the number of tools.
   */
  foldedCount?: number;
}

const TOOL_BAR_ID = 'worktree-header-tools';
const ACTIVITY_PANE_ID = 'worktree-activity-pane';
const OVERFLOW_LIST_ID = 'worktree-header-tools-more';

/** The pill inside each 32px button — the bar's #1079 active treatment. */
function pillClass(isActive: boolean): string {
  return `flex items-center justify-center h-7 w-7 rounded-md transition-colors ${
    isActive
      ? 'bg-accent-500/10 text-accent-600 dark:text-accent-400'
      : 'text-muted-foreground group-hover:text-surface-foreground group-hover:bg-muted-foreground/10'
  }`;
}

const BUTTON_CLASS =
  'group flex flex-shrink-0 items-center justify-center h-8 w-8 rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export const HeaderToolBar = memo(function HeaderToolBar({
  active,
  onToggle,
  foldedCount = 0,
}: HeaderToolBarProps) {
  const t = useTranslations('worktree');
  const folded = Math.max(0, Math.min(foldedCount, HEADER_TOOLS.length));
  const visibleTools = HEADER_TOOLS.slice(0, HEADER_TOOLS.length - folded);
  const foldedTools = HEADER_TOOLS.slice(HEADER_TOOLS.length - folded);
  const activeFolded = foldedTools.some((tool) => tool.id === active);
  const activeFoldedTool = foldedTools.find((tool) => tool.id === active);

  // The row's focusable items: the visible tools, then "…" when there is one.
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [listOpen, setListOpen] = useState(false);

  const rowCount = visibleTools.length + (folded > 0 ? 1 : 0);
  const focusRow = useCallback((index: number) => {
    const target = index < visibleTools.length ? rowRefs.current[index] : moreRef.current;
    target?.focus();
  }, [visibleTools.length]);

  // Roving tabindex: the open tool, or "…" holding it, or the first item.
  const activeVisibleIndex = visibleTools.findIndex((tool) => tool.id === active);
  const homeIndex = activeVisibleIndex !== -1 ? activeVisibleIndex : activeFolded ? visibleTools.length : 0;

  const handleRowKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (rowCount === 0) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        focusRow((index + 1) % rowCount);
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        focusRow((index - 1 + rowCount) % rowCount);
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        focusRow(0);
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        focusRow(rowCount - 1);
      }
    },
    [rowCount, focusRow]
  );

  const handleToolKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, index: number, activity: ActivityId) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onToggle(activity);
        return;
      }
      handleRowKeyDown(e, index);
    },
    [onToggle, handleRowKeyDown]
  );

  const closeList = useCallback((returnFocus: boolean) => {
    setListOpen(false);
    if (returnFocus) moreRef.current?.focus();
  }, []);

  const handleMoreKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        // ↓ only opens; Enter / Space toggle, like a click.
        const openOnly = e.key === 'ArrowDown';
        setListOpen((open) => openOnly || !open);
        return;
      }
      if (e.key === 'Escape' && listOpen) {
        // Ours, not the pane's (`usePaneOverlayDismiss` skips a handled Esc).
        e.preventDefault();
        closeList(true);
        return;
      }
      handleRowKeyDown(e, visibleTools.length);
    },
    [listOpen, closeList, handleRowKeyDown, visibleTools.length]
  );

  // Nothing left to fold (the header got wider): the list goes with "…".
  useEffect(() => {
    if (folded === 0) setListOpen(false);
  }, [folded]);

  // On opening, focus the open tool in the list, else its first tool.
  useEffect(() => {
    if (!listOpen) return;
    const list = listRef.current;
    if (!list) return;
    const selected = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    (selected ?? list.querySelector<HTMLElement>('[role="tab"]'))?.focus();
  }, [listOpen]);

  // A press outside the bar, or focus leaving it, closes the list.
  useEffect(() => {
    if (!listOpen) return undefined;
    const onPointerDown = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setListOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [listOpen]);

  const handleBlur = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget;
    if (next instanceof Node && rootRef.current?.contains(next)) return;
    if (next === null) return; // focus went nowhere (a click on a non-focusable spot)
    setListOpen(false);
  }, []);

  const pickFolded = useCallback(
    (activity: ActivityId) => {
      onToggle(activity);
      closeList(true);
    },
    [onToggle, closeList]
  );

  const handleListKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, index: number, activity: ActivityId) => {
      const items = listRef.current
        ? Array.from(listRef.current.querySelectorAll<HTMLElement>('[role="tab"]'))
        : [];
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pickFolded(activity);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeList(true);
        return;
      }
      if (items.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        items[(index + 1) % items.length]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items[(index - 1 + items.length) % items.length]?.focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        items[0]?.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        items[items.length - 1]?.focus();
      }
    },
    [pickFolded, closeList]
  );

  const moreLabel = activeFoldedTool
    ? t('headerTools.moreActive', { label: t(activeFoldedTool.labelKey) })
    : t('headerTools.more');

  return (
    <div
      ref={rootRef}
      data-testid="header-tool-bar"
      className="relative flex flex-shrink-0 items-center"
      onBlur={handleBlur}
    >
      <div
        id={TOOL_BAR_ID}
        role="tablist"
        aria-orientation="horizontal"
        aria-label={t('headerTools.label')}
        className="flex items-center"
      >
        {visibleTools.map((tool, index) => {
          const Icon = tool.icon;
          const isActive = active === tool.id;
          // Issue #1277: ACTIVITIES stores a translation key.
          const label = t(tool.labelKey);
          return (
            <Tooltip key={tool.id} content={label} placement="bottom">
              <button
                ref={(el) => {
                  rowRefs.current[index] = el;
                }}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-label={label}
                aria-controls={ACTIVITY_PANE_ID}
                tabIndex={index === homeIndex ? 0 : -1}
                onClick={() => onToggle(tool.id)}
                onKeyDown={(e) => handleToolKeyDown(e, index, tool.id)}
                data-testid={`header-tool-${tool.id}`}
                data-activity-entry={tool.id}
                className={BUTTON_CLASS}
              >
                <span aria-hidden="true" className={pillClass(isActive)}>
                  <Icon size={18} aria-hidden="true" />
                </span>
              </button>
            </Tooltip>
          );
        })}
      </div>
      {folded > 0 && (
        <>
          <Tooltip content={moreLabel} placement="bottom">
            <button
              ref={moreRef}
              type="button"
              aria-label={moreLabel}
              aria-haspopup="true"
              aria-expanded={listOpen}
              aria-controls={listOpen ? OVERFLOW_LIST_ID : undefined}
              tabIndex={homeIndex === visibleTools.length ? 0 : -1}
              onClick={() => setListOpen((open) => !open)}
              onKeyDown={handleMoreKeyDown}
              data-testid="header-tool-more"
              data-active={activeFolded ? 'true' : 'false'}
              className={BUTTON_CLASS}
            >
              <span aria-hidden="true" className={`relative ${pillClass(activeFolded)}`}>
                <Ellipsis size={18} aria-hidden="true" />
                {activeFolded && (
                  <span
                    data-testid="header-tool-more-active-mark"
                    className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-accent-500"
                  />
                )}
              </span>
            </button>
          </Tooltip>
          {listOpen && (
            <div
              ref={listRef}
              id={OVERFLOW_LIST_ID}
              role="tablist"
              aria-orientation="vertical"
              aria-label={t('headerTools.more')}
              data-testid="header-tool-more-list"
              // Marks itself as an open floating layer: while it is up, a press
              // elsewhere closes it and not the activity pane (#3589's rule).
              data-floating-layer="open"
              className="absolute right-0 top-full z-40 mt-1 flex min-w-[12rem] flex-col rounded-lg border border-border bg-surface p-1 shadow-lg"
            >
              {foldedTools.map((tool, index) => {
                const Icon = tool.icon;
                const isActive = active === tool.id;
                const label = t(tool.labelKey);
                return (
                  <button
                    key={tool.id}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    aria-controls={ACTIVITY_PANE_ID}
                    onClick={() => pickFolded(tool.id)}
                    onKeyDown={(e) => handleListKeyDown(e, index, tool.id)}
                    data-testid={`header-tool-more-item-${tool.id}`}
                    className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      isActive
                        ? 'bg-accent-500/10 text-accent-600 dark:text-accent-400'
                        : 'text-foreground hover:bg-muted'
                    }`}
                  >
                    <Icon size={16} aria-hidden="true" />
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
});

export default HeaderToolBar;
