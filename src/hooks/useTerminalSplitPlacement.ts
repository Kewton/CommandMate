/**
 * useTerminalSplitPlacement — the parent's half of the header "+" placement
 * (Issue #3514).
 *
 * Holds the token-stamped {@link InstancePlacementRequest} handed to
 * `TerminalSplitContainer`, and clears it as soon as the container reports it
 * applied. Clearing is what makes "applied exactly once" survive a REMOUNT of
 * the container: its own token guard is a ref, which a remount resets (opening
 * the first file makes `FilePanelSplit` re-parent the terminal and remount the
 * container), so a request still standing at that point would be applied a
 * second time — re-opening a split the user had already closed.
 */

'use client';

import { useCallback, useRef, useState } from 'react';
import type { AgentPlacement } from '@/config/terminal-split-config';
import type { InstancePlacementRequest } from '@/components/worktree/TerminalSplitContainer';

export interface UseTerminalSplitPlacementReturn {
  /** The request to hand the container, or null when nothing is pending. */
  request: InstancePlacementRequest | null;
  /** Ask for `instanceId` to be shown; `roster-only` asks for nothing. */
  requestPlacement: (instanceId: string, placement: AgentPlacement) => void;
  /** The container applied the request with this token: forget it. */
  handleApplied: (token: number) => void;
}

export function useTerminalSplitPlacement(): UseTerminalSplitPlacementReturn {
  const [request, setRequest] = useState<InstancePlacementRequest | null>(null);
  const tokenRef = useRef(0);

  const requestPlacement = useCallback((instanceId: string, placement: AgentPlacement) => {
    if (placement === 'roster-only') return;
    tokenRef.current += 1;
    setRequest({ instanceId, placement, token: tokenRef.current });
  }, []);

  const handleApplied = useCallback((token: number) => {
    // Only the request that was applied; a newer one issued meanwhile stays.
    setRequest((prev) => (prev?.token === token ? null : prev));
  }, []);

  return { request, requestPlacement, handleApplied };
}
