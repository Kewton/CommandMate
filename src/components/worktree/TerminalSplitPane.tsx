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
import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  getInstanceLabel,
  type AgentInstance,
  type CLIToolType,
} from '@/lib/cli-tools/types';
import { StatusDot, type StatusDotStatus } from '@/components/ui/StatusDot';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';

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
  /**
   * Issue #1079: this split's derived agent status, shown as a `StatusDot` in
   * the instance-selector trigger (the session title bar). `BranchStatus` is a
   * subset of `StatusDotStatus`, so callers can pass their derived status
   * directly. Defaults to `idle`.
   */
  status?: StatusDotStatus;
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
  status = 'idle',
  onFocus,
  attaching = false,
  headerExtras,
  terminal,
  footer,
  style,
  onDropInstance,
  draggedInstanceId,
}: TerminalSplitPaneProps) {
  const t = useTranslations('worktree');
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
  // Alias-first label for the selector trigger + attach skeleton (falls back to
  // the CLI tool name when the instance is stale/undefined).
  const attachLabel = getInstanceLabel(instance ?? { cliTool: cliToolId });
  const selectInstanceLabel = t('terminal.selectInstance', { split: splitLabel });

  return (
    <div
      role="region"
      aria-label={splitLabel}
      data-testid={`terminal-split-pane-${splitIndex}`}
      data-split-index={splitIndex}
      style={style}
      // Issue #1079: the pane is a card (rounded, clipped, hairline border).
      // Focus is expressed subtly via `focus-within` (a soft accent ring) instead
      // of the old flashy full-perimeter accent border.
      className={`flex flex-col min-w-0 h-full rounded-lg overflow-hidden border border-border bg-surface${focusRingClass}${dragRingClass}`}
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
      {/* Header: session title bar — instance selector (status + alias) + search */}
      <div className="px-2 py-1 flex items-center gap-2 bg-surface-2 border-b border-border flex-shrink-0">
        {/* Issue #1079: native <select> → Radix DropdownMenu. The trigger reads as
            a session title (StatusDot + alias + chevron); the radio group keeps
            the same single-select value/onChange semantics as the old <select>. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            data-testid={`cli-selector-${splitIndex}`}
            aria-label={selectInstanceLabel}
            className="flex items-center gap-1.5 min-w-0 max-w-[12rem] rounded px-1.5 py-0.5 text-xs border border-border bg-surface text-surface-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:ring-2 data-[state=open]:ring-ring transition-colors"
          >
            <StatusDot
              status={status}
              size="sm"
              aria-hidden
              data-testid={`split-status-indicator-${splitIndex}`}
            />
            <span className="truncate">{attachLabel}</span>
            <ChevronDown size={14} aria-hidden="true" className="flex-shrink-0 opacity-70" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[10rem]">
            <DropdownMenuRadioGroup value={instanceId} onValueChange={onInstanceChange}>
              {availableInstances.map(inst => (
                <DropdownMenuRadioItem key={inst.id} value={inst.id}>
                  {getInstanceLabel(inst)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          type="button"
          onClick={handleSearchClick}
          aria-label={`Search terminal output for ${splitLabel}`}
          data-testid={`terminal-search-button-${splitIndex}`}
          className="ml-auto flex items-center gap-1 px-1.5 py-0.5 text-xs text-muted-foreground hover:text-surface-foreground hover:bg-muted-foreground/10 rounded transition-colors"
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
            className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground bg-surface-2/80"
            role="status"
            aria-live="polite"
          >
            Attaching {attachLabel} session...
          </div>
        ) : null}
        {terminal}
      </div>

      {/* Footer: navigation + prompt + message input */}
      <div className="flex-shrink-0 border-t border-border p-2 bg-surface-2">
        {footer}
      </div>
    </div>
  );
});

export default TerminalSplitPane;
