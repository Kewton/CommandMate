/**
 * MobileTerminalActionsSheet (Issue #1080)
 *
 * Bottom sheet holding the terminal actions that previously crowded the mobile
 * sticky control row (terminal search + End session). The sticky row is now
 * dedicated to the agent-instance tabs; these secondary actions moved here,
 * opened from the row's "more actions" trigger. "End session" is destructive and
 * defers the confirmation to the caller (the existing kill-confirm dialog).
 */

'use client';

import React, { useCallback, useEffect, useId } from 'react';
import { useTranslations } from 'next-intl';
import { Search, LogOut } from 'lucide-react';
import { useFocusTrap } from '@/hooks/useFocusTrap';

export interface MobileTerminalActionsSheetProps {
  /** Whether the sheet is visible. */
  open: boolean;
  /** Dismiss the sheet (overlay tap / after an action). */
  onClose: () => void;
  /** Invoked when "Search terminal" is chosen. */
  onSearch: () => void;
  /** Invoked when "End session" is chosen (caller shows the confirm dialog). */
  onEnd: () => void;
  /** When true, the End action is unavailable (no running session). */
  endDisabled?: boolean;
}

/**
 * Bottom action sheet for mobile terminal secondary actions.
 */
export function MobileTerminalActionsSheet({
  open,
  onClose,
  onSearch,
  onEnd,
  endDisabled = false,
}: MobileTerminalActionsSheetProps) {
  const t = useTranslations('worktree');
  const labelId = useId();

  // [Issue #1127] Keep keyboard focus inside the sheet while open (shared
  // useFocusTrap); pairs with the existing Escape/backdrop dismiss paths.
  const sheetRef = useFocusTrap<HTMLDivElement>({ active: open });

  const handleSearch = useCallback(() => {
    onSearch();
    onClose();
  }, [onSearch, onClose]);

  const handleEnd = useCallback(() => {
    onEnd();
    onClose();
  }, [onEnd, onClose]);

  // Dismiss on Escape while the sheet is open (parity with the backdrop-tap /
  // action-button close paths for this role="dialog" aria-modal surface).
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      {/* Overlay */}
      <div
        data-testid="terminal-actions-overlay"
        onClick={onClose}
        className="fixed inset-0 bg-black/50 z-50"
        aria-hidden="true"
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
        data-testid="mobile-terminal-actions-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        tabIndex={-1}
        className="fixed bottom-0 inset-x-0 z-50 rounded-t-2xl border-t border-border bg-surface pb-safe"
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-2">
          <div className="w-10 h-1 rounded-full bg-muted-foreground/30" aria-hidden="true" />
        </div>

        <h2 id={labelId} className="px-4 pb-2 text-sm font-medium text-muted-foreground">
          {t('terminal.moreActions')}
        </h2>

        <div className="px-2 pb-4">
          <button
            type="button"
            data-testid="actions-sheet-search"
            onClick={handleSearch}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-sm text-foreground hover:bg-muted transition-colors touch-manipulation"
          >
            <Search size={18} aria-hidden="true" className="text-muted-foreground" />
            {t('terminal.searchTerminal')}
          </button>
          <button
            type="button"
            data-testid="actions-sheet-end"
            onClick={handleEnd}
            disabled={endDisabled}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-sm text-danger hover:bg-danger/10 transition-colors touch-manipulation disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <LogOut size={18} aria-hidden="true" />
            {t('terminal.endSession')}
          </button>
        </div>
      </div>
    </>
  );
}

export default MobileTerminalActionsSheet;
