'use client';

/**
 * PlanApproveKeys — the one key Command Code's plan review needs that no other
 * strip offers (Issue #2762).
 *
 * The plan review overlay ends in
 *
 *     Approve ctrl+a   executes the plan
 *     Cancel esc
 *
 * `Cancel` is the `Esc` every arrow pad already carries. `Approve` is `ctrl+a`,
 * which nothing on the chat surface could send, so a session that reached this
 * screen could be cancelled from the browser and never approved.
 *
 * A file of its own rather than one more export of `PromptAnswerKeys.tsx`:
 * `TerminalSplitPaneContent-chat-footer-2254.test.tsx` replaces that whole
 * module with a hand-written mock, and a new export there is a new way for that
 * suite to throw.
 */

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { PLAN_APPROVE_KEY } from '@/types/terminal-keys';
import { useSpecialKeys } from '@/hooks/useSpecialKeys';
import { useKeyPressFeedback } from '@/hooks/useKeyPressFeedback';
import type { SelectionKeysProps } from '@/components/worktree/PromptAnswerKeys';

export function PlanApproveKeys({
  worktreeId,
  cliToolId,
  instanceId,
  onKeysSent,
}: SelectionKeysProps) {
  const t = useTranslations('worktree');
  const { activeKey, markPressed } = useKeyPressFeedback();
  const send = useSpecialKeys(worktreeId, cliToolId, instanceId, onKeysSent);

  const handleClick = useCallback(() => {
    markPressed(PLAN_APPROVE_KEY);
    send([PLAN_APPROVE_KEY]);
  }, [markPressed, send]);

  return (
    <div
      data-testid="plan-approve-keys"
      role="toolbar"
      aria-label={t('planApproveKeys.toolbarLabel')}
      className="flex flex-wrap items-center gap-1.5 rounded-lg bg-muted px-2 py-1.5"
    >
      <button
        type="button"
        data-testid="plan-approve-key"
        aria-label={t('planApproveKeys.approveAria')}
        title={t('planApproveKeys.approveAria')}
        onClick={handleClick}
        className={`min-h-[44px] rounded-md border px-3 py-2 text-sm font-medium transition-colors duration-75 touch-manipulation focus:outline-none focus:ring-2 focus:ring-ring ${
          activeKey === PLAN_APPROVE_KEY
            ? 'border-accent-500 bg-accent-500 text-white scale-95'
            : 'border-accent-500 bg-surface text-accent-600 hover:bg-muted active:bg-muted dark:bg-surface-2 dark:text-accent-400'
        }`}
      >
        {t('planApproveKeys.approve')}
      </button>
      <p data-testid="plan-approve-note" className="w-full text-xs text-muted-foreground">
        {t('planApproveKeys.note')}
      </p>
    </div>
  );
}

export default PlanApproveKeys;
