'use client';

/**
 * useSpecialKeys — shared sender for the special-keys API (Issue #1017).
 *
 * Extracted from NavigationButtons so both NavigationButtons (TUI selection-list
 * navigation) and TerminalEscapeHatch (the detection-independent Esc/q safety net)
 * post to the same endpoint with identical instance-targeting and refresh behavior,
 * without duplicating the fetch logic (DRY).
 *
 * Issue #869: `instanceId` is included only when it differs from the primary
 * instance (`=== cliToolId`), preserving byte-for-byte the pre-#869 request body
 * for every primary-instance send.
 */

import { useCallback } from 'react';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { NAV_KEY_REFRESH_DELAY_MS } from '@/config/ui-feedback-config';
import { useHandoffPageOwner } from '@/hooks/useHandoffPageOwner';
import {
  beginHandoffPageOperation,
  fetchForHandoffPage,
  handoffPageOperationOptions,
  isHandoffPageOperationRefused,
  type HandoffPageOperation,
} from '@/lib/handoff/page-owner';

/**
 * Returns a stable `sendKeys(keys)` callback that POSTs the given tmux key names
 * to the worktree's special-keys endpoint and, after a short delay for tmux to
 * process the keys, invokes `onKeysSent` (typically a terminal refresh).
 *
 * Issue #4345 1c 再指示 2 (K1): an operation of the page — the press's token (`operation`, or one made
 * now) goes to the gate; not sent once a 401 was taken (nothing happens: no refresh, no error).
 */
export function useSpecialKeys(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  onKeysSent?: () => void,
): (keys: string[], operation?: HandoffPageOperation) => void {
  // Issue #4345 1c 再指示 1: the worktree page's registration holder (none outside a worktree page).
  const handoffOwner = useHandoffPageOwner();
  return useCallback(
    (keys: string[], operation?: HandoffPageOperation) => {
      const pressed = operation ?? beginHandoffPageOperation(handoffOwner);
      const body = instanceId && instanceId !== cliToolId
        ? { cliToolId, keys, instanceId }
        : { cliToolId, keys };
      // Issue #4345 1c 再指示 1: the 401 reaches the gateway before the status is folded.
      fetchForHandoffPage(handoffOwner, `/api/worktrees/${encodeURIComponent(worktreeId)}/special-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, handoffPageOperationOptions(pressed))
        .then(() => {
          // Trigger an immediate terminal refresh once tmux has processed the key.
          if (onKeysSent) {
            setTimeout(onKeysSent, NAV_KEY_REFRESH_DELAY_MS);
          }
        })
        .catch((err) => {
          // 再指示 2: not sent (the page's gate refused it) — nothing happened.
          if (isHandoffPageOperationRefused(err)) return;
          console.error('Failed to send special keys:', err);
        });
    },
    [worktreeId, cliToolId, instanceId, onKeysSent, handoffOwner],
  );
}
