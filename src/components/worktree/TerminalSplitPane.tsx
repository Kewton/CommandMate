/**
 * TerminalSplitPane Component (Issue #728, instance-keyed in Issue #869)
 *
 * Single split within `TerminalSplitContainer`. Renders:
 *  - Header: agent-instance selector (with "other-split-uses" excluded) +
 *    terminal-search button (Issue #47).
 *  - Body: caller-supplied terminal content (TerminalDisplay).
 *  - Footer: caller-supplied navigation / prompt / message input.
 *
 * Issue #869: the split is identified by an agent `instanceId` (so two
 * instances of the same CLI tool can each occupy a split). The selector lists
 * the worktree's instances by their alias (`getInstanceLabel`); switching the
 * selector swaps the instance backing this split.
 *
 * `role="region"` + `aria-label="Terminal split N"` for a11y. The pane is
 * intentionally presentational: state ownership lives in the parent.
 */

'use client';

import React, { memo, useCallback, useState } from 'react';
import {
  getInstanceLabel,
  type AgentInstance,
  type CLIToolType,
} from '@/lib/cli-tools/types';

/**
 * Issue #786 / #869: dedicated MIME so the drag payload never collides with
 * file/text drags. The payload carries the agent `instanceId` (Issue #869,
 * previously a bare CLI tool id).
 */
export const AGENT_INSTANCE_DND_MIME = 'application/x-commandmate-agent-instance';

export interface TerminalSplitPaneProps {
  worktreeId: string;
  splitIndex: number;
  /** CLI tool backing this split (derived from the instance; used for labels). */
  cliToolId: CLIToolType;
  /** Issue #869: the agent instance id backing this split (tab/split identity). */
  instanceId: string;
  /** Issue #869: the resolved instance for alias display (may be undefined if stale). */
  instance?: AgentInstance;
  /**
   * Issue #869: instances selectable for this split. Already excludes instances
   * used by other splits, and always includes this split's own instance.
   */
  availableInstances: AgentInstance[];
  /** Called when the instance selector picks a different instance. */
  onInstanceChange: (instanceId: string) => void;
  /** Called when the textarea (or any input) inside this pane gains focus. */
  onFocus: () => void;
  /** Whether tmux attach is in progress for this split. */
  attaching?: boolean;
  /** Rendered above the instance selector — usually empty (`null`). */
  headerExtras?: React.ReactNode;
  /** Terminal output area (TerminalDisplay). */
  terminal: React.ReactNode;
  /** Navigation buttons + PromptPanel + MessageInput. */
  footer: React.ReactNode;
  /** Optional inline width (flex-grow ratio). When omitted, parent controls layout. */
  style?: React.CSSProperties;
  /**
   * Issue #786 / #869: called when an agent instance is dropped on this split.
   * The container (drop validation owner) decides no-op / reject / apply.
   * Optional — when omitted, drag-drop is inert (backward compat, D-4).
   */
  onDropInstance?: (instanceId: string) => void;
  /**
   * Issue #786 / #869 (D-2): the instanceId currently being dragged, published
   * by the drag source via shared state. Used ONLY to drive the dragOver
   * allowed/forbidden ring, since `dataTransfer.getData()` is unreadable during
   * dragover in real browsers (readable only on drop). `undefined`/`null` when
   * nothing is being dragged.
   */
  draggedInstanceId?: string | null;
}

export const TerminalSplitPane = memo(function TerminalSplitPane({
  splitIndex,
  cliToolId,
  instanceId,
  instance,
  availableInstances,
  onInstanceChange,
  onFocus,
  attaching = false,
  headerExtras,
  terminal,
  footer,
  style,
  onDropInstance,
  draggedInstanceId,
}: TerminalSplitPaneProps) {
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
      e.dataTransfer.dropEffect = classification === 'forbidden' ? 'none' : 'move';
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
    [dropEnabled, onDropInstance],
  );

  const dragRingClass =
    dragOverState === 'allowed'
      ? ' ring-2 ring-cyan-400'
      : dragOverState === 'forbidden'
        ? ' ring-2 ring-red-300 cursor-not-allowed'
        : '';

  const handleSelectorChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onInstanceChange(e.target.value);
    },
    [onInstanceChange],
  );

  const handleSearchClick = useCallback(() => {
    // Issue #47: dispatch terminal-wide search-open event; TerminalDisplay listens.
    window.dispatchEvent(new CustomEvent('terminal-search-open'));
  }, []);

  // Bubble-up focus from anywhere inside (textarea, terminal click).
  // We use onFocusCapture so we don't depend on individual children calling onFocus.
  const handleFocusCapture = useCallback(() => {
    onFocus();
  }, [onFocus]);

  const splitLabel = `Terminal split ${splitIndex + 1}`;
  // Alias-first label for the attach skeleton (falls back to the CLI tool name).
  const attachLabel = getInstanceLabel(instance ?? { cliTool: cliToolId });

  return (
    <div
      role="region"
      aria-label={splitLabel}
      data-testid={`terminal-split-pane-${splitIndex}`}
      data-split-index={splitIndex}
      style={style}
      className={`flex flex-col min-w-0 h-full bg-white dark:bg-gray-900${dragRingClass}`}
      onFocusCapture={handleFocusCapture}
      onMouseDown={onFocus}
      // Issue #786: drop target handlers. Separate event system from
      // onMouseDown(onFocus)/onFocusCapture, so they do not compete (S3-007).
      // No-ops when dropEnabled is false (drop props omitted).
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Header: instance selector + search button */}
      <div className="px-2 py-1 flex items-center gap-2 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <label className="sr-only" htmlFor={`cli-selector-${splitIndex}`}>
          {`Select agent instance for ${splitLabel}`}
        </label>
        <select
          id={`cli-selector-${splitIndex}`}
          value={instanceId}
          onChange={handleSelectorChange}
          data-testid={`cli-selector-${splitIndex}`}
          aria-label={`Select agent instance for ${splitLabel}`}
          className="text-xs bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded px-1.5 py-0.5"
        >
          {availableInstances.map(inst => (
            <option key={inst.id} value={inst.id}>
              {getInstanceLabel(inst)}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={handleSearchClick}
          aria-label={`Search terminal output for ${splitLabel}`}
          data-testid={`terminal-search-button-${splitIndex}`}
          className="ml-auto flex items-center gap-1 px-1.5 py-0.5 text-xs text-gray-500 hover:text-gray-800 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-3 w-3"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </button>
        {headerExtras}
      </div>

      {/* Body: terminal display (or attach skeleton) */}
      <div className="flex-1 min-h-0 relative">
        {attaching ? (
          <div
            data-testid={`terminal-attach-skeleton-${splitIndex}`}
            className="absolute inset-0 flex items-center justify-center text-xs text-gray-500 dark:text-gray-400 bg-gray-50/80 dark:bg-gray-800/80"
            role="status"
            aria-live="polite"
          >
            Attaching {attachLabel} session...
          </div>
        ) : null}
        {terminal}
      </div>

      {/* Footer: navigation + prompt + message input */}
      <div className="flex-shrink-0 border-t border-gray-200 dark:border-gray-700 p-2 bg-gray-50 dark:bg-gray-800">
        {footer}
      </div>
    </div>
  );
});

export default TerminalSplitPane;
