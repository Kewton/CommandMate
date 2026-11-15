/**
 * Issue #4385: what every optimistic send surface does with a send the server refused because of
 * its role (409 `roleRefusal`, nothing typed) — the worktree screen's panes
 * (`useOptimisticPaneMessages`, PC and phone) and the `/sessions` tile (`SessionTile`) alike.
 * Handed to `usePendingMessages` as `readRoleRefusal` / `onRoleRefused`: the reason goes on the
 * failed row, the app's toast says why right away, and a new send's text goes back to the
 * composer (`returnToComposer`), which clears only what the server took.
 *
 * @module hooks/useRoleRefusalNotice
 */
'use client';

import { useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useToast } from '@/components/common/Toast';
import { readSendRoleRefusal, sendRoleRefusalMessageKey } from '@/components/worktree/role-refusal-notice';
import type { SendRoleRefusalReason } from '@/types/models';

export interface RoleRefusalNotice {
  readRoleRefusal: (error: unknown) => SendRoleRefusalReason | null;
  onRoleRefused: (content: string, reason: SendRoleRefusalReason, info: { firstAttempt: boolean }) => boolean;
}

/** @param returnToComposer puts a new send's text back into the composer (read when it is needed). */
export function useRoleRefusalNotice(returnToComposer: ((content: string) => void) | undefined): RoleRefusalNotice {
  const t = useTranslations('worktree');
  const { showToast } = useToast();
  const returnRef = useRef(returnToComposer);
  returnRef.current = returnToComposer;
  const onRoleRefused = useCallback(
    (content: string, reason: SendRoleRefusalReason, info: { firstAttempt: boolean }): boolean => {
      showToast(t(sendRoleRefusalMessageKey(reason)), 'error');
      const insert = returnRef.current;
      if (!info.firstAttempt || !insert) return false;
      insert(content);
      return true;
    },
    [showToast, t],
  );
  return { readRoleRefusal: readSendRoleRefusal, onRoleRefused };
}
