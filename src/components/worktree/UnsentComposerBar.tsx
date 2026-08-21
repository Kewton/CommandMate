'use client';

/**
 * UnsentComposerBar — surface and dispose of text left in the CLI composer
 * (Issue #1879).
 *
 * Claude Code often leaves a recommended command pre-filled in its input box,
 * where a terminal user would just press Enter. Through CommandMate's read-only
 * terminal that text could only be re-typed by hand, because every Enter-capable
 * surface (NavigationButtons, TerminalEscapeHatch) is gated on a detection flag
 * that is false at a normal input prompt — a guard #1017/#1494 put there so a
 * STRAY Enter can never reach a live composer.
 *
 * This bar does not weaken that guard, and does not touch it: it appears on the
 * strength of the composer's CONTENTS, shows them, and offers the two actions a
 * person holding a keyboard would have. The distinction the guard cares about is
 * intact — a stray Enter is one nobody aimed; this one is aimed at text the user
 * is reading in the same bar as the button.
 *
 * Two things it deliberately does NOT do:
 *
 *  - **It does not call the text a recommendation.** Nothing in the frame says
 *    whether the agent pre-filled it or a human typed half a sentence and walked
 *    away (both were observed live in #1879/#1878), so the label is neutral.
 *  - **It never renders for ghost text.** `extractComposerText` drops Claude's
 *    dim suggestions upstream of this component, because a bar offering to run a
 *    hint — with a Clear button that provably cannot remove it — is a defect the
 *    user sees.
 *
 * [Run] posts `['Enter']` to the EXISTING special-keys endpoint (no new API:
 * `NAVIGATION_KEY_VALUES` has carried `'Enter'` since #473). [Clear] posts to
 * `clear-composer`, which loops `C-e`+`C-u` and reads the frame back — one `C-u`
 * is not enough, as #1878 §5-1 measured.
 */

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { useSpecialKeys } from '@/hooks/useSpecialKeys';
import { NAV_KEY_REFRESH_DELAY_MS } from '@/config/ui-feedback-config';

export interface UnsentComposerBarProps {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Agent instance to target; defaults to the primary instance when omitted. */
  instanceId?: string;
  /** The unsent text. The bar renders nothing when this is blank. */
  composerText: string;
  /** Trigger an immediate terminal refresh once the action has been sent. */
  onActionSent?: () => void;
}

/**
 * How much of the composer is shown inline.
 *
 * The bar identifies what is about to run; it is not an editor. A pasted
 * document would otherwise push the buttons off a phone screen, and the Enter
 * that [Run] sends acts on the buffer itself, never on this excerpt.
 */
export const COMPOSER_PREVIEW_MAX_CHARS = 300;

/**
 * The bar's display gate, shared by the PC footer and the mobile terminal tab.
 *
 * Contents-only *by construction*: it takes the text and nothing else, so no
 * detection flag can creep into the condition on one surface and not the other.
 * That is the property #1879 asks to be fixed, and a shared predicate holds it
 * better than two copies of the same expression.
 *
 * Tolerates a missing value on purpose. The type says it is always a string and
 * `useTerminalPanePolling` always sets one, but this is a decoration on top of
 * the terminal: a pane that renders nothing at all because the composer read was
 * absent would be a far worse failure than a bar that does not appear.
 */
export function hasUnsentComposerText(composerText: string | null | undefined): boolean {
  return (composerText ?? '').trim() !== '';
}

export function UnsentComposerBar({
  worktreeId,
  cliToolId,
  instanceId,
  composerText,
  onActionSent,
}: UnsentComposerBarProps) {
  const t = useTranslations('worktree');
  const [clearing, setClearing] = useState(false);
  const sendKeys = useSpecialKeys(worktreeId, cliToolId, instanceId, onActionSent);

  const handleRun = useCallback(() => {
    // The existing navigation endpoint, with the key it has always accepted.
    sendKeys(['Enter']);
  }, [sendKeys]);

  const handleClear = useCallback(() => {
    setClearing(true);
    const body = instanceId && instanceId !== cliToolId
      ? { cliToolId, instanceId }
      : { cliToolId };
    fetch(`/api/worktrees/${encodeURIComponent(worktreeId)}/clear-composer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(() => {
        if (onActionSent) setTimeout(onActionSent, NAV_KEY_REFRESH_DELAY_MS);
      })
      .catch((err) => {
        console.error('Failed to clear composer:', err);
      })
      .finally(() => {
        setClearing(false);
      });
  }, [worktreeId, cliToolId, instanceId, onActionSent]);

  // The single display gate, and it reads the text only. Nothing here consults
  // isUnclassifiedActive / isSelectionListActive / isPromptWaiting.
  if (!hasUnsentComposerText(composerText)) return null;

  const preview = composerText.length > COMPOSER_PREVIEW_MAX_CHARS
    ? `${composerText.slice(0, COMPOSER_PREVIEW_MAX_CHARS)}…`
    : composerText;

  return (
    <div
      data-testid="unsent-composer-bar"
      role="region"
      aria-label={t('unsentComposer.regionLabel')}
      className="flex flex-wrap items-center gap-2 px-2 py-1.5 bg-sky-50 dark:bg-sky-900/20 border border-sky-200 dark:border-sky-800/50 rounded-lg"
    >
      <span className="text-xs font-medium text-sky-800 dark:text-sky-200 shrink-0">
        {t('unsentComposer.label')}
      </span>
      <code
        data-testid="unsent-composer-text"
        className="flex-1 min-w-0 font-mono text-xs text-foreground break-all line-clamp-3 whitespace-pre-wrap"
      >
        {preview}
      </code>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={handleRun}
          aria-label={t('unsentComposer.run')}
          className="min-h-[32px] px-3 rounded-md text-xs font-medium bg-sky-600 text-white hover:bg-sky-700 active:bg-sky-800 transition-colors"
        >
          {t('unsentComposer.run')}
        </button>
        <button
          type="button"
          onClick={handleClear}
          disabled={clearing}
          aria-label={t('unsentComposer.clear')}
          className="min-h-[32px] px-3 rounded-md text-xs font-medium border border-sky-300 dark:border-sky-700 text-sky-800 dark:text-sky-200 hover:bg-sky-100 dark:hover:bg-sky-800/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {t('unsentComposer.clear')}
        </button>
      </div>
    </div>
  );
}

export default UnsentComposerBar;
