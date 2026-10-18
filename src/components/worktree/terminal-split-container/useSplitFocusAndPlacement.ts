/**
 * TerminalSplitContainer's focus / selection / placement effects, moved out of
 * it in their original order (Issue #3603).
 */

'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import type { AgentInstance } from '@/lib/cli-tools/types';
import type { UseTerminalSplitsReturn } from '@/hooks/useTerminalSplits';
import type { InstancePlacementRequest, SelectedSplit } from './types';

export interface UseSplitFocusAndPlacementArgs
  extends Pick<
    UseTerminalSplitsReturn,
    | 'splits'
    | 'focusedSplitIndex'
    | 'setFocusedSplitIndex'
    | 'setSplitInstance'
    | 'openInstanceInNewSplit'
  > {
  instances: AgentInstance[];
  containerRef: RefObject<HTMLDivElement | null>;
  onFocusedSplitChange?: (idx: number) => void;
  onActiveInstanceChange?: (instanceId: string) => void;
  headerInstanceSelection?: { instanceId: string; token: number } | null;
  instancePlacementRequest?: InstancePlacementRequest | null;
  onInstancePlacementApplied?: (token: number) => void;
  onSplitCountChange?: (count: number) => void;
  onSelectedSplitChange?: (selection: SelectedSplit) => void;
}

