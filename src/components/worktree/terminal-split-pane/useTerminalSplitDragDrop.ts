/**
 * Issue #786 / #869: drop-target state and handlers of a split (drag ring classes included).
 */

'use client';

import React, { useCallback, useState } from 'react';
import type { AgentInstance } from '@/lib/cli-tools/types';

export function useSplitDragDrop(
  onDropInstance: ((instanceId: string) => void) | undefined,
  draggedInstanceId: string | null | undefined,
  availableInstances: AgentInstance[],
  AGENT_INSTANCE_DND_MIME: string,
) {
  // Issue #786: drag-over hover state lives LOCAL to this pane (D-3) so a hover
  // change never re-creates the parent's renderSplitPane / terminalSplitRegion
  // memo (which would re-render every split). null = no drag over this pane.
  const [dragOverState, setDragOverState] = useState<'allowed' | 'forbidden' | null>(null);

  // Whether drag-drop is active for this pane (the parent wired a handler).
  const dropEnabled = onDropInstance != null;

  // Classify the in-flight drag against THIS split using the published
  // instanceId (D-2). Forbidden when the dragged instance is used by another
  // split (i.e. not in availableInstances, which is the complement of
  // other-split instances and always includes this split's own current one).
  // Dropping this split's own current instance is a harmless no-op handled by
  // the container, so it is treated as 'allowed' for the ring.
  const classifyDrag = useCallback((): 'allowed' | 'forbidden' => {
    if (draggedInstanceId == null) return 'allowed';
    return availableInstances.some(inst => inst.id === draggedInstanceId)
      ? 'allowed'
      : 'forbidden';
  }, [draggedInstanceId, availableInstances]);

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!dropEnabled) return;
      // preventDefault marks this element as a valid drop target.
      e.preventDefault();
      const classification = classifyDrag();
      // Issue #3593: 'move' even for a forbidden drag. A real browser fires no
      // `drop` once `dropEffect` is 'none', so the container's refusal toast
      // ("X is already in use by split N") could never show; the red ring
      // still says "not here" while hovering, and the drop is refused.
      e.dataTransfer.dropEffect = 'move';
      setDragOverState(prev => (prev === classification ? prev : classification));
    },
    [dropEnabled, classifyDrag],
  );

  const handleDragEnter = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!dropEnabled) return;
      e.preventDefault();
      const classification = classifyDrag();
      setDragOverState(prev => (prev === classification ? prev : classification));
    },
    [dropEnabled, classifyDrag],
  );

  const handleDragLeave = useCallback(() => {
    if (!dropEnabled) return;
    setDragOverState(null);
  }, [dropEnabled]);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!dropEnabled) return;
      e.preventDefault();
      setDragOverState(null);
      // D-2: getData is readable here (on drop) in real browsers.
      const droppedId = e.dataTransfer.getData(AGENT_INSTANCE_DND_MIME);
      if (!droppedId) return;
      onDropInstance?.(droppedId);
    },
    [dropEnabled, onDropInstance, AGENT_INSTANCE_DND_MIME],
  );

  const dragRingClass =
    dragOverState === 'allowed'
      ? ' ring-2 ring-accent-400'
      : dragOverState === 'forbidden'
        ? ' ring-2 ring-red-300 cursor-not-allowed'
        : '';

  // Issue #1079: the subtle focus ring and the drag-over ring share the same
  // `ring` box-shadow. `focus-within:` is a pseudo-class (higher specificity),
  // so it would override the more prominent 2px drag ring when a focused pane is
  // also the drop target. Suppress the focus ring while a drag is over this pane
  // so the drop affordance always wins.
  const focusRingClass =
    dragOverState === null ? ' focus-within:ring-1 focus-within:ring-accent-500/30' : '';
  return {
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDrop,
    dragRingClass,
    focusRingClass,
  };
}
