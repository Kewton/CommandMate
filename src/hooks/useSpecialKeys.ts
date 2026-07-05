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

/**
 * Returns a stable `sendKeys(keys)` callback that POSTs the given tmux key names
 * to the worktree's special-keys endpoint and, after a short delay for tmux to
 * process the keys, invokes `onKeysSent` (typically a terminal refresh).
 */
export function useSpecialKeys(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  onKeysSent?: () => void,
): (keys: string[]) => void {
  return useCallback(
    (keys: string[]) => {
      const body = instanceId && instanceId !== cliToolId
        ? { cliToolId, keys, instanceId }
        : { cliToolId, keys };
      fetch(`/api/worktrees/${encodeURIComponent(worktreeId)}/special-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(() => {
          // Trigger an immediate terminal refresh once tmux has processed the key.
          if (onKeysSent) {
            setTimeout(onKeysSent, NAV_KEY_REFRESH_DELAY_MS);
          }
        })
        .catch((err) => {
          console.error('Failed to send special keys:', err);
        });
    },
    [worktreeId, cliToolId, instanceId, onKeysSent],
  );
}
