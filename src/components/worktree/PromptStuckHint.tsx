/**
 * PromptStuckHint - the "Send is not working — use direct input" line under a
 * prompt window (Issue #2869).
 *
 * Shared by `PromptPanel` and `MobilePromptSheet` (Issue #3209). It lives in its
 * own module rather than in `PromptPanel` because suites that mock `PromptPanel`
 * for the split pane still render the sheet, which needs this line.
 */

'use client';

import { useTranslations } from 'next-intl';

/** Props for {@link PromptStuckHint} */
export interface PromptStuckHintProps {
  showStuckHint?: boolean;
  onSwitchToDirectInput?: () => void;
  /**
   * Issue #2870: whether `/prompt-response` would answer this window — the
   * status API's `promptAnswerable`.
   */
  answerable?: boolean;
  /** The link's class: the PC and the phone sheet differ only here. */
  linkClassName: string;
}

/**
 * The "Send is not working — use direct input" line under a prompt window
 * (Issue #2869). Renders nothing unless both props are given, so a caller that
 * passes neither keeps its pre-#2869 output.
 */
export function PromptStuckHint({
  showStuckHint,
  onSwitchToDirectInput,
  answerable,
  linkClassName,
}: PromptStuckHintProps) {
  const t = useTranslations('worktree');
  const linkLabel = t('promptResponse.stuckHintLink');
  // Issue #2870: a window the route would refuse says so up front — no Send
  // has to fail first — and offers the link whenever there is one to offer.
  if (answerable === false) {
    return (
      <p data-testid="prompt-unanswerable-hint" className="mt-3 text-sm text-warning-foreground">
        {t('promptResponse.unanswerable')}
        {onSwitchToDirectInput && (
          <>
            {' '}
            <button
              type="button"
              data-testid="prompt-stuck-hint-link"
              onClick={onSwitchToDirectInput}
              aria-label={linkLabel}
              className={linkClassName}
            >
              {linkLabel}
            </button>
          </>
        )}
      </p>
    );
  }
  if (!showStuckHint || !onSwitchToDirectInput) return null;
  return (
    <p data-testid="prompt-stuck-hint" className="mt-3 text-sm text-warning-foreground">
      {t('promptResponse.stuckHint')}{' '}
      <button
        type="button"
        data-testid="prompt-stuck-hint-link"
        onClick={onSwitchToDirectInput}
        aria-label={linkLabel}
        className={linkClassName}
      >
        {linkLabel}
      </button>
    </p>
  );
}
