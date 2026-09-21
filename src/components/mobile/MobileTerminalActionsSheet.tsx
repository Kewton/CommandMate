/**
 * MobileTerminalActionsSheet (Issue #1080)
 *
 * Bottom sheet holding the terminal actions that previously crowded the mobile
 * sticky control row (terminal search + End session). The sticky row is now
 * dedicated to the agent-instance tabs; these secondary actions moved here,
 * opened from the row's "more actions" trigger. "End session" is destructive and
 * defers the confirmation to the caller (the existing kill-confirm dialog).
 *
 * Issue #2427 adds the session note, and it is the one row here that does not
 * take a callback prop. The sheet is rendered by `WorktreeDetailRefactored`
 * *beside* the terminal tab rather than inside it, so it knows neither the
 * worktree nor the instance the note belongs to; it raises the intent as a
 * window event and `MobileTerminalTab` — which holds both — opens the editor.
 * That is the same escape hatch "Search terminal" already travels
 * (`terminal-search-open`, dispatched by this sheet's caller and by the PC split
 * header), so the pattern is the surface's own rather than a new one.
 *
 * The row is present unconditionally, empty note or not: it is the only way to
 * WRITE a first note on a phone, and a control that appears only once you have
 * used it cannot be discovered.
 *
 * Issue #2799 adds "Direct input" — the phone's on-screen keyboard for frames
 * the detection layer cannot read. It sits BEFORE "End session", so the
 * destructive action stays last (and the focus-trap test's "last button" stays
 * a pressable one). It can be unavailable — not on the Terminal tab, the chat
 * surface is showing, or no session is running — and then it stays in the list
 * with the reason under it, `aria-disabled` rather than `disabled` so it keeps
 * its place in the focus order and the reason stays readable, and the handler
 * refuses the tap as well. The caller decides the reason; this sheet only draws
 * it. Both props are optional, and without `onDirectInput` the row is absent.
 *
 * Issue #2823: on the chat surface `TerminalDisplay` is not mounted, so the
 * search row reads "Search this conversation" there (`searchTarget`) and the
 * caller opens the transcript's search. The sheet only draws the label; which
 * event `onSearch` raises stays the caller's. Same button, testid and order.
 */

'use client';

import React, { useCallback, useEffect, useId } from 'react';
import { useTranslations } from 'next-intl';
import { Search, LogOut, StickyNote, Keyboard } from 'lucide-react';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { SESSION_NOTE_OPEN_EVENT } from '@/components/worktree/TerminalSplitPane';

export interface MobileTerminalActionsSheetProps {
  /** Whether the sheet is visible. */
  open: boolean;
  /** Dismiss the sheet (overlay tap / after an action). */
  onClose: () => void;
  /** Invoked when the search row ("Search terminal" / "Search this conversation") is chosen. */
  onSearch: () => void;
  /** Issue #2823: the search row's label — "Search terminal" (default) or "Search this conversation". */
  searchTarget?: 'terminal' | 'chat';
  /** Invoked when "End session" is chosen (caller shows the confirm dialog). */
  onEnd: () => void;
  /** When true, the End action is unavailable (no running session). */
  endDisabled?: boolean;
  /**
   * Issue #2799: open the direct-input keyboard. The sheet closes first, as for
   * every other row. Omitted → no "Direct input" row.
   */
  onDirectInput?: () => void;
  /**
   * Issue #2799: why "Direct input" cannot be used right now, or `null` / omitted
   * when it can. The row is drawn unavailable with the matching reason.
   */
  directInputUnavailableReason?: DirectInputUnavailableReason | null;
}

/**
 * Why the direct-input row is unavailable (Issue #2799), in the order the caller
 * checks them: the Terminal tab is not showing, the chat surface is, or no
 * session is running (the route 404s without one).
 */
export type DirectInputUnavailableReason = 'tab' | 'chat' | 'session';

const DIRECT_INPUT_REASON_KEY: Readonly<Record<DirectInputUnavailableReason, string>> = {
  tab: 'directInputKeyboard.unavailableTab',
  chat: 'directInputKeyboard.unavailableChat',
  session: 'directInputKeyboard.unavailableSession',
};

/**
 * Bottom action sheet for mobile terminal secondary actions.
 */
export function MobileTerminalActionsSheet({
  open,
  onClose,
  onSearch,
  searchTarget = 'terminal',
  onEnd,
  endDisabled = false,
  onDirectInput,
  directInputUnavailableReason = null,
}: MobileTerminalActionsSheetProps) {
  const t = useTranslations('worktree');
  const labelId = useId();
  const directInputReasonId = useId();

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

  // Issue #2427: no `onNote` prop — see the note at the top of this file.
  const handleSessionNote = useCallback(() => {
    window.dispatchEvent(new CustomEvent(SESSION_NOTE_OPEN_EVENT));
    onClose();
  }, [onClose]);

  // Issue #2799: refused here as well as drawn unavailable — `aria-disabled`
  // alone does not stop a tap.
  const handleDirectInput = useCallback(() => {
    if (!onDirectInput || directInputUnavailableReason !== null) return;
    onClose();
    onDirectInput();
  }, [onDirectInput, directInputUnavailableReason, onClose]);

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
            {searchTarget === 'chat' ? t('chatTranscript.openSearch') : t('terminal.searchTerminal')}
          </button>
          <button
            type="button"
            data-testid="actions-sheet-session-note"
            onClick={handleSessionNote}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-sm text-foreground hover:bg-muted transition-colors touch-manipulation"
          >
            <StickyNote size={18} aria-hidden="true" className="text-muted-foreground" />
            {t('sessionNote.menuItem')}
          </button>
          {onDirectInput ? (
            <button
              type="button"
              data-testid="actions-sheet-direct-input"
              onClick={handleDirectInput}
              // Named by the label alone; the reason is its description.
              aria-label={t('directInputKeyboard.menuItem')}
              aria-disabled={directInputUnavailableReason !== null ? true : undefined}
              aria-describedby={directInputUnavailableReason !== null ? directInputReasonId : undefined}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-foreground transition-colors touch-manipulation ${
                directInputUnavailableReason !== null ? '' : 'hover:bg-muted'
              }`}
            >
              {/* Unavailable dims the icon and the label only: the reason under
                  them is the one thing to read, so it keeps full contrast. */}
              <Keyboard
                size={18}
                aria-hidden="true"
                className={`shrink-0 text-muted-foreground ${directInputUnavailableReason !== null ? 'opacity-40' : ''}`}
              />
              <span className="flex min-w-0 flex-col">
                <span className={directInputUnavailableReason !== null ? 'opacity-40' : undefined}>
                  {t('directInputKeyboard.menuItem')}
                </span>
                {directInputUnavailableReason !== null ? (
                  <span
                    id={directInputReasonId}
                    data-testid="actions-sheet-direct-input-reason"
                    className="text-xs text-muted-foreground"
                  >
                    {t(DIRECT_INPUT_REASON_KEY[directInputUnavailableReason])}
                  </span>
                ) : null}
              </span>
            </button>
          ) : null}
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
