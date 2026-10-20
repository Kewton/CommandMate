/**
 * TerminalSplitContainer's per-split handlers (focus, instance change,
 * maximize, drop), moved out of it (Issue #3603).
 */

'use client';

import { useMemo } from 'react';
import { getInstanceLabel, type AgentInstance } from '@/lib/cli-tools/types';
import type { ShowToast } from '@/types/markdown-editor';
import type { UseTerminalSplitsReturn } from '@/hooks/useTerminalSplits';

export type UsePerSplitHandlersArgs = Pick<
  UseTerminalSplitsReturn,
  'splits' | 'setFocusedSplitIndex' | 'setSplitInstance' | 'toggleMaximize'
> & {
  instanceById: Map<string, AgentInstance>;
  showToast?: ShowToast;
  onActiveInstanceChange?: (instanceId: string) => void;
};

export function usePerSplitHandlers({
  splits,
  instanceById,
  setFocusedSplitIndex,
  setSplitInstance,
  toggleMaximize,
  showToast,
  onActiveInstanceChange,
}: UsePerSplitHandlersArgs) {
  // Memoize per-split onFocus handlers so prop identity is stable.
  const focusHandlers = useMemo(
    () => splits.map((_, idx) => () => setFocusedSplitIndex(idx)),
    [splits, setFocusedSplitIndex],
  );

  const instanceChangeHandlers = useMemo(
    () =>
      splits.map((_, idx) => (instanceId: string) => setSplitInstance(idx, instanceId)),
    [splits, setSplitInstance],
  );

  // Issue #2261: per-split maximize toggles, memoized for the same reason the
  // focus / drop handlers are — they cross `renderPane` into memoized panes.
  const maximizeHandlers = useMemo(
    () => splits.map((_, idx) => () => toggleMaximize(idx)),
    [splits, toggleMaximize],
  );

  /**
   * Issue #786 / #869: per-split drop handlers (drop validation owner / D-1).
   *
   * The container holds the `splits` array, so it is the single place that can
   * classify a drop and resolve a colliding split's index N:
   *   - no-op   (split already shows this instance)        → nothing, no toast
   *   - reject  (another split already uses this instance) → warning toast
   *             "X is already in use by split N" (1-based N), no change
   *   - apply   (instance unused)                          → setSplitInstance;
   *             only when it returns true do we fire the success toast +
   *             onActiveInstanceChange (single source of truth / S3-005)
   *
   * Stable per-index references (useMemo) so passing them through renderPane
   * does not destabilize the parent's memoized panes (D-3).
   */
  const dropHandlers = useMemo(
    () =>
      splits.map((_, idx) => (instanceId: string) => {
        const label = getInstanceLabel(
          instanceById.get(instanceId) ?? { cliTool: 'claude', alias: instanceId },
        );
        // no-op: the drop target split already shows this instance.
        if (splits[idx]?.instanceId === instanceId) return;
        // reject: another split already uses this instance (S1-002).
        const collidingIdx = splits.findIndex(
          (s, i) => i !== idx && s.instanceId === instanceId,
        );
        if (collidingIdx !== -1) {
          showToast?.(
            `${label} is already in use by split ${collidingIdx + 1}`,
            'warning',
          );
          return;
        }
        // apply: setSplitInstance returns whether the change was actually applied.
        const applied = setSplitInstance(idx, instanceId);
        if (applied) {
          // Issue #3593: the split dropped on becomes the selected one, so the
          // header's current session (the selected split's) is the session
          // just dropped — the same instance the active one now follows.
          setFocusedSplitIndex(idx);
          onActiveInstanceChange?.(instanceId);
          showToast?.(`Moved ${label} to Split ${idx + 1}`, 'success');
        }
      }),
    [splits, setSplitInstance, setFocusedSplitIndex, showToast, onActiveInstanceChange, instanceById],
  );

  return { focusHandlers, instanceChangeHandlers, maximizeHandlers, dropHandlers };
}
