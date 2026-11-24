/**
 * Issue #4535 (段 2 §3): what every optimistic send surface does with a send the server stopped
 * before or while it was typed — the worktree screen's panes (`useOptimisticPaneMessages`, PC and
 * phone) and the `/sessions` tile (`SessionTile`) alike. One reader of "why it was not sent", handed
 * to `usePendingMessages`:
 *
 * - the role refusal (#4385, {@link useRoleRefusalNotice}): unchanged
 * - the send fence's 409 `SEND_TARGET_CHANGED` (#4534): the app's toast says why and names the
 *   original target (the To may have changed, so the row in that target's history may be out of
 *   sight). `not_sent`: a new send's text goes back to the composer on screen once
 *   (`returnRetargeted`), with a hold ({@link holdRetargetedText}) — while that composer's To is not
 *   the original target, the composer asks before sending it. `worktree-gone`: nowhere to go back
 *   to, so it does not. `unknown`: never handed back, never said to be "not sent". No hold written
 *   (`localStorage` refused it): the text does not go back either, and the toast says so (r5 H4).
 *   A row whose text was not handed back goes back on a discard only the same way (r5 H2).
 *
 * @module hooks/useSendRefusalNotice
 */
'use client';

import { useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useToast } from '@/components/common/Toast';
import { useRoleRefusalNotice, type RoleRefusalNotice } from '@/hooks/useRoleRefusalNotice';
import {
  SEND_TARGET_CHANGED_KEYS,
  readSendTargetChanged,
  sendTargetChangedReasonKey,
  type SendTargetChangedRefusal,
} from '@/components/worktree/send-refusal-notice';
import { holdRetargetedText } from '@/lib/drafts/message-draft';

export interface SendRefusalNotice extends RoleRefusalNotice {
  readTargetChanged: (error: unknown) => SendTargetChangedRefusal | null;
  onTargetChanged: (content: string, refusal: SendTargetChangedRefusal, info: { firstAttempt: boolean }) => boolean;
  /**
   * Issue #4535 r5 (review H2): a fence-refused row's text is about to go back to the composer on a
   * discard. Whether it may: only with its original target named (not `worktree-gone`) and its hold
   * written ({@link holdRetargetedText}); otherwise it stays out (and a hold that cannot be written
   * says so).
   */
  onTargetChangedDiscard: (content: string, refusal: SendTargetChangedRefusal) => boolean;
}

/**
 * Issue #4535: the hold of a text the fence refused (`not_sent`) before it goes back to a composer.
 * `'none'`: there is nowhere it may go (no original target, or the worktree is gone); `'failed'`:
 * the hold could not be written (review H4: fail-closed, the text does not go back); `'held'`.
 */
function holdForReturn(content: string, refusal: SendTargetChangedRefusal): 'none' | 'failed' | 'held' {
  const original = refusal.target;
  if (original === null || refusal.reason === 'worktree-gone') return 'none';
  return holdRetargetedText(original.worktreeId, {
    text: content,
    instanceId: original.instanceId,
    cliToolId: original.cliToolId,
  })
    ? 'held'
    : 'failed';
}

/**
 * @param returnToComposer puts a role-refused new send's text back (read when it is needed).
 * @param returnRetargeted puts a fence-refused new send's text into the composer on screen;
 *   defaults to `returnToComposer`.
 */
export function useSendRefusalNotice(
  returnToComposer: ((content: string) => void) | undefined,
  returnRetargeted: ((content: string) => void) | undefined = returnToComposer,
): SendRefusalNotice {
  const role = useRoleRefusalNotice(returnToComposer);
  const t = useTranslations('worktree');
  const { showToast } = useToast();
  const returnRef = useRef(returnRetargeted);
  returnRef.current = returnRetargeted;
  const onTargetChanged = useCallback(
    (content: string, refusal: SendTargetChangedRefusal, info: { firstAttempt: boolean }): boolean => {
      const reason = t(sendTargetChangedReasonKey(refusal.reason));
      const target = refusal.target?.instanceId ?? '?';
      if (refusal.sendOutcome !== 'not_sent') {
        showToast(t(SEND_TARGET_CHANGED_KEYS.unknown, { reason, target }), 'warning');
        return false;
      }
      const insert = returnRef.current;
      const notSent = t(SEND_TARGET_CHANGED_KEYS.notSent, { reason, target });
      // The hold first: the composer that takes the text reads it at its next send. No hold, no text
      // back (review H4).
      const hold = info.firstAttempt && insert ? holdForReturn(content, refusal) : 'none';
      if (hold === 'held' && insert) {
        insert(content);
        showToast(`${notSent} ${t(SEND_TARGET_CHANGED_KEYS.textReturned)}`, 'error');
        return true;
      }
      showToast(hold === 'failed' ? `${notSent} ${t(SEND_TARGET_CHANGED_KEYS.textNotReturned)}` : notSent, 'error');
      return false;
    },
    [showToast, t],
  );
  const onTargetChangedDiscard = useCallback(
    (content: string, refusal: SendTargetChangedRefusal): boolean => {
      const hold = holdForReturn(content, refusal);
      if (hold === 'failed') showToast(t(SEND_TARGET_CHANGED_KEYS.textNotReturned), 'error');
      return hold === 'held';
    },
    [showToast, t],
  );
  return { ...role, readTargetChanged: readSendTargetChanged, onTargetChanged, onTargetChangedDiscard };
}
