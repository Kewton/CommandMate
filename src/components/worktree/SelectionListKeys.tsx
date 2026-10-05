'use client';

/**
 * SelectionListKeys — the controls a selection list gets, on every surface
 * (Issue #3305).
 *
 * One component, mounted in three places for the same frame:
 *
 *  - the chat surface's dialog card (`ChatSurface`, `case 'selectionList'`);
 *  - the PC split's footer (`TerminalSplitPaneContent`), terminal surface;
 *  - the phone's docked pad (`WorktreeDetailRefactored`), terminal surface.
 *
 * Before this Issue each of them chose its own controls. The card had learned
 * (Issue #2297) that claude's `/model` needs "this session only" (`s`) beside
 * "set as default" (`Enter`) and that a numbered list deserves `1`…`N`; the two
 * terminal mounts were still the bare arrow pad, so the only commit they
 * offered on `/model` was the one that rewrites `~/.claude/settings.json`.
 *
 * What is drawn is decided by `resolveSelectionListOps()` and nowhere else.
 * This file adds no rule of its own — it is the arrow pad, then whatever that
 * function returned, in the order the card has always drawn them. The three
 * places the surfaces still differ are listed in that module's header.
 *
 * ## The phone's frame (the second half of this file)
 *
 * The phone's pad is docked above the composer, outside the terminal tab, and
 * the screen it lives in does not hold the pane's frame — its own poll keeps
 * flags only. The tab does hold it (`useTerminalPanePolling`). So the tab
 * REPORTS the frame and the docked pad reads it, through a module store keyed
 * by worktree and instance — the arrangement `useSessionStartingGate` already
 * uses to share one fact between the surfaces showing one instance.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { NavigationButtons } from '@/components/worktree/NavigationButtons';
import {
  SelectionCommitKeys,
  SelectionNumberKeys,
  type SelectionKeysProps,
} from '@/components/worktree/PromptAnswerKeys';
import { OpencodeModelKeys } from '@/components/worktree/OpencodeQuickKeys';
import { PlanReviewControls } from '@/components/worktree/PlanReviewControls';
import {
  resolveSelectionListOps,
  type SelectionListSurface,
} from '@/lib/session/selection-list-ops';

export interface SelectionListKeysProps extends SelectionKeysProps {
  /**
   * The raw pane the list is on — `PaneTerminalState.output`, the frame the
   * surface itself is showing. `null` / `undefined` means "no frame in hand",
   * which draws the arrow pad alone.
   */
  frame: string | null | undefined;
  /** Which surface this mount is on. See `resolveSelectionListOps`. */
  surface: SelectionListSurface;
  /**
   * Issue #1017: the frame is a pager. Appends PgUp/PgDn/Home/End/q to the pad
   * and draws nothing under it — a pager's rows are a transcript, not options.
   */
  showPagerKeys?: boolean;
  /**
   * A reason to leave `Enter` off the pad that the CALLER read, on top of what
   * the frame says here. The phone's screen passes its own poll's plan-review
   * reading (Issue #2809), which also covers the tabs where no frame reaches
   * this component.
   */
  hideEnterKey?: boolean;
}

export function SelectionListKeys({
  worktreeId,
  cliToolId,
  instanceId,
  onKeysSent,
  frame,
  surface,
  showPagerKeys = false,
  hideEnterKey = false,
}: SelectionListKeysProps) {
  const ops = useMemo(
    () => resolveSelectionListOps({ frame, cliToolId, surface, pager: showPagerKeys }),
    [frame, cliToolId, surface, showPagerKeys],
  );
  const keyProps = { worktreeId, cliToolId, instanceId, onKeysSent };

  return (
    <div className="space-y-2">
      {/* The arrow pad stays FIRST and unconditional — it is the one control
          every measured selection list answers to. */}
      <NavigationButtons
        {...keyProps}
        showPagerKeys={showPagerKeys}
        hideEnterKey={hideEnterKey || !ops.padEnter}
      />
      {ops.numberKeyCount > 0 ? (
        <SelectionNumberKeys {...keyProps} optionCount={ops.numberKeyCount} />
      ) : null}
      {ops.commitKeys ? (
        <SelectionCommitKeys
          {...keyProps}
          commitsDefaultOnEnter={ops.commitKeys.commitsDefaultOnEnter}
        />
      ) : null}
      {/* Issue #3139: comment / Submit review / Approve (confirmed) / Cancel
          through `/prompt-response`'s `planReviewAction`. */}
      {ops.planReview ? <PlanReviewControls {...keyProps} /> : null}
      {/* opencode has no numbered `/model` at all — switching models is
          `ctrl+t` or a `ctrl+x` chord. Rendered for opencode, and for OpenCode
          V2 while the frame shows one of its dialogs (#2983); the component
          decides. */}
      {ops.opencodeModelKeys ? <OpencodeModelKeys {...keyProps} frame={frame} /> : null}
    </div>
  );
}

// ===========================================================================
// The phone's seam: the terminal tab reports its frame to the docked pad
// ===========================================================================

/** The pane a frame belongs to, or a docked pad is aimed at. */
export interface SelectionListFrameTarget {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Defaults to the primary instance (`=== cliToolId`) on both sides. */
  instanceId?: string;
}

/**
 * `${worktreeId}:${instanceId}` → the frame that pane's selection list is on.
 *
 * Plain module scope, like `useSessionStartingGate`'s store: both ends are
 * client components of one page. The `globalThis` rule in module-reference is
 * for state shared between SERVER request handlers, whose bundles are split.
 */
const reportedFrames = new Map<string, string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function frameKey({ worktreeId, cliToolId, instanceId }: SelectionListFrameTarget): string {
  return `${worktreeId}:${instanceId ?? cliToolId}`;
}

function setReportedFrame(key: string, frame: string | null): void {
  if (frame === null) {
    if (!reportedFrames.delete(key)) return;
  } else {
    if (reportedFrames.get(key) === frame) return;
    reportedFrames.set(key, frame);
  }
  for (const listener of listeners) listener();
}

/**
 * Report the frame this pane's selection list is on, for the screen's docked
 * pad. `frame: null` reports nothing — the caller passes it whenever its OWN
 * snapshot is not a selection list, so a frame is never offered for a reading
 * its own flags do not back.
 *
 * The entry is dropped on unmount and when the target changes, so the store
 * never holds a frame from a tab that has left the screen or from the previous
 * instance — and a pad with no entry draws the arrow pad alone.
 */
export function useReportSelectionListFrame({
  frame,
  ...target
}: SelectionListFrameTarget & { frame: string | null }): void {
  const key = frameKey(target);
  useEffect(() => {
    setReportedFrame(key, frame);
  }, [key, frame]);
  useEffect(() => () => setReportedFrame(key, null), [key]);
}

/**
 * The frame reported for `target`, or `null` when none has been — no terminal
 * tab on screen, or a tab whose pane is not on a selection list.
 */
export function useReportedSelectionListFrame(target: SelectionListFrameTarget): string | null {
  const key = frameKey(target);
  return useSyncExternalStore(
    subscribe,
    () => reportedFrames.get(key) ?? null,
    () => null,
  );
}
