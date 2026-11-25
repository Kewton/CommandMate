/**
 * Issue #4535 (段 2 §3): what every optimistic send surface does with a send the server stopped
 * before or while it was typed — the worktree screen's panes (`useOptimisticPaneMessages`, PC and
 * phone) and the `/sessions` tile (`SessionTile`) alike. One reader of "why it was not sent", handed
 * to `usePendingMessages`:
 *
 * - the role refusal (#4385, {@link useRoleRefusalNotice}): unchanged
 * - the send fence's 409 `SEND_TARGET_CHANGED` (#4534): the app's toast says why and names the
 *   original target (the To may have changed, so the row in that target's history may be out of
 *   sight). `not_sent`: a new send's text goes back once into the draft of the composer on screen,
 *   with its tag (r7 INV-V2a: `returnRetargeted({ text, tag })`, never a bare string) — while that
 *   composer's To is not the original target, it asks before sending it. `worktree-gone`: nowhere to
 *   go back to, so it does not. `unknown`: never handed back, never said to be "not sent". A tag that
 *   cannot be stored (`localStorage` refused it): the text does not go back either, and the toast
 *   says so (r5 H4). A row whose text was not handed back goes back on a discard only the same way
 *   (r5 H2).
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
import { newRetargetTag, type RetargetedText } from '@/lib/drafts/message-draft';

export interface SendRefusalNotice extends RoleRefusalNotice {
  readTargetChanged: (error: unknown) => SendTargetChangedRefusal | null;
  onTargetChanged: (content: string, refusal: SendTargetChangedRefusal, info: { firstAttempt: boolean }) => boolean;
  /**
   * Issue #4535 r5 (review H2), r7: a fence-refused row's text not handed back yet is discarded —
   * hands it back itself, with its tag (only with its original target named, not `worktree-gone`,
   * and its tag stored), and returns whether it did; a tag that cannot be stored says so. Never
   * returns the text for a plain insert.
   */
  onTargetChangedDiscard: (content: string, refusal: SendTargetChangedRefusal) => boolean;
}

/**
 * Issue #4535 r7 (INV-V2a): the road a fence's text takes back into a composer — the text and its tag
 * as one value; returns whether it went back (false: its tag could not be stored, nothing went back).
 */
export type ReturnRetargeted = (returned: RetargetedText) => boolean;

/**
 * Issue #4535: hand a text the fence refused (`not_sent`) back with its tag. `'none'`: there is
 * nowhere it may go (no road, no original target, or the worktree is gone); `'failed'`: its tag could
 * not be stored (review H4: fail-closed, the text does not go back); `'returned'`.
 */
function returnWithTag(
  road: ReturnRetargeted | undefined,
  content: string,
  refusal: SendTargetChangedRefusal,
): 'none' | 'failed' | 'returned' {
  const original = refusal.target;
  if (!road || original === null || refusal.reason === 'worktree-gone') return 'none';
  const tag = newRetargetTag({ instanceId: original.instanceId, cliToolId: original.cliToolId });
  return road({ text: content, tag }) ? 'returned' : 'failed';
}

/**
 * @param returnToComposer puts a role-refused new send's text back (read when it is needed).
 * @param returnRetargeted hands a fence-refused text back into the draft of the composer on screen,
 *   with its tag (r7 INV-V2a). Omitted: a fence's text is not handed back.
 */
export function useSendRefusalNotice(
  returnToComposer: ((content: string) => void) | undefined,
  returnRetargeted?: ReturnRetargeted,
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
      const notSent = t(SEND_TARGET_CHANGED_KEYS.notSent, { reason, target });
      const returned = info.firstAttempt ? returnWithTag(returnRef.current, content, refusal) : 'none';
      if (returned === 'returned') {
        showToast(`${notSent} ${t(SEND_TARGET_CHANGED_KEYS.textReturned)}`, 'error');
        return true;
      }
      showToast(returned === 'failed' ? `${notSent} ${t(SEND_TARGET_CHANGED_KEYS.textNotReturned)}` : notSent, 'error');
      return false;
    },
    [showToast, t],
  );
  const onTargetChangedDiscard = useCallback(
    (content: string, refusal: SendTargetChangedRefusal): boolean => {
      const returned = returnWithTag(returnRef.current, content, refusal);
      if (returned === 'failed') showToast(t(SEND_TARGET_CHANGED_KEYS.textNotReturned), 'error');
      return returned === 'returned';
    },
    [showToast, t],
  );
  return { ...role, readTargetChanged: readSendTargetChanged, onTargetChanged, onTargetChangedDiscard };
}
