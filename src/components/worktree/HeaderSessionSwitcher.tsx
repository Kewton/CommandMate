/**
 * HeaderSessionSwitcher (Issue #3593)
 *
 * The desktop header's session field: [current session][N others ▾]. The "+"
 * that adds an agent (#3514) is drawn right after it by `DesktopHeader`.
 *
 * - **Current session** — the session the selected split shows. A pill of a
 *   fixed width; the label truncates and the full text (model, cost, source)
 *   is its tooltip.
 * - **N others ▾** — every other session, in a list it opens. The rows waiting
 *   for an answer come first and the trigger carries their count in amber
 *   (and, as the "+N" did, the living dot of a working one). A row shows its
 *   status dot, name, status and the split showing it.
 *
 * The field is the same width at a given screen width whatever the number of
 * sessions, the length of their names or their states: the pill and the
 * trigger have fixed widths, and with no other session an empty box of the
 * trigger's width keeps its place.
 *
 * **Drag and drop.** A row can be dragged onto a split, as the pills could. The
 * list is our own disclosure rather than a Radix menu, because a drag needs
 * what a modal menu takes away:
 * - while a drag runs, the list ignores the pointer (`pointer-events: none`),
 *   so a split the list covers still receives the drop — fading it alone would
 *   not let the drop through. Applied one task after `dragstart`, because
 *   Chrome cancels the drag if its source stops taking the pointer during it;
 * - nothing closes the list while a drag runs (pressing outside, focus moving);
 * - the rows are frozen at the drag's start, so the row being dragged stays in
 *   the DOM until `dragend` even if the drop makes it the current session — a
 *   source element removed mid-drag never receives its `dragend`;
 * - `dragend` (a drop, or Esc cancelling the drag) closes the list and returns
 *   focus to the trigger.
 *
 * Keyboard: ArrowDown / ArrowUp on the trigger opens the list on the first /
 * last row (Enter and Space open it on the first); in the list ArrowDown /
 * ArrowUp / Home / End move, Enter selects, Escape closes and returns focus.
 *
 * The list is portalled to `document.body` and always mounted (`hidden` while
 * closed), so the header's horizontal clip cannot cut it and each row keeps
 * its `desktop-agent-status-<id>` handle.
 *
 * @module components/worktree/HeaderSessionSwitcher
 */

'use client';

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { ChevronDown, Plus } from 'lucide-react';
import { StatusDot } from '@/components/ui/StatusDot';
import { Tooltip } from '@/components/common/Tooltip';
import { Z_INDEX } from '@/config/z-index';
import { countWaitingInstances } from '@/lib/agent-status-display';
import type { BranchStatus } from '@/types/sidebar';

/** One session as the field draws it. Resolved by `DesktopHeader`. */
export interface HeaderSessionEntry {
  id: string;
  status: BranchStatus;
  /** `{label}: {status}` — the current session's visible text. */
  fullLabel: string;
  /** The name alone (a row shows it and the status word in two columns). */
  name: string;
  /** The status word alone. */
  statusWord: string;
  /** The tooltip and accessible name: the visible text plus model, cost and source. */
  tooltip: string;
  /** The "cannot tell" ring (#2775), when it applies. */
  dotClass?: string;
  /** The split (0-based) that shows this session, or null when none does. */
  splitIndex: number | null;
  /** Whether this is the worktree's active instance. */
  isActive: boolean;
}

export interface HeaderSessionSwitcherProps {
  /** The session the selected split shows; null draws no pill. */
  current: HeaderSessionEntry | null;
  /** The other sessions, in the order the list shows them. */
  others: HeaderSessionEntry[];
  /** A session was picked (the pill or a row). */
  onSelect?: (instanceId: string) => void;
  /** A drag started from the pill or a row (sets the payload, publishes the id). */
  onDragStart: (e: React.DragEvent<HTMLButtonElement>, instanceId: string) => void;
  /** That drag ended, dropped or cancelled. */
  onDragEnd: () => void;
  /** The instance being dragged, for the pill's / row's drag visual. */
  draggingInstanceId: string | null;
  /** Opens the "+" add-agent form; omitted leaves "Add session…" out of the list. */
  onAddSession?: () => void;
  /** Whether "Add session…" can do anything now (the "+" may be at its limit). */
  canAddSession?: boolean;
}