export function useSplitFocusAndPlacement({
  splits,
  focusedSplitIndex,
  setFocusedSplitIndex,
  setSplitInstance,
  openInstanceInNewSplit,
  instances,
  containerRef,
  onFocusedSplitChange,
  onActiveInstanceChange,
  headerInstanceSelection,
  instancePlacementRequest,
  onInstancePlacementApplied,
  onSplitCountChange,
  onSelectedSplitChange,
}: UseSplitFocusAndPlacementArgs): void {
  // Track which splitIndex was last added so we can move focus into its pane.
  const prevSplitCountRef = useRef(splits.length);
  const [lastAddedIndex, setLastAddedIndex] = useState<number | null>(null);
  useEffect(() => {
    if (splits.length > prevSplitCountRef.current) {
      setLastAddedIndex(splits.length - 1);
    }
    prevSplitCountRef.current = splits.length;
  }, [splits.length]);

  // Notify parent when focus changes (HistoryPane / MemoPane insertion target).
  useEffect(() => {
    onFocusedSplitChange?.(focusedSplitIndex);
  }, [focusedSplitIndex, onFocusedSplitChange]);

  /**
   * Issue #1152: apply a header-initiated instance selection to the selected
   * split (Issue #3593; split 0 before), wiring the header instance switcher to the terminal that actually
   * polls output / sends messages. Gated on `token` (not the instanceId) so it
   * runs exactly once per header click and never fires on mount, roster
   * reconcile, localStorage restore, the split 0→active mirror, or a drop — all
   * of which mutate the shared `activeInstanceId` but must NOT reassign a split.
   *
   * `splits` is intentionally omitted from the deps: only a NEW token should
   * trigger this. The classification reads the latest `splits` through a ref so a
   * stale closure cannot mis-target the split.
   */
  const lastHeaderTokenRef = useRef(0);
  const splitsRef = useRef(splits);
  splitsRef.current = splits;
  const focusedSplitIndexRef = useRef(focusedSplitIndex);
  focusedSplitIndexRef.current = focusedSplitIndex;
  useEffect(() => {
    if (!headerInstanceSelection) return;
    if (headerInstanceSelection.token === lastHeaderTokenRef.current) return;
    lastHeaderTokenRef.current = headerInstanceSelection.token;
    const { instanceId } = headerInstanceSelection;
    const current = splitsRef.current;
    // Issue #3593: the selected split, not split 0 — the header's current
    // session is the one the selected split shows, so that is where a session
    // picked in the header goes.
    const targetIdx = Math.min(focusedSplitIndexRef.current, current.length - 1);
    const shownIdx = current.findIndex((s) => s.instanceId === instanceId);
    if (shownIdx === targetIdx) return; // the selected split already shows it — no-op
    if (shownIdx !== -1) {
      // Collision (S1-002): the instance already occupies another split. Surface
      // that split (focus-move) instead of duplicating/reassigning it.
      setFocusedSplitIndex(shownIdx);
      return;
    }
    // Not shown anywhere → bind it to the selected split, and keep it selected.
    if (setSplitInstance(targetIdx, instanceId)) {
      setFocusedSplitIndex(targetIdx);
    }
  }, [headerInstanceSelection, setSplitInstance, setFocusedSplitIndex]);

  // Issue #3593: publish the selected split. Keyed on the values, so a new
  // `splits` array with the same instances does not re-publish.
  const selectedSplitKey = `${focusedSplitIndex}|${splits.map((s) => s.instanceId).join(',')}`;
  useEffect(() => {
    if (!onSelectedSplitChange) return;
    const current = splitsRef.current;
    if (current.length === 0) return;
    const index = Math.min(focusedSplitIndexRef.current, current.length - 1);
    onSelectedSplitChange({
      index,
      instanceId: current[index].instanceId,
      splitInstanceIds: current.map((s) => s.instanceId),
    });
  }, [selectedSplitKey, onSelectedSplitChange]);

  /**
   * Issue #3514: place an agent added from the header's "+".
   *
   * Waits for the roster: the request and the PATCHed roster are set in the
   * same handler, but a request whose instance is not in `instances` yet is
   * kept (not consumed) and retried when the roster changes, so it can never
   * be lost to ordering. A `new-split` takes focus through the same
   * "last added" path the layout icons use; a `replace` focuses the split it
   * replaced. Either way the active instance follows, as it does on a drop.
   */
  const lastPlacementTokenRef = useRef(0);
  useEffect(() => {
    if (!instancePlacementRequest) return;
    if (instancePlacementRequest.token === lastPlacementTokenRef.current) return;
    const { instanceId, placement } = instancePlacementRequest;
    if (!instances.some((inst) => inst.id === instanceId)) return; // roster not here yet
    const { token } = instancePlacementRequest;
    lastPlacementTokenRef.current = token;
    const current = splitsRef.current;
    const shownIdx = current.findIndex((s) => s.instanceId === instanceId);
    if (shownIdx !== -1) {
      setFocusedSplitIndex(shownIdx);
    } else if (placement === 'new-split' && openInstanceInNewSplit(instanceId)) {
      onActiveInstanceChange?.(instanceId);
    } else {
      // `replace`, or a `new-split` that found no room: the focused split.
      const targetIdx = Math.min(focusedSplitIndex, current.length - 1);
      if (setSplitInstance(targetIdx, instanceId)) {
        setFocusedSplitIndex(targetIdx);
        onActiveInstanceChange?.(instanceId);
      }
    }
    // Handled either way: the parent drops it so a remount cannot re-apply it.
    onInstancePlacementApplied?.(token);
  }, [
    instancePlacementRequest,
    instances,
    focusedSplitIndex,
    openInstanceInNewSplit,
    setSplitInstance,
    setFocusedSplitIndex,
    onActiveInstanceChange,
    onInstancePlacementApplied,
  ]);

  // Issue #3514: the header "+" disables `new-split` at the ceiling.
  useEffect(() => {
    onSplitCountChange?.(splits.length);
  }, [splits.length, onSplitCountChange]);

  // After lastAddedIndex changes, focus the textarea in that pane.
  useEffect(() => {
    if (lastAddedIndex === null) return;
    const container = containerRef.current;
    if (!container) return;
    const pane = container.querySelector<HTMLElement>(
      `[data-split-index="${lastAddedIndex}"]`,
    );
    if (!pane) return;
    const textarea = pane.querySelector<HTMLTextAreaElement>('textarea');
    textarea?.focus();
    // Update focusedSplitIndex too.
    setFocusedSplitIndex(lastAddedIndex);
    setLastAddedIndex(null);
  }, [lastAddedIndex, setFocusedSplitIndex, containerRef]);
}
