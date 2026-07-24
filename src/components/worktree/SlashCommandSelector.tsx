/**
 * SlashCommandSelector Component
 *
 * PC: Dropdown selector for slash commands
 * Mobile: Bottom sheet selector for slash commands
 *
 * [Issue #1365] The desktop dropdown opens upward from the message input and is
 * 320px wide, so it can run past the top or the right edge of the viewport. It
 * is measured once open and nudged back with a transform. The mobile bottom
 * sheet is `fixed inset-x-0` and always on screen, so it is left alone.
 */

'use client';

import React, { memo, useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import type { SlashCommand, SlashCommandGroup } from '@/types/slash-commands';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { filterCommandGroups } from '@/lib/command-merger';
import { resolveCommandDescription } from '@/lib/slash-command-format';
import { SlashCommandList } from './SlashCommandList';

/** Space (px) kept between the dropdown and the viewport edge. [Issue #1365] */
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

export interface SlashCommandSelectorProps {
  /** Whether the selector is open */
  isOpen: boolean;
  /** Command groups to display */
  groups: SlashCommandGroup[];
  /** Callback when a command is selected */
  onSelect: (command: SlashCommand) => void;
  /** Callback to close the selector */
  onClose: () => void;
  /** Whether to render as mobile bottom sheet */
  isMobile?: boolean;
  /** Position for desktop dropdown */
  position?: { top: number; left: number };
  /** Callback for free input mode (Issue #56, #288: passes current filter text) */
  onFreeInput?: (filterText: string) => void;
  /**
   * Whether the built-in command catalog looks out of date for the active CLI
   * (Issue #1476). Renders a non-intrusive one-line hint at the end of the list.
   */
  isCatalogStale?: boolean;
  /**
   * Active CLI tool for the session (Issue #1504). Forwarded to SlashCommandList
   * so the displayed trigger matches what gets inserted — antigravity sessions
   * show `/NAME` for `.agents/skills` entries instead of codex's `$NAME`.
   */
  cliToolId?: CLIToolType;
}

/**
 * SlashCommandSelector component
 *
 * Renders as dropdown on desktop and bottom sheet on mobile
 *
 * @example
 * ```tsx
 * <SlashCommandSelector
 *   isOpen={showSelector}
 *   groups={groups}
 *   onSelect={handleSelect}
 *   onClose={() => setShowSelector(false)}
 *   isMobile={isMobile}
 * />
 * ```
 */
export const SlashCommandSelector = memo(function SlashCommandSelector({
  isOpen,
  groups,
  onSelect,
  onClose,
  isMobile = false,
  position,
  onFreeInput,
  isCatalogStale = false,
  cliToolId,
}: SlashCommandSelectorProps) {
  const [filter, setFilter] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const shiftRef = useRef({ x: 0, y: 0 });
  const [shift, setShift] = useState({ x: 0, y: 0 });
  const t = useTranslations('worktree');
  const tCommon = useTranslations('common');

  // Filter groups based on search (uses shared utility - DRY principle).
  // Issue #1306: search the translated description, not the raw descriptionKey.
  const filteredGroups = useMemo(() => {
    return filterCommandGroups(groups, filter, (cmd) => resolveCommandDescription(cmd, t));
  }, [groups, filter, t]);

  // Flat list for keyboard navigation
  const flatCommands = useMemo(() => {
    return filteredGroups.flatMap((group) => group.commands);
  }, [filteredGroups]);

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setFilter('');
      setHighlightedIndex(0);
      // Focus input after a short delay
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  // Handle command selection
  const handleSelect = useCallback(
    (command: SlashCommand) => {
      onSelect(command);
      onClose();
    },
    [onSelect, onClose]
  );

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return;

      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
        case 'ArrowDown':
          e.preventDefault();
          setHighlightedIndex((prev) =>
            Math.min(prev + 1, flatCommands.length - 1)
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          setHighlightedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (flatCommands[highlightedIndex]) {
            handleSelect(flatCommands[highlightedIndex]);
          }
          break;
      }
    },
    [isOpen, flatCommands, highlightedIndex, onClose, handleSelect]
  );

  // Add keyboard listener only when selector is open (Issue #288)
  // Prevents document-level Enter key interception when selector is closed
  useEffect(() => {
    if (!isOpen) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, handleKeyDown]);

  // Keep the desktop dropdown inside the viewport. Re-measured when the filter
  // changes, because the list grows and shrinks while the selector is open.
  // [Issue #1365]
  useLayoutEffect(() => {
    const applyShift = (next: { x: number; y: number }): void => {
      shiftRef.current = next;
      setShift((prev) => (prev.x === next.x && prev.y === next.y ? prev : next));
    };
    if (!isOpen || isMobile) {
      applyShift({ x: 0, y: 0 });
      return;
    }
    const el = dropdownRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Subtract the shift already applied so the measurement describes the
    // dropdown's uncorrected position and re-running stays idempotent.
    applyShift({
      x: clampShift(rect.left - shiftRef.current.x, rect.width, window.innerWidth),
      y: clampShift(rect.top - shiftRef.current.y, rect.height, window.innerHeight),
    });
  }, [isOpen, isMobile, filteredGroups, position?.top, position?.left]);

  if (!isOpen) {
    return null;
  }

  // Issue #1476: non-intrusive hint shown at the end of the list when the
  // installed CLI is newer than the bundled catalog. Guides users to the user
  // extension directory for commands the snapshot has not caught up to.
  const staleNote = isCatalogStale ? (
    <div
      data-testid="slash-command-stale-note"
      className="px-3 py-2 border-t border-border text-xs text-muted-foreground"
    >
      {t('slashCommands.catalogStale.hint')}
    </div>
  ) : null;

  // Mobile: Bottom sheet
  if (isMobile) {
    return (
      <>
        {/* Backdrop */}
        <div
          className="fixed inset-0 bg-black/50 z-40"
          onClick={onClose}
          aria-hidden="true"
        />

        {/* Bottom sheet */}
        <div
          data-testid="slash-command-bottom-sheet"
          className="fixed bottom-0 left-0 right-0 bg-surface rounded-t-xl z-50 max-h-[70vh] flex flex-col shadow-xl"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h2 className="text-lg font-semibold text-foreground">{t('slashCommands.title')}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={tCommon('close')}
              className="p-2 rounded-full hover:bg-muted"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          {/* Search */}
          <div className="px-4 py-2 border-b border-border">
            <input
              ref={inputRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('slashCommands.searchPlaceholder')}
              className="w-full px-3 py-2 border border-input bg-surface dark:bg-surface-2 text-foreground rounded-lg focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {/* Free input button (Issue #56, #288) */}
          {onFreeInput && (
            <button
              type="button"
              data-testid="free-input-button"
              onClick={() => onFreeInput(filter)}
              className="w-full px-4 py-3 text-left border-b border-border flex items-center gap-2 hover:bg-accent-50 dark:hover:bg-accent-900/30 transition-colors"
            >
              <span className="text-accent-600 dark:text-accent-400">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </span>
              <span className="text-muted-foreground">{t('slashCommands.enterCustomCommand')}</span>
            </button>
          )}

          {/* Command list */}
          <SlashCommandList
            groups={filteredGroups}
            onSelect={handleSelect}
            highlightedIndex={highlightedIndex}
            className="flex-1 overflow-y-auto pb-20"
            cliToolId={cliToolId}
          />

          {staleNote}
        </div>
      </>
    );
  }

  // Desktop: Dropdown
  const basePosition: React.CSSProperties = position
    ? { top: position.top, left: position.left }
    : { bottom: '100%', left: 0, marginBottom: '4px' };

  return (
    <div
      ref={dropdownRef}
      role="listbox"
      data-testid="slash-command-dropdown"
      className="absolute bg-surface border border-border rounded-lg shadow-lg z-50 w-80 max-h-96 flex flex-col"
      style={
        shift.x !== 0 || shift.y !== 0
          ? { ...basePosition, transform: `translate(${shift.x}px, ${shift.y}px)` }
          : basePosition
      }
    >
      {/* Search */}
      <div className="px-3 py-2 border-b border-border">
        <input
          ref={inputRef}
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('slashCommands.searchPlaceholder')}
          className="w-full px-3 py-1.5 text-sm border border-input bg-surface dark:bg-surface-2 text-foreground rounded focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* Free input button (Issue #56, #288) */}
      {onFreeInput && (
        <button
          type="button"
          data-testid="free-input-button"
          onClick={() => onFreeInput(filter)}
          className="w-full px-3 py-2 text-left border-b border-border flex items-center gap-2 hover:bg-accent-50 dark:hover:bg-accent-900/30 transition-colors text-sm"
        >
          <span className="text-accent-600 dark:text-accent-400">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </span>
          <span className="text-muted-foreground">{t('slashCommands.enterCustomCommand')}</span>
        </button>
      )}

      {/* Command list */}
      <SlashCommandList
        groups={filteredGroups}
        onSelect={handleSelect}
        highlightedIndex={highlightedIndex}
        className="flex-1 overflow-y-auto"
        cliToolId={cliToolId}
      />

      {staleNote}

      {/* Keyboard hints */}
      <div className="px-3 py-1.5 border-t border-border text-xs text-muted-foreground flex gap-3">
        <span>
          <kbd className="px-1 py-0.5 bg-muted rounded">Enter</kbd> {t('slashCommands.selectHint')}
        </span>
        <span>
          <kbd className="px-1 py-0.5 bg-muted rounded">Esc</kbd> {t('slashCommands.closeHint')}
        </span>
      </div>
    </div>
  );
});