/** Fixed widths, so the field never changes width with its content. */
const CURRENT_PILL_WIDTH = 'w-44';
const OTHERS_TRIGGER_WIDTH = 'w-[7.5rem]';

/** Selector of the list's focusable rows (sessions and "Add session…"). */
const ITEM_SELECTOR = '[data-switcher-item]:not([disabled])';

export function HeaderSessionSwitcher({
  current,
  others,
  onSelect,
  onDragStart,
  onDragEnd,
  draggingInstanceId,
  onAddSession,
  canAddSession = true,
}: HeaderSessionSwitcherProps): React.ReactElement {
  const t = useTranslations('worktree');
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // Which item to focus once the list is shown ('first' / 'last'), or none.
  const [pendingFocus, setPendingFocus] = useState<'first' | 'last' | null>(null);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  // The rows as they were when a drag left the list; drawn until `dragend`.
  const [frozenOthers, setFrozenOthers] = useState<HeaderSessionEntry[] | null>(null);
  const listDragging = frozenOthers !== null;
  // Whether the list is out of hit testing. Set one task after `dragstart`:
  // Chrome cancels a drag whose source turns `pointer-events: none` while
  // `dragstart` is still being dispatched (React flushes this event's state
  // synchronously), which would end every drag from the list at once.
  const [listInert, setListInert] = useState(false);
  const inertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draggingRef = useRef(false);

  useEffect(
    () => () => {
      if (inertTimerRef.current) clearTimeout(inertTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  const rows = frozenOthers ?? others;
  const waitingCount = countWaitingInstances(rows);
  const glowStatus =
    rows.find((r) => r.status === 'running' || r.status === 'generating')?.status ??
    rows.find((r) => r.status === 'waiting')?.status ??
    null;

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setPendingFocus(null);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const openList = useCallback((focus: 'first' | 'last') => {
    setOpen(true);
    setPendingFocus(focus);
  }, []);

  // Place the list under the trigger, right-aligned, while it is open.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({ top: rect.bottom + 4, right: Math.max(4, window.innerWidth - rect.right) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  useEffect(() => {
    if (!open || pendingFocus === null) return;
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);
    (pendingFocus === 'first' ? items[0] : items[items.length - 1])?.focus();
    setPendingFocus(null);
  }, [open, pendingFocus]);

  // Pressing outside closes the list — never during a drag.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (draggingRef.current) return;
      const target = e.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || listRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[role="tooltip"]')) return;
      close(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, close]);

  // There is nothing left to list (the last other session went away).
  useEffect(() => {
    if (open && rows.length === 0 && !onAddSession) close(false);
  }, [open, rows.length, onAddSession, close]);

  const handleListBlur = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      if (draggingRef.current) return;
      const next = e.relatedTarget as Node | null;
      // Focus left for nowhere (a click on a non-focusable spot): the
      // pointerdown handler above decides that case.
      if (!next) return;
      if (listRef.current?.contains(next) || triggerRef.current?.contains(next)) return;
      close(false);
    },
    [close],
  );

  const handleListKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);
      const index = items.indexOf(document.activeElement as HTMLElement);
      const focusAt = (i: number) => items[(i + items.length) % items.length]?.focus();
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          focusAt(index + 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          focusAt(index < 0 ? items.length - 1 : index - 1);
          break;
        case 'Home':
          e.preventDefault();
          focusAt(0);
          break;
        case 'End':
          e.preventDefault();
          focusAt(items.length - 1);
          break;
        case 'Escape':
          e.preventDefault();
          e.stopPropagation();
          close(true);
          break;
        case 'Tab':
          close(false);
          break;
        default:
          break;
      }
    },
    [close],
  );

  const handleTriggerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openList(e.key === 'ArrowDown' ? 'first' : 'last');
      } else if (e.key === 'Escape' && open) {
        e.preventDefault();
        close(true);
      }
    },
    [open, openList, close],
  );

  const handleRowDragStart = useCallback(
    (e: React.DragEvent<HTMLButtonElement>, instanceId: string) => {
      draggingRef.current = true;
      setFrozenOthers(others);
      if (inertTimerRef.current) clearTimeout(inertTimerRef.current);
      inertTimerRef.current = setTimeout(() => {
        inertTimerRef.current = null;
        if (draggingRef.current) setListInert(true);
      }, 0);
      onDragStart(e, instanceId);
    },
    [others, onDragStart],
  );

  const handleRowDragEnd = useCallback(() => {
    draggingRef.current = false;
    if (inertTimerRef.current) {
      clearTimeout(inertTimerRef.current);
      inertTimerRef.current = null;
    }
    setListInert(false);
    setFrozenOthers(null);
    onDragEnd();
    close(true);
  }, [onDragEnd, close]);

  const handleRowClick = useCallback(
    (instanceId: string) => {
      close(true);
      onSelect?.(instanceId);
    },
    [close, onSelect],
  );

  const handleAddClick = useCallback(() => {
    close(false);
    onAddSession?.();
  }, [close, onAddSession]);

  const othersLabel =
    waitingCount > 0
      ? t('agentStatus.otherSessionsWaitingLabel', { count: rows.length, waiting: waitingCount })
      : t('agentStatus.otherSessionsLabel', { count: rows.length });

  const list = (
    <div
      ref={listRef}
      id={listId}
      role="group"
      aria-label={t('agentStatus.otherSessionsList')}
      data-testid="desktop-session-others-list"
      data-dragging={listInert ? 'true' : undefined}
      hidden={!open}
      onKeyDown={handleListKeyDown}
      onBlur={handleListBlur}
      style={{
        zIndex: Z_INDEX.POPOVER,
        top: position?.top ?? 0,
        right: position?.right ?? 0,
      }}
      className={`fixed flex w-72 max-w-[calc(100vw-8px)] flex-col gap-0.5 rounded-md border border-border bg-surface p-1 text-surface-foreground shadow-lg transition-opacity${
        listInert ? ' pointer-events-none opacity-40' : ''
      }`}
    >
      {rows.map((entry) => (
        <Tooltip key={entry.id} content={entry.tooltip} placement="bottom">
          {/* Issue #1061: draggable session row (aria-pressed: never the current one) — 残置 */}
          <button
            type="button"
            data-switcher-item=""
            data-testid={`desktop-agent-status-${entry.id}`}
            onClick={() => handleRowClick(entry.id)}
            draggable
            onDragStart={(e) => handleRowDragStart(e, entry.id)}
            onDragEnd={handleRowDragEnd}
            // No `title`: the <Tooltip> above already renders this string.
            aria-label={entry.tooltip}
            aria-pressed={entry.isActive}
            className={`flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring${
              draggingInstanceId === entry.id ? ' opacity-50 cursor-grabbing' : ''
            }`}
          >
            <StatusDot status={entry.status} size="sm" aria-hidden title={undefined} className={entry.dotClass} />
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            <span className="flex-shrink-0 text-xs text-muted-foreground">{entry.statusWord}</span>
            {entry.splitIndex !== null && (
              <span
                className="flex-shrink-0 rounded bg-muted px-1.5 text-[10px] font-medium leading-4 text-muted-foreground"
                data-testid={`desktop-session-split-${entry.id}`}
              >
                {t('agentStatus.inSplit', { index: entry.splitIndex + 1 })}
              </span>
            )}
          </button>
        </Tooltip>
      ))}
      {onAddSession && (
        <>
          {rows.length > 0 && <div role="separator" className="my-0.5 h-px bg-border" />}
          <button
            type="button"
            data-switcher-item=""
            data-testid="desktop-session-add"
            onClick={handleAddClick}
            disabled={!canAddSession}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            {t('agentStatus.addSession')}
          </button>
        </>
      )}
    </div>
  );

  return (
    <div className="flex flex-shrink-0 items-center gap-1" data-testid="desktop-session-switcher">
      {current ? (
        /* Issue #1061: draggable instance-tab switcher (aria-pressed) with typed drag handlers — 残置 */
        <button
          type="button"
          data-testid={`desktop-agent-status-${current.id}`}
          data-session-current=""
          onClick={() => onSelect?.(current.id)}
          draggable
          onDragStart={(e) => onDragStart(e, current.id)}
          onDragEnd={onDragEnd}
          aria-label={current.tooltip}
          // Native tooltip: the full label (and model, cost, source) for the
          // truncated pill. Same string as the accessible name.
          title={current.tooltip}
          aria-pressed={current.isActive}
          className={`flex ${CURRENT_PILL_WIDTH} flex-shrink-0 items-center gap-1.5 overflow-hidden px-2 py-1 rounded text-xs transition-colors ${
            current.isActive
              ? 'bg-accent-100 dark:bg-accent-900/30 text-accent-900 dark:text-accent-100'
              : 'hover:bg-muted text-foreground'
          }${draggingInstanceId === current.id ? ' opacity-50 cursor-grabbing' : ''}`}
        >
          {/* Issue #1078: unified StatusDot (decorative; the button carries the label) */}
          <StatusDot status={current.status} size="sm" aria-hidden title={undefined} className={current.dotClass} />
          <span className="min-w-0 truncate whitespace-nowrap">{current.fullLabel}</span>
        </button>
      ) : (
        <span aria-hidden="true" className={`${CURRENT_PILL_WIDTH} flex-shrink-0`} />
      )}
      {rows.length > 0 || listDragging ? (
        <button
          ref={triggerRef}
          type="button"
          data-testid="desktop-agent-status-overflow"
          aria-label={othersLabel}
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => (open ? close(false) : openList('first'))}
          onKeyDown={handleTriggerKeyDown}
          className={`flex ${OTHERS_TRIGGER_WIDTH} flex-shrink-0 items-center gap-1.5 overflow-hidden rounded px-2 py-1 text-xs tabular-nums text-muted-foreground transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring${
            open ? ' bg-muted text-foreground' : ''
          }`}
        >
          {/* Issue #1078: a working session in the list still shows its
              living dot here — running/generating (green glow) over waiting
              (amber). The slot is kept when there is none. */}
          {glowStatus ? (
            <StatusDot status={glowStatus} size="sm" aria-hidden title={undefined} />
          ) : (
            <span aria-hidden="true" className="h-2 w-2 flex-shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate text-left">
            {t('agentStatus.otherSessions', { count: rows.length })}
          </span>
          <span className="flex flex-shrink-0 items-center gap-0.5">
            {/* The amber count's box is always there, so it costs no width when it appears. */}
            <span
              data-testid="desktop-session-others-waiting"
              aria-hidden="true"
              className={`min-w-[1.25rem] rounded-full px-1 text-center text-[10px] font-semibold leading-4 ${
                waitingCount > 0 ? 'bg-warning text-warning-foreground' : 'invisible'
              }`}
            >
              {waitingCount > 0 ? waitingCount : ''}
            </span>
            <ChevronDown className="h-3 w-3" aria-hidden="true" />
          </span>
        </button>
      ) : (
        // No other session: no trigger, but its width stays reserved.
        <span
          aria-hidden="true"
          data-testid="desktop-session-others-placeholder"
          className={`${OTHERS_TRIGGER_WIDTH} flex-shrink-0`}
        />
      )}
      {portalTarget && createPortal(list, portalTarget)}
    </div>
  );
}
